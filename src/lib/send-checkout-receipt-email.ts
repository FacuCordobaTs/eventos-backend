import { and, asc, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import QRCode from "qrcode"
import * as React from "react"
import { Resend } from "resend"
import {
  digitalConsumptions,
  events,
  products,
  ticketTypes,
  tickets,
} from "../db/schema"
import { TicketEmail } from "../emails/TicketEmail"

type Db = ReturnType<typeof drizzle>

type CheckoutContact = {
  name: string
  email: string
}

type EmailItem = {
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
  db: Db
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

  const [evRow] = await db
    .select({ name: events.name })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1)
  const eventName = evRow?.name ?? "Evento"

  const ticketRows = await db
    .select({
      id: tickets.id,
      qrHash: tickets.qrHash,
      ticketTypeName: ticketTypes.name,
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

  const baseUrl = (process.env.FRONTEND_URL ?? "https://totem.uno").replace(
    /\/$/,
    ""
  )
  const receiptUrl = `${baseUrl}/receipt/${receiptToken}`

  const emailItems: EmailItem[] = []

  for (const row of ticketRows) {
    if (row.qrHash == null || row.qrHash === "") continue
    const qrBuffer = await QRCode.toBuffer(row.qrHash, {
      type: "png",
      width: 512,
      margin: 2,
      color: { dark: "#000000ff", light: "#ffffffff" },
    })
    emailItems.push({
      id: row.id,
      name: `Entrada · ${row.ticketTypeName}`,
      qrBuffer,
    })
  }

  for (const row of consumptionRows) {
    if (row.qrHash == null || row.qrHash === "") continue
    const qrBuffer = await QRCode.toBuffer(row.qrHash, {
      type: "png",
      width: 512,
      margin: 2,
      color: { dark: "#000000ff", light: "#ffffffff" },
    })
    emailItems.push({
      id: row.id,
      name: `Consumo · ${row.productName}`,
      qrBuffer,
    })
  }

  const ticketCount = ticketRows.filter(
    (r) => r.qrHash != null && r.qrHash !== ""
  ).length

  const resend = new Resend(apiKey)
  const subject = receiptEmailSubject(eventName, ticketCount)

  const itemsForReact = emailItems.map((i) => ({ id: i.id, name: i.name }))

  const attachments =
    emailItems.length > 0
      ? emailItems.map((item) => ({
          filename: `${item.id}.png`,
          content: item.qrBuffer,
          contentId: item.id,
        }))
      : undefined

  const { error } = await resend.emails.send({
    from: "Totem <entradas@totem.uno>",
    to: contact.email.trim(),
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
}
