import { and, asc, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import { toBuffer } from "qrcode"
import * as React from "react"
import { Resend } from "resend"
import {
  digitalConsumptions,
  events,
  products,
  ticketTypes,
  tickets,
  transportTickets,
  saleTransports,
  sales,
} from "../db/schema"
import { TicketEmail } from "../emails/TicketEmail"
import { formatAdmissionWindow } from "./ticket-admission"


type CheckoutContact = {
  name: string
  email: string
}

type EmailItem = {
  admissionWindow?: string | null
  id: string
  name: string
  qrBuffer: Buffer
}

function receiptEmailSubject(eventName: string, ticketCount: number): string {
  if (ticketCount === 0) {
    return `Tu comprobante para ${eventName}`
  }
  if (ticketCount === 1) {
    return `Tu entrada para ${eventName}`
  }
  return `Tus entradas para ${eventName}`
}

/**
 * Sends the guest receipt email via Resend (QR PNGs inline via CID attachments).
 * Throws on failure — callers should catch and log; do not block HTTP responses on this.
 */
export async function sendGuestCheckoutReceiptEmail(input: {
  db: any
  eventId: string
  saleId: string
  receiptToken: string
  contact: CheckoutContact
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey?.trim()) {
    console.warn(
      "[checkout-email] RESEND_API_KEY is not set; skipping receipt email"
    )
    return
  }

  const { db, eventId, saleId, receiptToken, contact } = input

  // La tienda pública pide sólo nombre y DNI: sin email real no hay a quién enviarle el
  // comprobante. Los clientes creados desde la caja usan un email sintético `@crow.local`.
  const to = contact.email.trim()
  if (to === "" || to.endsWith("@crow.local")) {
    console.warn("[checkout-email] contacto sin email; skipping receipt email")
    return
  }

  const [evRow] = await db
    .select({ name: events.name, tenantId: events.tenantId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1)
  const eventName = evRow?.name ?? "Evento"

  const ticketRows = await db
    .select({
      id: tickets.id,
      qrHash: tickets.qrHash,
      ticketTypeName: ticketTypes.name,
      validFrom: ticketTypes.validFrom,
      validUntil: ticketTypes.validUntil,
    })
    .from(tickets)
    .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
    .where(and(eq(tickets.saleId, saleId), eq(tickets.eventId, eventId)))
    .orderBy(asc(tickets.createdAt))

  const consumptionRows = await db
    .select({
      id: digitalConsumptions.id,
      qrHash: digitalConsumptions.qrHash,
      productName: products.name,
    })
    .from(digitalConsumptions)
    .innerJoin(products, eq(digitalConsumptions.productId, products.id))
    .where(
      and(
        eq(digitalConsumptions.saleId, saleId),
        eq(digitalConsumptions.eventId, eventId)
      )
    )
    .orderBy(asc(digitalConsumptions.createdAt))

  const transportRows = await db.select({ id: transportTickets.id, qrHash: transportTickets.qrHash, name: saleTransports.name, address: saleTransports.address })
    .from(transportTickets).innerJoin(saleTransports, eq(saleTransports.id, transportTickets.bookingId)).innerJoin(sales, eq(sales.id, saleTransports.saleId))
    .where(and(eq(sales.id, saleId), eq(sales.eventId, eventId), eq(transportTickets.tenantId, evRow?.tenantId ?? ""), eq(transportTickets.customerId, sales.customerId), eq(transportTickets.status, "PENDING"), eq(sales.status, "COMPLETED")))

  const baseUrl = (process.env.FRONTEND_URL ?? "https://crow.ar").replace(
    /\/$/,
    ""
  )
  const receiptUrl = `${baseUrl}/receipt/${receiptToken}`

  const emailItems: EmailItem[] = []

  for (const row of ticketRows) {
    if (row.qrHash == null || row.qrHash === "") continue
    const qrBuffer = await toBuffer(row.qrHash, {
      type: "png",
      // 740 px = 37 módulos (29 de datos + 4 de quiet zone por lado) × 20 px. `TicketEmail.tsx`
      // lo pinta a 200 px CSS, que en un teléfono DPR 3 son 600 px reales: 740 cubre eso sin
      // que el cliente de correo tenga que interpolar la imagen.
      width: 740,
      margin: 4,
      color: { dark: "#000000ff", light: "#ffffffff" },
    })
    emailItems.push({
      id: row.id,
      name: `Entrada · ${row.ticketTypeName}`,
      admissionWindow: formatAdmissionWindow(row),
      qrBuffer,
    })
  }

  for (const row of consumptionRows) {
    if (row.qrHash == null || row.qrHash === "") continue
    const qrBuffer = await toBuffer(row.qrHash, {
      type: "png",
      width: 740,
      margin: 4,
      color: { dark: "#000000ff", light: "#ffffffff" },
    })
    emailItems.push({
      id: row.id,
      name: `Consumo · ${row.productName}`,
      qrBuffer,
    })
  }

  const ticketCount = ticketRows.filter(
    (r: any) => r.qrHash != null && r.qrHash !== ""
  ).length

  for (const row of transportRows) emailItems.push({ id: row.id, name: `Colectivo · ${row.name} · ${row.address}`, qrBuffer: await toBuffer(row.qrHash, { type: "png", width: 740, margin: 4 }) })

  const resend = new Resend(apiKey)
  const subject = receiptEmailSubject(eventName, ticketCount)

  const itemsForReact = emailItems.map((i) => ({ id: i.id, name: i.name, admissionWindow: i.admissionWindow }))

  const attachments =
    emailItems.length > 0
      ? emailItems.map((item) => ({
          filename: `${item.id}.png`,
          content: item.qrBuffer,
          contentId: item.id,
        }))
      : undefined

  const { error } = await resend.emails.send({
    from: "Crow <entradas@crow.ar>",
    to,
    subject,
    react: React.createElement(TicketEmail, {
      userName: contact.name.trim(),
      eventName,
      receiptUrl,
      items: itemsForReact,
    }),
    attachments,
  })

  if (error) {
    throw new Error(error.message)
  }

  if (evRow?.tenantId != null && evRow.tenantId !== "") {
    await db
      .update(tickets)
      .set({ emailSentAt: new Date() })
      .where(
        and(
          eq(tickets.saleId, saleId),
          eq(tickets.eventId, eventId),
          eq(tickets.tenantId, evRow.tenantId)
        )
      )
  }
}

/** QR snapshot after a committed transfer; delivery never grants access to the customer's account. */
export async function sendTransportQrEmail(input: { email: string; name: string; eventName: string; linkUrl: string; pass: { id: string; name: string; address: string; qrHash: string } }) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey?.trim()) return
  const qr = await toBuffer(input.pass.qrHash, { type: "png", width: 740, margin: 4 })
  const { error } = await new Resend(apiKey).emails.send({
    from: "Crow <entradas@crow.ar>", to: input.email, subject: `Tu pasaje de colectivo para ${input.eventName}`,
    react: React.createElement(TicketEmail, { userName: input.name, eventName: input.eventName, receiptUrl: input.linkUrl, items: [{ id: input.pass.id, name: `Colectivo · ${input.pass.name} · ${input.pass.address}` }] }),
    attachments: [{ filename: `${input.pass.id}.png`, content: qr, contentId: input.pass.id }]
  })
  if (error) throw new Error(error.message)
}

/**
 * Sends a single ticket QR by email (staff-triggered or manual sale follow-up).
 * Enforces tenant scope on the ticket query. Throws on Resend failure or missing config.
 */
export async function sendManualTicketQrEmail(input: {
  db: any
  ticketId: string
  tenantId: string
  /**
   * A dónde lleva el botón del mail. Por defecto la home del client; la entrada reclamada de un
   * amigo apunta al acceso del evento, donde entra con su DNI o celular.
   */
  linkUrl?: string
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey?.trim()) {
    throw new Error("El envío de email no está configurado (RESEND_API_KEY).")
  }

  const { db, ticketId, tenantId } = input

  const [row] = await db
    .select({
      id: tickets.id,
      qrHash: tickets.qrHash,
      buyerName: tickets.buyerName,
      buyerEmail: tickets.buyerEmail,
      eventName: events.name,
      ticketTypeName: ticketTypes.name,
      validFrom: ticketTypes.validFrom,
      validUntil: ticketTypes.validUntil,
    })
    .from(tickets)
    .innerJoin(events, eq(tickets.eventId, events.id))
    .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
    .where(
      and(
        eq(tickets.id, ticketId),
        eq(tickets.tenantId, tenantId),
        eq(events.tenantId, tenantId),
        eq(ticketTypes.tenantId, tenantId)
      )
    )
    .limit(1)

  if (!row) {
    throw new Error("Entrada no encontrada")
  }

  const email = row.buyerEmail?.trim()
  if (!email) {
    throw new Error("No email associated with this ticket")
  }

  if (row.qrHash == null || row.qrHash === "") {
    throw new Error("Entrada sin código QR")
  }

  const qrBuffer = await toBuffer(row.qrHash, {
    type: "png",
    width: 740,
    margin: 4,
    color: { dark: "#000000ff", light: "#ffffffff" },
  })

  const baseUrl = (process.env.FRONTEND_URL ?? "https://crow.ar").replace(
    /\/$/,
    ""
  )
  const receiptUrl = input.linkUrl ?? baseUrl

  const itemName = `Entrada · ${row.ticketTypeName}`
  const resend = new Resend(apiKey)
  const subject = `Tu entrada para ${row.eventName}`

  const { error } = await resend.emails.send({
    from: "Crow <entradas@crow.ar>",
    to: email,
    subject,
    react: React.createElement(TicketEmail, {
      userName: (row.buyerName ?? "Asistente").trim(),
      eventName: row.eventName,
      receiptUrl,
      items: [{ id: row.id, name: itemName, admissionWindow: formatAdmissionWindow(row) }],
    }),
    attachments: [
      {
        filename: `${row.id}.png`,
        content: qrBuffer,
        contentId: row.id,
      },
    ],
  })

  if (error) {
    throw new Error(error.message)
  }
}
