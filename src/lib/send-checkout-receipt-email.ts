import { and, asc, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import QRCode from "qrcode"
import * as React from "react"
import { Resend } from "resend"
import { digitalConsumptions, events, tickets } from "../db/schema"
import { TicketEmail } from "../emails/TicketEmail"

type Db = ReturnType<typeof drizzle>

type CheckoutContact = {
  name: string
  email: string
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
 * Sends the guest receipt email via Resend (QR PNGs as attachments).
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
    .select({ qrHash: tickets.qrHash })
    .from(tickets)
    .where(and(eq(tickets.saleId, saleId), eq(tickets.eventId, eventId)))
    .orderBy(asc(tickets.createdAt))

  const consumptionRows = await db
    .select({ qrHash: digitalConsumptions.qrHash })
    .from(digitalConsumptions)
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

  const attachments: { filename: string; content: Buffer }[] = []

  const ticketHashes = ticketRows
    .map((r) => r.qrHash)
    .filter((h): h is string => h != null && h !== "")

  for (let i = 0; i < ticketHashes.length; i++) {
    const buf = await QRCode.toBuffer(ticketHashes[i], {
      type: "png",
      width: 512,
      margin: 2,
      color: { dark: "#000000ff", light: "#ffffffff" },
    })
    const filename =
      ticketHashes.length === 1 ? "acceso-qr.png" : `acceso-qr-${i + 1}.png`
    attachments.push({ filename, content: buf })
  }

  const consHashes = consumptionRows
    .map((r) => r.qrHash)
    .filter((h): h is string => h != null && h !== "")

  for (let i = 0; i < consHashes.length; i++) {
    const buf = await QRCode.toBuffer(consHashes[i], {
      type: "png",
      width: 512,
      margin: 2,
      color: { dark: "#000000ff", light: "#ffffffff" },
    })
    const filename =
      consHashes.length === 1 ? "consumo-qr.png" : `consumo-qr-${i + 1}.png`
    attachments.push({ filename, content: buf })
  }

  const resend = new Resend(apiKey)
  const subject = receiptEmailSubject(eventName, ticketHashes.length)

  const { error } = await resend.emails.send({
    from: "Totem <entradas@totem.uno>",
    to: contact.email.trim(),
    subject,
    react: React.createElement(TicketEmail, {
      userName: contact.name.trim(),
      eventName,
      receiptUrl,
    }),
    attachments: attachments.length > 0 ? attachments : undefined,
  })

  if (error) {
    throw new Error(error.message)
  }
}
