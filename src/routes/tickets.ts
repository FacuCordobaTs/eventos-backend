import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { tickets } from "../db/schema"
import { and, eq } from "drizzle-orm"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import {
  executeTicketPurchase,
  PurchaseError,
  purchaseErrorStatus,
} from "../lib/ticket-purchase"
import { qrCodeDataUrl } from "../lib/qr"

const sellTicketSchema = z.object({
  eventId: z.string().min(1),
  ticketTypeId: z.string().min(1),
  buyerName: z.string().min(1).max(255),
  buyerEmail: z.string().email(),
})

function requireTenantId(ctx: AuthenticatedContext): string | null {
  const id = ctx.staff.tenantId
  if (id == null || id === "") return null
  return id
}

export const ticketsRoute = new Hono()
  .post("/sell", authMiddleware, zValidator("json", sellTicketSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const body = c.req.valid("json")
    const db = drizzle(pool)

    try {
      const result = await db.transaction(async (tx) =>
        executeTicketPurchase(tx, {
          eventId: body.eventId,
          ticketTypeId: body.ticketTypeId,
          buyerName: body.buyerName,
          buyerEmail: body.buyerEmail,
          enforceTenantId: tenantId,
        })
      )

      return c.json(
        {
          message: "Venta simulada completada",
          ticket: result.ticket,
          ticketTypeName: result.ticketTypeName,
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
  .get("/:id/qr", authMiddleware, async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }

    const ticketId = c.req.param("id")
    const db = drizzle(pool)

    const [row] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
      .limit(1)

    if (!row) {
      return c.json({ error: "Entrada no encontrada" }, 404)
    }

    const qrDataUrl = await qrCodeDataUrl(row.qrHash)

    return c.json({
      qrDataUrl,
      qrHash: row.qrHash,
    })
  })
