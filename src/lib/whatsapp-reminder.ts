/**
 * Recordatorio de WhatsApp de un evento: cuándo sale, a quién le llega y con qué link.
 *
 * Lo comparten el runner de jobs (`jobs-runner.ts`, que lo manda) y la pantalla "Mensajes" de la
 * sección Entradas del admin (`GET/PATCH /events/:id/whatsapp-reminder`, que lo muestra y lo
 * configura). Vive acá para que la vista previa y el envío real no puedan divergir: "sale ya" en la
 * pantalla es exactamente lo que el runner considera pendiente, y las personas que se cuentan son
 * las que se mandan.
 *
 * Hora de referencia: `doorsAt` y, si el evento no la tiene, `date`. `doorsAt` no tiene escritura en
 * la API ni en el admin (sólo se puede cargar por SQL), así que en la práctica la referencia es la
 * fecha y hora del evento. El mensaje sale entre `referencia − adelanto` y la referencia, una sola
 * vez: la marca `events.whatsappReminderSentAt` impide repetirlo.
 */

import { and, eq, ne } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import { customers, tickets, type events } from "../db/schema"
import type { EventStatus } from "./event-status"
import {
  isWhatsAppConfigured,
  normalizeWhatsAppPhone,
  REMINDER_BODY_PREVIEW,
  REMINDER_BUTTON_LABEL,
  REMINDER_TEMPLATE,
  REMINDER_URL_BASE,
} from "./whatsapp-service"

type Db = MySql2Database<Record<string, never>>

/** Adelanto original del runner: una hora antes. */
export const REMINDER_LEAD_DEFAULT_MINUTES = 60
/** Piso: el runner pasa cada minuto; un adelanto menor podría no encontrar nunca su ventana. */
export const REMINDER_LEAD_MIN_MINUTES = 5
/** Techo: una semana antes; más allá deja de ser un recordatorio. */
export const REMINDER_LEAD_MAX_MINUTES = 7 * 24 * 60

/** Columnas del evento que deciden si el recordatorio sale y cuándo. */
export type ReminderEventRow = {
  status: EventStatus
  date: Date
  doorsAt: Date | null
  whatsappReminderEnabled: boolean
  whatsappReminderLeadMinutes: number
  whatsappReminderSentAt: Date | null
}

export type ReminderReferenceSource = "doorsAt" | "date"

/** Hora del evento a la que se le resta el adelanto: `doorsAt`, o `date` si no hay hora de puertas. */
export function reminderReference(event: Pick<ReminderEventRow, "doorsAt" | "date">): {
  at: Date
  source: ReminderReferenceSource
} {
  return event.doorsAt
    ? { at: event.doorsAt, source: "doorsAt" }
    : { at: event.date, source: "date" }
}

export function reminderSendAt(referenceAt: Date, leadMinutes: number): Date {
  return new Date(referenceAt.getTime() - leadMinutes * 60_000)
}

/**
 * Qué le pasa al recordatorio ahora mismo. El orden de las preguntas es el de la precedencia:
 *
 * - `SENT`: ya salió; no se repite.
 * - `EVENT_CLOSED`: el evento cerró; no hay más recordatorios.
 * - `DISABLED`: el administrador lo apagó.
 * - `MISSED`: la hora del evento ya pasó y no salió; no sale más.
 * - `WAITING_SALE`: el evento sigue en borrador; sale recién cuando se abra la venta (si todavía
 *   falta para el evento).
 * - `SENDING`: dentro de la ventana de envío; sale en el próximo minuto del runner.
 * - `SCHEDULED`: todavía no llegó la hora de envío.
 */
export type ReminderState =
  | "SENT"
  | "EVENT_CLOSED"
  | "DISABLED"
  | "MISSED"
  | "WAITING_SALE"
  | "SENDING"
  | "SCHEDULED"

export function reminderSchedule(
  event: ReminderEventRow,
  now: Date
): {
  reference: { at: Date; source: ReminderReferenceSource }
  sendAt: Date
  state: ReminderState
} {
  const reference = reminderReference(event)
  const sendAt = reminderSendAt(reference.at, event.whatsappReminderLeadMinutes)
  return { reference, sendAt, state: stateOf(event, reference.at, sendAt, now) }
}

function stateOf(
  event: ReminderEventRow,
  referenceAt: Date,
  sendAt: Date,
  now: Date
): ReminderState {
  if (event.whatsappReminderSentAt) return "SENT"
  if (event.status === "closed") return "EVENT_CLOSED"
  if (!event.whatsappReminderEnabled) return "DISABLED"
  if (now.getTime() >= referenceAt.getTime()) return "MISSED"
  if (event.status === "draft") return "WAITING_SALE"
  if (now.getTime() >= sendAt.getTime()) return "SENDING"
  return "SCHEDULED"
}

/** Link del botón "Ir al evento": lo que completa `{{1}}` de la URL del template y la URL entera. */
export function reminderLink(event: { slug: string | null; id: string }): {
  parameter: string
  url: string
} {
  const parameter = encodeURIComponent(event.slug ?? event.id)
  return { parameter, url: `${REMINDER_URL_BASE}${parameter}` }
}

export type ReminderRecipient = { customerId: string; name: string; phone: string }

export type ReminderAudience = {
  /** Una persona = un mensaje, aunque tenga varias entradas del evento. */
  recipients: ReminderRecipient[]
  /** Personas con entrada vigente a las que no se les puede escribir: sin celular usable. */
  withoutPhone: number
}

/**
 * A quién le sale el recordatorio de un evento: los clientes con al menos una entrada no anulada.
 * Es la única fuente de esa lista: el runner la manda y la pantalla la cuenta.
 */
export async function listReminderAudience(
  db: Db,
  event: { id: string; tenantId: string }
): Promise<ReminderAudience> {
  const rows = await db
    .selectDistinct({
      customerId: customers.id,
      name: customers.name,
      phone: customers.phone,
    })
    .from(tickets)
    .innerJoin(customers, eq(tickets.customerId, customers.id))
    .where(
      and(
        eq(tickets.eventId, event.id),
        eq(tickets.tenantId, event.tenantId),
        ne(tickets.status, "CANCELLED")
      )
    )

  const seen = new Set<string>()
  const recipients: ReminderRecipient[] = []
  let withoutPhone = 0
  for (const row of rows) {
    if (seen.has(row.customerId)) continue
    seen.add(row.customerId)
    if (row.phone && normalizeWhatsAppPhone(row.phone) !== null) {
      recipients.push({ customerId: row.customerId, name: row.name, phone: row.phone })
    } else {
      withoutPhone += 1
    }
  }
  return { recipients, withoutPhone }
}

/** Lo que la pantalla necesita para mostrar el mensaje: plantilla, cuerpo, botón y link. */
export function describeReminderMessage(event: {
  id: string
  slug: string | null
  name: string
}) {
  return {
    template: REMINDER_TEMPLATE,
    /** Cuerpo de referencia con `{{1}}` (nombre de la persona) y `{{2}}` (nombre del evento). */
    bodyTemplate: REMINDER_BODY_PREVIEW,
    eventName: event.name,
    buttonLabel: REMINDER_BUTTON_LABEL,
    url: reminderLink(event).url,
  }
}

/** Respuesta de `GET/PATCH /events/:id/whatsapp-reminder`. Los instantes viajan como ISO 8601. */
export type ReminderOverview = {
  enabled: boolean
  leadMinutes: number
  leadLimits: { min: number; max: number }
  /** `false` = el WhatsApp de la plataforma no está configurado: aunque esté activado, no sale nada. */
  whatsappAvailable: boolean
  state: ReminderState
  sentAt: string | null
  reference: { at: string; source: ReminderReferenceSource }
  sendAt: string
  audience: { recipients: number; withoutPhone: number }
  message: ReturnType<typeof describeReminderMessage>
}

export async function buildReminderOverview(
  db: Db,
  event: typeof events.$inferSelect,
  now: Date = new Date()
): Promise<ReminderOverview> {
  const { reference, sendAt, state } = reminderSchedule(event, now)
  const audience = await listReminderAudience(db, event)
  return {
    enabled: event.whatsappReminderEnabled,
    leadMinutes: event.whatsappReminderLeadMinutes,
    leadLimits: { min: REMINDER_LEAD_MIN_MINUTES, max: REMINDER_LEAD_MAX_MINUTES },
    whatsappAvailable: isWhatsAppConfigured(),
    state,
    sentAt: event.whatsappReminderSentAt ? event.whatsappReminderSentAt.toISOString() : null,
    reference: { at: reference.at.toISOString(), source: reference.source },
    sendAt: sendAt.toISOString(),
    audience: { recipients: audience.recipients.length, withoutPhone: audience.withoutPhone },
    message: describeReminderMessage(event),
  }
}
