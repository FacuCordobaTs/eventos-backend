import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { events, ticketTypes, tickets } from "../db/schema"
import { and, count, eq, ne } from "drizzle-orm"
import {
  executeTicketPurchase,
  PurchaseError,
  purchaseErrorStatus,
} from "../lib/ticket-purchase"
import { qrCodeDataUrl, ticketValidationUrl } from "../lib/qr"

const purchaseSchema = z.object({
  eventId: z.string().min(1),
  ticketTypeId: z.string().min(1),
  buyerName: z.string().min(1).max(255),
  buyerEmail: z.string().email(),
})

async function countIssued(
  db: ReturnType<typeof drizzle>,
  tenantId: string,
  ticketTypeId: string
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(tickets)
    .where(
      and(
        eq(tickets.tenantId, tenantId),
        eq(tickets.ticketTypeId, ticketTypeId),
        ne(tickets.status, "CANCELLED")
      )
    )
  return Number(row?.n ?? 0)
}

export const publicRoute = new Hono()
  .get("/events/:id", async (c) => {
    const eventId = c.req.param("id")
    const db = drizzle(pool)

    const [ev] = await db.select().from(events).where(eq(events.id, eventId)).limit(1)
    if (!ev || ev.isActive === false) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const types = await db
      .select()
      .from(ticketTypes)
      .where(
        and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.tenantId, ev.tenantId))
      )

    const ticketTypesOut = []
    for (const t of types) {
      const sold = await countIssued(db, ev.tenantId, t.id)
      const limit = t.stockLimit
      const remaining = limit == null ? null : Math.max(0, limit - sold)
      ticketTypesOut.push({
        id: t.id,
        name: t.name,
        price: t.price,
        stockLimit: t.stockLimit,
        sold,
        remaining,
        availableForPurchase: limit == null || sold < limit,
      })
    }

    return c.json({
      event: {
        id: ev.id,
        name: ev.name,
        date: ev.date,
        location: ev.location,
      },
      ticketTypes: ticketTypesOut,
    })
  })
  .post("/tickets/purchase", zValidator("json", purchaseSchema), async (c) => {
    const body = c.req.valid("json")
    const db = drizzle(pool)

    try {
      const result = await db.transaction(async (tx) =>
        executeTicketPurchase(tx, {
          eventId: body.eventId,
          ticketTypeId: body.ticketTypeId,
          buyerName: body.buyerName.trim(),
          buyerEmail: body.buyerEmail.trim(),
        })
      )

      const validationUrl = ticketValidationUrl(result.ticket.qrHash)
      const qrDataUrl = await qrCodeDataUrl(validationUrl)

      return c.json(
        {
          message: "Compra exitosa",
          ticket: {
            id: result.ticket.id,
            qrHash: result.ticket.qrHash,
            status: result.ticket.status,
            buyerName: result.ticket.buyerName,
            buyerEmail: result.ticket.buyerEmail,
            ticketTypeName: result.ticketTypeName,
          },
          validationUrl,
          qrDataUrl,
          payment: { status: "completed" as const, method: "mock" as const },
        },
        201
      )
    } catch (e) {
      if (e instanceof PurchaseError) {
        const { status, body: errBody } = purchaseErrorStatus(e.code)
        return c.json(errBody, status)
      }
      throw e
    }
  })
