import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { events, ticketTypes, tickets } from "../db/schema"
import { and, count, eq, ne } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { randomUUID } from "node:crypto"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"

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

export const ticketsSellRoute = new Hono()
  .use("*", authMiddleware)
  .post("/sell", zValidator("json", sellTicketSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const body = c.req.valid("json")
    const db = drizzle(pool)

    try {
      const result = await db.transaction(async (tx) => {
        const [ev] = await tx
          .select()
          .from(events)
          .where(and(eq(events.id, body.eventId), eq(events.tenantId, tenantId)))
          .limit(1)
        if (!ev) {
          throw new Error("EVENT_NOT_FOUND")
        }

        const [tt] = await tx
          .select()
          .from(ticketTypes)
          .where(
            and(
              eq(ticketTypes.id, body.ticketTypeId),
              eq(ticketTypes.tenantId, tenantId),
              eq(ticketTypes.eventId, body.eventId)
            )
          )
          .limit(1)
        if (!tt) {
          throw new Error("TICKET_TYPE_NOT_FOUND")
        }

        const [soldRow] = await tx
          .select({ n: count() })
          .from(tickets)
          .where(
            and(
              eq(tickets.tenantId, tenantId),
              eq(tickets.ticketTypeId, body.ticketTypeId),
              ne(tickets.status, "CANCELLED")
            )
          )
        const sold = Number(soldRow?.n ?? 0)
        const limit = tt.stockLimit
        if (limit != null && sold >= limit) {
          throw new Error("OUT_OF_STOCK")
        }

        const ticketId = uuidv4()
        const qrHash = randomUUID()

        await tx.insert(tickets).values({
          id: ticketId,
          ticketTypeId: body.ticketTypeId,
          eventId: body.eventId,
          tenantId,
          qrHash,
          status: "PENDING",
          buyerName: body.buyerName,
          buyerEmail: body.buyerEmail,
          createdAt: new Date(),
        })

        const [row] = await tx
          .select()
          .from(tickets)
          .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
          .limit(1)

        return {
          ticket: row,
          ticketTypeName: tt.name,
          payment: { status: "completed" as const, method: "mock" as const },
        }
      })

      return c.json(
        {
          message: "Venta simulada completada",
          ...result,
        },
        201
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : ""
      if (msg === "EVENT_NOT_FOUND") {
        return c.json({ error: "Evento no encontrado" }, 404)
      }
      if (msg === "TICKET_TYPE_NOT_FOUND") {
        return c.json({ error: "Tipo de entrada no encontrado" }, 404)
      }
      if (msg === "OUT_OF_STOCK") {
        return c.json({ error: "Sin stock disponible para este tipo de entrada" }, 409)
      }
      throw e
    }
  })
