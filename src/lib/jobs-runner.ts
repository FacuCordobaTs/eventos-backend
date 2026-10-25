/** Recordatorios de WhatsApp por horario y configuración del evento, sin ciclo de estados.
 * La marca persistida de envío evita repetir lotes después de reiniciar el servicio. */

import { and, eq, gt, isNull, or } from "drizzle-orm"
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

  // Candidatos: con el recordatorio activado, sin enviar y con la hora del
  // evento todavía por delante (`doorsAt`, o `date` si no hay hora de puertas). Si la hora de envío
  // ya llegó depende del adelanto de cada evento, así que eso se decide después, con la misma
  // función que usa la pantalla "Mensajes" para mostrar el estado.
  const candidates = await db
    .select({
      id: events.id,
      tenantId: events.tenantId,
      name: events.name,
      slug: events.slug,
      date: events.date,
      doorsAt: events.doorsAt,
      whatsappReminderEnabled: events.whatsappReminderEnabled,
      whatsappReminderLeadMinutes: events.whatsappReminderLeadMinutes,
      whatsappReminderSentAt: events.whatsappReminderSentAt,
    })
    .from(events)
    .where(
      and(
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

/** Un tick del runner. Un error no impide reintentar en el próximo minuto. */
export async function runJobsTick(): Promise<void> {
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
