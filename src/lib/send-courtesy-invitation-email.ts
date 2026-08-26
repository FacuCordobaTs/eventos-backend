import { and, eq, inArray } from "drizzle-orm"
import * as React from "react"
import { Resend } from "resend"
import {
  courtesies,
  type CourtesyDrinkLine,
  events,
  products,
  staff,
  ticketTypes,
} from "../db/schema"
import { InvitationEmail } from "../emails/InvitationEmail"

/**
 * Tarea 7.3 — Envía la invitación (diseño de invitación) al email del invitado.
 * Se usa al crear la cortesía con `guestEmail` y desde el botón "Enviar" del panel.
 * Throws con mensaje en español: los callers deciden si bloquear la respuesta o loguear.
 * Al mandarse bien, deja `courtesies.invite_sent_at` seteado (estado del envío en el panel).
 */
export async function sendCourtesyInvitationEmail(input: {
  db: any
  courtesyId: string
  tenantId: string
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey?.trim()) {
    throw new Error("El envío de email no está configurado (RESEND_API_KEY).")
  }

  const { db, courtesyId, tenantId } = input

  const [courtesy] = await db
    .select()
    .from(courtesies)
    .where(and(eq(courtesies.id, courtesyId), eq(courtesies.tenantId, tenantId)))
    .limit(1)
  if (!courtesy) {
    throw new Error("Cortesía no encontrada")
  }
  if (courtesy.status === "REVOKED") {
    throw new Error("No se puede enviar una invitación anulada")
  }

  const email = courtesy.guestEmail?.trim()
  if (!email) {
    throw new Error("La invitación no tiene un correo para enviar")
  }

  const [event] = await db
    .select({ name: events.name })
    .from(events)
    .where(eq(events.id, courtesy.eventId))
    .limit(1)
  const eventName = event?.name ?? "Evento"

  const [ticketType] = await db
    .select({ name: ticketTypes.name })
    .from(ticketTypes)
    .where(eq(ticketTypes.id, courtesy.ticketTypeId))
    .limit(1)
  const ticketTypeName = ticketType?.name ?? "Entrada"

  // Nombre del staff que armó la invitación ("quién invitó a quién").
  let hostedByName: string | undefined
  if (courtesy.createdBy) {
    const [creator] = await db
      .select({ name: staff.name })
      .from(staff)
      .where(eq(staff.id, courtesy.createdBy))
      .limit(1)
    hostedByName = creator?.name
  }

  // Nombres de los tragos de regalo para el diseño de invitación.
  const drinkLines: CourtesyDrinkLine[] = Array.isArray(courtesy.drinkLines)
    ? courtesy.drinkLines
    : []
  let drinkNameLines: { name: string; quantity: number }[] = []
  if (drinkLines.length > 0) {
    const drinkIds = [...new Set(drinkLines.map((l) => l.productId))]
    const rows = (await db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(inArray(products.id, drinkIds))) as { id: string; name: string }[]
    const nameById = new Map(rows.map((r) => [r.id, r.name]))
    drinkNameLines = drinkLines.map((l) => ({
      name: nameById.get(l.productId) ?? "Trago",
      quantity: l.quantity,
    }))
  }

  const baseUrl = (process.env.FRONTEND_URL ?? "https://crow.ar").replace(
    /\/$/,
    ""
  )
  const invitationUrl = `${baseUrl}/i/${courtesy.token}`

  const resend = new Resend(apiKey)
  const { error } = await resend.emails.send({
    from: "Crow <entradas@crow.ar>",
    to: email,
    subject: `Tenés tu invitación para ${eventName}`,
    react: React.createElement(InvitationEmail, {
      guestName: courtesy.guestName,
      eventName,
      invitationUrl,
      ticketTypeName,
      drinkLines: drinkNameLines.length > 0 ? drinkNameLines : undefined,
      hostedByName,
    }),
  })

  if (error) {
    throw new Error(error.message)
  }

  await db
    .update(courtesies)
    .set({ inviteSentAt: new Date() })
    .where(and(eq(courtesies.id, courtesyId), eq(courtesies.tenantId, tenantId)))
}
