/**
 * Tarea 8.2 — Runner de jobs de fondo (visión §2.3, plan §4 Fase 8).
 *
 * El backend no tenía ningún job (cero setInterval/cron): este es el primero. Corre en el
 * mismo proceso (setInterval en `index.ts`, ver `startJobsRunner`) y guarda TODO su estado
 * en DB — idempotente por columna, no en memoria — para que un restart del servicio nunca
 * re-envíe un mensaje ni re-transicione dos veces.
 *
 * Cada minuto:
 *   (a) Recordatorio de WhatsApp — eventos `on_sale|live` con `doorsAt` en la próxima hora
 *       y `whatsapp_reminder_sent_at` null (y tenant con WhatsApp conectado): manda el
 *       template aprobado (`crow_recordatorio`: nombre y evento en el cuerpo + botón URL)
 *       a todos los customers
 *       con tickets del evento, UNA vez por persona, y setea la columna.
 *   (b) Transición on_sale → live — eventos con `doorsAt <= now` pasan solos a En vivo,
 *       sellando `wentLiveAt` (la misma marca que sella el POST /events/:id/transition).
 *       Antes era lazy-only (el admin la disparaba al abrir/refrescar); ahora el backend
 *       la garantiza.
 *
 * Política de errores: cada lote va en su propio try/catch y cada evento en el suyo; un
 * fallo (p. ej. Meta rechaza un número) no tira abajo el resto del tick. La columna se
 * setea tras intentar el lote completo: el job es fire-once y los fallos quedan en el log
 * del servicio.
 */

import { and, eq, gt, inArray, isNotNull, isNull, lte, ne } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { customers, events, tenants, tickets } from "../db/schema"
import { REMINDER_TEMPLATE, sendWhatsAppTemplateMessage } from "./whatsapp-service"

/** Ventana previa a la puerta en la que se manda el recordatorio (visión §2.3: 1 h antes). */
const REMINDER_WINDOW_MS = 60 * 60 * 1000

/** Cadencia del runner: un tick por minuto (el plan exige el chequeo cada minuto). */
const TICK_INTERVAL_MS = 60 * 1000

/**
 * Parte dinámica del CTA del template. En Meta el botón se configura como
 * `https://crow.ar/{{1}}`; la API recibe únicamente la slug (o id) que completa esa URL.
 */
function eventShopUrlParameter(event: { slug: string | null; id: string }): string {
  return encodeURIComponent(event.slug ?? event.id)
}

/** (b) Eventos on_sale cuya hora de puertas ya llegó → pasan a live, sellando wentLiveAt. */
async function transitionDueEvents(): Promise<void> {
  const db = drizzle(pool)
  const now = new Date()

  const due = await db
    .select({
      id: events.id,
      name: events.name,
      doorsAt: events.doorsAt,
      wentLiveAt: events.wentLiveAt,
    })
    .from(events)
    .where(
      and(eq(events.status, "on_sale"), isNotNull(events.doorsAt), lte(events.doorsAt, now))
    )

  for (const event of due) {
    // Misma semántica que el POST /events/:id/transition manual: sella went_live_at solo
    // si no estaba sellado. `isActive` se retiró en la tarea 11.3 — el estado vive en `status`.
    await db
      .update(events)
      .set({
        status: "live",
        wentLiveAt: event.wentLiveAt ?? now,
      })
      .where(eq(events.id, event.id))
    console.log(
      `[jobs] ${event.name} on_sale → live (puertas ${event.doorsAt?.toISOString()})`
    )
  }
}

/** (a) Recordatorio de WhatsApp 1 h antes a los compradores de eventos con puertas próximas. */
async function sendWhatsAppReminders(): Promise<void> {
  const db = drizzle(pool)
  const now = new Date()
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS)

  const dueEvents = await db
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      doorsAt: events.doorsAt,
      whatsappPhoneNumberId: tenants.whatsappPhoneNumberId,
      whatsappToken: tenants.whatsappToken,
      whatsappTemplateName: tenants.whatsappTemplateName,
    })
    .from(events)
    .innerJoin(tenants, eq(events.tenantId, tenants.id))
    .where(
      and(
        inArray(events.status, ["on_sale", "live"]),
        isNotNull(events.doorsAt),
        gt(events.doorsAt, now),
        lte(events.doorsAt, windowEnd),
        isNull(events.whatsappReminderSentAt),
        eq(tenants.whatsappEnabled, true),
        isNotNull(tenants.whatsappToken),
        isNotNull(tenants.whatsappPhoneNumberId)
      )
    )

  for (const event of dueEvents) {
    try {
      const buyers = await db
        .select({
          customerId: customers.id,
          name: customers.name,
          phone: customers.phone,
        })
        .from(tickets)
        .innerJoin(customers, eq(tickets.customerId, customers.id))
        .where(
          and(
            eq(tickets.eventId, event.id),
            ne(tickets.status, "CANCELLED"),
            isNotNull(customers.phone)
          )
        )

      // Una persona = un mensaje, aunque haya comprado varias entradas del evento.
      const seen = new Set<string>()
      const recipients = buyers.filter((b) => {
        const key = b.customerId
        if (!b.phone || seen.has(key)) return false
        seen.add(key)
        return true
      })

      const urlButtonParameter = eventShopUrlParameter(event)
      const templateName = event.whatsappTemplateName?.trim() || REMINDER_TEMPLATE
      let sent = 0
      for (const recipient of recipients) {
        const result = await sendWhatsAppTemplateMessage({
          token: event.whatsappToken!,
          phoneNumberId: event.whatsappPhoneNumberId!,
          to: recipient.phone!,
          templateName,
          // `crow_recordatorio`: dos variables en el cuerpo y un CTA dinámico separado.
          // El link no se inserta como texto visible dentro del mensaje.
          bodyParameters: [recipient.name, event.name],
          urlButton: { parameter: urlButtonParameter },
        })
        if (result.ok) {
          sent++
        } else {
          console.error(
            `[jobs] WhatsApp recordatorio ${event.name}: falló para ${recipient.phone} (${result.error})`
          )
        }
      }

      // Fire-once: aunque algún envío falle, la columna se setea (idempotencia en DB);
      // los fallos individuales quedaron logueados arriba para revisar.
      await db
        .update(events)
        .set({ whatsappReminderSentAt: new Date() })
        .where(eq(events.id, event.id))
      console.log(
        `[jobs] WhatsApp recordatorio ${event.name}: ${sent}/${recipients.length} enviados (puertas ${event.doorsAt?.toISOString()})`
      )
    } catch (e) {
      console.error(`[jobs] WhatsApp recordatorio ${event.name}: error del lote`, e)
    }
  }
}

/** Un tick del runner: (b) transiciones primero (la puerta ya puede haber llegado), luego
 * (a) recordatorios. Nunca tira: el error queda logueado y el próximo tick sigue. */
export async function runJobsTick(): Promise<void> {
  try {
    await transitionDueEvents()
  } catch (e) {
    console.error("[jobs] transición on_sale → live falló", e)
  }
  try {
    await sendWhatsAppReminders()
  } catch (e) {
    console.error("[jobs] recordatorio de WhatsApp falló", e)
  }
}

/**
 * Arranca el runner dentro del proceso: un tick inmediato al boot (alcanza lo que quedó
 * pendiente mientras el servicio estuvo caído) y un setInterval de 1 minuto después.
 * `running` evita ticks superpuestos si una iteración tarda más que el intervalo.
 */
export function startJobsRunner(): void {
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      await runJobsTick()
    } finally {
      running = false
    }
  }

  void tick()
  setInterval(() => void tick(), TICK_INTERVAL_MS)
}
