import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { events, ticketTypes, tickets } from "../db/schema"
import { and, count, desc, eq, ne } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"

function requireTenantId(c: AuthenticatedContext): string | null {
  const id = c.staff.tenantId
  if (id == null || id === "") return null
  return id
}

const createEventSchema = z.object({
  name: z.string().min(1).max(255),
  date: z.string().min(1),
  location: z.string().max(255).optional(),
})

const createTicketTypeSchema = z.object({
  name: z.string().min(1).max(100),
  price: z.coerce.number().nonnegative(),
  stockLimit: z
    .union([z.coerce.number().int().positive(), z.null()])
    .optional(),
})

async function countIssuedTickets(
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

function sanitizeEvent(row: typeof events.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    date: row.date,
    location: row.location,
    isActive: row.isActive,
    createdAt: row.createdAt,
  }
}

function sanitizeTicketType(
  row: typeof ticketTypes.$inferSelect,
  sold: number
) {
  const limit = row.stockLimit
  const remaining =
    limit == null ? null : Math.max(0, limit - sold)
  return {
    id: row.id,
    eventId: row.eventId,
    tenantId: row.tenantId,
    name: row.name,
    price: row.price,
    stockLimit: row.stockLimit,
    sold,
    remaining,
  }
}

export const eventsRoute = new Hono()
  .use("*", authMiddleware)
  .get("/", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json(
        { error: "Tu cuenta no tiene tenant asignado; no se pueden listar eventos." },
        400
      )
    }
    const db = drizzle(pool)
    const rows = await db
      .select()
      .from(events)
      .where(eq(events.tenantId, tenantId))
      .orderBy(desc(events.date))
    return c.json({ events: rows.map(sanitizeEvent) })
  })
  .post("/", zValidator("json", createEventSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const body = c.req.valid("json")
    const db = drizzle(pool)
    const id = uuidv4()
    await db.insert(events).values({
      id,
      tenantId,
      name: body.name,
      date: new Date(body.date),
      location: body.location ?? null,
      isActive: true,
      createdAt: new Date(),
    })
    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, id), eq(events.tenantId, tenantId)))
    return c.json({ event: sanitizeEvent(row) }, 201)
  })
  .get("/:id/ticket-types", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const db = drizzle(pool)
    const [ev] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
      .limit(1)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }
    const types = await db
      .select()
      .from(ticketTypes)
      .where(
        and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.tenantId, tenantId))
      )
    const enriched = []
    for (const t of types) {
      const sold = await countIssuedTickets(db, tenantId, t.id)
      enriched.push(sanitizeTicketType(t, sold))
    }
    return c.json({ ticketTypes: enriched })
  })
  .post("/:id/ticket-types", zValidator("json", createTicketTypeSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const body = c.req.valid("json")
    const db = drizzle(pool)
    const [ev] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
      .limit(1)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }
    const id = uuidv4()
    const priceStr = body.price.toFixed(2)
    await db.insert(ticketTypes).values({
      id,
      eventId,
      tenantId,
      name: body.name,
      price: priceStr,
      stockLimit: body.stockLimit ?? null,
    })
    const [row] = await db
      .select()
      .from(ticketTypes)
      .where(and(eq(ticketTypes.id, id), eq(ticketTypes.tenantId, tenantId)))
    const sold = 0
    return c.json({ ticketType: sanitizeTicketType(row, sold) }, 201)
  })
  .get("/:id/tickets", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const db = drizzle(pool)
    const [ev] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
      .limit(1)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }
    const rows = await db
      .select({
        id: tickets.id,
        qrHash: tickets.qrHash,
        status: tickets.status,
        buyerName: tickets.buyerName,
        buyerEmail: tickets.buyerEmail,
        createdAt: tickets.createdAt,
        ticketTypeId: tickets.ticketTypeId,
        ticketTypeName: ticketTypes.name,
      })
      .from(tickets)
      .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
      .where(
        and(
          eq(tickets.eventId, eventId),
          eq(tickets.tenantId, tenantId),
          eq(ticketTypes.tenantId, tenantId),
          eq(ticketTypes.eventId, eventId)
        )
      )
    return c.json({
      tickets: rows.map((r) => ({
        id: r.id,
        qrHash: r.qrHash,
        status: r.status,
        buyerName: r.buyerName,
        buyerEmail: r.buyerEmail,
        createdAt: r.createdAt,
        ticketTypeId: r.ticketTypeId,
        ticketTypeName: r.ticketTypeName,
      })),
    })
  })
  .get("/:id", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const id = c.req.param("id")
    const db = drizzle(pool)
    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, id), eq(events.tenantId, tenantId)))
      .limit(1)
    if (!row) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }
    return c.json({ event: sanitizeEvent(row) })
  })
