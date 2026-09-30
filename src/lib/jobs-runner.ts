/**
 * Tarea 8.2 — Runner de jobs de fondo (visión §2.3, plan §4 Fase 8).
 *
 * El backend no tenía ningún job (cero setInterval/cron): este es el primero. Corre en el
 * mismo proceso (setInterval en `index.ts`, ver `startJobsRunner`) y guarda TODO su estado
 * en DB — idempotente por columna, no en memoria — para que un restart del servicio nunca
 * re-envíe un mensaje ni re-transicione dos veces.
 *
 * Cada minuto:
 *   (a) Recordatorio de WhatsApp — eventos `on_sale|live` con el recordatorio activado, sin enviar
 *       (`whatsapp_reminder_sent_at` null) y cuya hora de envío ya llegó (y el número de la
 *       plataforma configurado): manda el template aprobado (`crow_recordatorio`: nombre y evento
 *       en el cuerpo + botón URL) a todos los customers con tickets del evento, UNA vez por
 *       persona, y setea la columna. Activado y adelanto son configuración de cada evento (pantalla
 *       "Mensajes" del admin); la hora de envío es `doorsAt` —o `date` si no hay hora de puertas—
 *       menos el adelanto (60 min por defecto). Ver `lib/whatsapp-reminder.ts`.
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

import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { events } from "../db/schema"
import {
  isWhatsAppConfigured,
  REMINDER_TEMPLATE,
  sendWhatsAppTemplateMessage,
} from "./whatsapp-service"
import { listReminderAudience, reminderLink, reminderSchedule } from "./whatsapp-reminder"

/** Cadencia del runner: un tick por minuto (el plan exige el chequeo cada minuto). */
const TICK_INTERVAL_MS = 60 * 1000

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

/**
 * (a) Recordatorio de WhatsApp a los compradores de los eventos cuya hora de envío ya llegó.
 * Cada evento decide si sale y con cuánto adelanto (`lib/whatsapp-reminder.ts`).
 */
async function sendWhatsAppReminders(): Promise<void> {
  // Un solo número para toda la plataforma (`.env` del VPS): sin credenciales no hay a quién
  // mandarle ni con qué, así que el tick entero se saltea.
  if (!isWhatsAppConfigured()) return

  const db = drizzle(pool)
  const now = new Date()

  // Candidatos: en venta o en vivo, con el recordatorio activado, sin enviar y con la hora del
  // evento todavía por delante (`doorsAt`, o `date` si no hay hora de puertas). Si la hora de envío
  // ya llegó depende del adelanto de cada evento, así que eso se decide después, con la misma
  // función que usa la pantalla "Mensajes" para mostrar el estado.
  const candidates = await db
    .select({
      id: events.id,
      tenantId: events.tenantId,
      name: events.name,
      slug: events.slug,
      status: events.status,
      date: events.date,
      doorsAt: events.doorsAt,
      whatsappReminderEnabled: events.whatsappReminderEnabled,
      whatsappReminderLeadMinutes: events.whatsappReminderLeadMinutes,
      whatsappReminderSentAt: events.whatsappReminderSentAt,
    })
    .from(events)
    .where(
      and(
        inArray(events.status, ["on_sale", "live"]),
        eq(events.whatsappReminderEnabled, true),
        isNull(events.whatsappReminderSentAt),
        or(gt(events.doorsAt, now), and(isNull(events.doorsAt), gt(events.date, now)))
      )
    )

  const dueEvents = candidates.filter(
    (event) => reminderSchedule(event, now).state === "SENDING"
  )

  for (const event of dueEvents) {
    try {
      // Una persona = un mensaje, aunque haya comprado varias entradas del evento.
      const { recipients } = await listReminderAudience(db, event)

      const urlButtonParameter = reminderLink(event).parameter
      let sent = 0
      for (const recipient of recipients) {
        const result = await sendWhatsAppTemplateMessage({
          to: recipient.phone,
          templateName: REMINDER_TEMPLATE,
          // `crow_recordatorio`: dos variables en el cuerpo y un CTA dinámico separado.
          // El link no se inserta como texto visible dentro del mensaje.
          bodyParameters: [recipient.name, event.name],
          urlButton: { parameter: urlButtonParameter },
        })
        if (result.ok) {
          sent++
        } else {
          console.error(
            `[jobs] WhatsApp recordatorio ${event.name}: falló para el cliente ${recipient.customerId} (${result.error})`
          )
        }
      }

      // Fire-once: aunque algún envío falle, la columna se setea (idempotencia en DB);
      // los fallos individuales quedaron logueados arriba para revisar.
      await db
        .update(events)
        .set({ whatsappReminderSentAt: new Date() })
        .where(and(eq(events.id, event.id), eq(events.tenantId, event.tenantId)))
      console.log(
        `[jobs] WhatsApp recordatorio ${event.name}: ${sent}/${recipients.length} enviados (evento ${reminderSchedule(event, now).reference.at.toISOString()})`
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
