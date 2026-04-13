import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import {
  bars,
  digitalConsumptions,
  eventProducts,
  eventExpenses,
  events,
  eventStaff,
  products,
  saleItems,
  sales,
  staff,
  ticketTypes,
  tickets,
} from "../db/schema"
import { and, asc, count, desc, eq, ne, sql, sum } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { dec, decToDb } from "../lib/decimal-money"

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

const toggleEventProductSchema = z.object({
  productId: z.string().min(1).max(36),
  isActive: z.boolean(),
})

const createBarSchema = z.object({
  name: z.string().min(1).max(255),
})

const updateBarSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((b) => b.name !== undefined || b.isActive !== undefined, {
    message: "Se requiere name o isActive",
  })

const assignEventStaffSchema = z.object({
  staffId: z.string().min(1).max(36),
  isAssigned: z.boolean(),
  barId: z.union([z.string().min(1).max(36), z.null()]).optional(),
})

const expenseCategorySchema = z.enum([
  "MUSIC",
  "LIGHTS",
  "FOOD",
  "STAFF",
  "MARKETING",
  "INFRASTRUCTURE",
  "OTHER",
])

const createExpenseSchema = z.object({
  description: z.string().min(1).max(255),
  category: expenseCategorySchema,
  amount: z.union([
    z.number().finite(),
    z.string().regex(/^\d+(\.\d{1,2})?$/),
  ]),
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

async function requireEventForTenant(
  db: ReturnType<typeof drizzle>,
  eventId: string,
  tenantId: string
): Promise<typeof events.$inferSelect | null> {
  const [ev] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
    .limit(1)
  return ev ?? null
}

async function requireBarForEventTenant(
  db: ReturnType<typeof drizzle>,
  barId: string,
  eventId: string,
  tenantId: string
): Promise<typeof bars.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(bars)
    .where(
      and(
        eq(bars.id, barId),
        eq(bars.eventId, eventId),
        eq(bars.tenantId, tenantId)
      )
    )
    .limit(1)
  return row ?? null
}

function sanitizeBar(row: typeof bars.$inferSelect) {
  return {
    id: row.id,
    eventId: row.eventId,
    tenantId: row.tenantId,
    name: row.name,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function sanitizeExpense(row: typeof eventExpenses.$inferSelect) {
  return {
    id: row.id,
    eventId: row.eventId,
    tenantId: row.tenantId,
    description: row.description,
    category: row.category,
    amount: String(row.amount),
    date: row.date,
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
  .get("/:id/summary", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const db = drizzle(pool)

    const ev = await requireEventForTenant(db, eventId, tenantId)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const [ticketsRow] = await db
      .select({ n: count() })
      .from(tickets)
      .where(
        and(
          eq(tickets.eventId, eventId),
          eq(tickets.tenantId, tenantId),
          ne(tickets.status, "CANCELLED")
        )
      )

    const [revenueRow] = await db
      .select({
        total: sql<string>`coalesce(sum(cast(${sales.totalAmount} as decimal(14,2))), 0)`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.eventId, eventId),
          eq(sales.tenantId, tenantId),
          eq(sales.status, "COMPLETED")
        )
      )

    const [consumptionsRow] = await db
      .select({ n: count() })
      .from(digitalConsumptions)
      .where(
        and(
          eq(digitalConsumptions.eventId, eventId),
          eq(digitalConsumptions.tenantId, tenantId),
          ne(digitalConsumptions.status, "CANCELLED")
        )
      )

    return c.json({
      ticketsSold: Number(ticketsRow?.n ?? 0),
      totalRevenue: revenueRow?.total ?? "0.00",
      digitalConsumptionsSold: Number(consumptionsRow?.n ?? 0),
    })
  })
  .get("/:id/bar-sales", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const db = drizzle(pool)

    const ev = await requireEventForTenant(db, eventId, tenantId)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const rows = await db
      .select({
        productName: products.name,
        quantitySold: sum(saleItems.quantity),
        revenue:
          sql<string>`coalesce(sum(cast(${saleItems.quantity} as decimal(14,4)) * cast(${saleItems.priceAtTime} as decimal(14,4))), 0)`,
      })
      .from(saleItems)
      .innerJoin(sales, eq(saleItems.saleId, sales.id))
      .innerJoin(products, eq(saleItems.productId, products.id))
      .where(
        and(
          eq(sales.eventId, eventId),
          eq(sales.tenantId, tenantId),
          eq(sales.status, "COMPLETED"),
          eq(products.tenantId, tenantId)
        )
      )
      .groupBy(saleItems.productId, products.id, products.name)

    const items = rows
      .map((r) => ({
        productName: r.productName,
        quantitySold: Number(r.quantitySold ?? 0),
        revenue: String(r.revenue ?? "0"),
      }))
      .filter((r) => r.quantitySold > 0)
      .sort((a, b) => b.quantitySold - a.quantitySold)

    return c.json({ items })
  })
  .get("/:id/gate-stats", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const db = drizzle(pool)

    const ev = await requireEventForTenant(db, eventId, tenantId)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const [totalRow] = await db
      .select({ n: count() })
      .from(tickets)
      .where(
        and(
          eq(tickets.eventId, eventId),
          eq(tickets.tenantId, tenantId),
          ne(tickets.status, "CANCELLED")
        )
      )

    const [scannedRow] = await db
      .select({ n: count() })
      .from(tickets)
      .where(
        and(
          eq(tickets.eventId, eventId),
          eq(tickets.tenantId, tenantId),
          eq(tickets.status, "USED")
        )
      )

    return c.json({
      totalTickets: Number(totalRow?.n ?? 0),
      scannedTickets: Number(scannedRow?.n ?? 0),
    })
  })
  .get("/:id/products", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const db = drizzle(pool)

    const ev = await requireEventForTenant(db, eventId, tenantId)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const catalog = await db
      .select({
        id: products.id,
        name: products.name,
        price: products.price,
        catalogIsActive: products.isActive,
      })
      .from(products)
      .where(eq(products.tenantId, tenantId))
      .orderBy(asc(products.name))

    const links = await db
      .select({
        productId: eventProducts.productId,
        isActive: eventProducts.isActive,
        priceOverride: eventProducts.priceOverride,
      })
      .from(eventProducts)
      .where(
        and(
          eq(eventProducts.eventId, eventId),
          eq(eventProducts.tenantId, tenantId)
        )
      )

    const byProduct = new Map(
      links.map((r) => [
        r.productId,
        { isActive: r.isActive, priceOverride: r.priceOverride },
      ])
    )

    return c.json({
      products: catalog.map((p) => {
        const row = byProduct.get(p.id)
        return {
          id: p.id,
          name: p.name,
          price: p.price,
          catalogIsActive: p.catalogIsActive,
          isActiveForEvent: row?.isActive === true,
          priceOverride:
            row?.priceOverride === null || row?.priceOverride === undefined
              ? null
              : String(row.priceOverride),
        }
      }),
    })
  })
  .post(
    "/:id/products/toggle",
    zValidator("json", toggleEventProductSchema),
    async (c) => {
      const ctx = c as AuthenticatedContext
      const tenantId = requireTenantId(ctx)
      if (!tenantId) {
        return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
      }
      const eventId = c.req.param("id")
      const body = c.req.valid("json")
      const db = drizzle(pool)

      const ev = await requireEventForTenant(db, eventId, tenantId)
      if (!ev) {
        return c.json({ error: "Evento no encontrado" }, 404)
      }

      const [prod] = await db
        .select({ id: products.id })
        .from(products)
        .where(
          and(eq(products.id, body.productId), eq(products.tenantId, tenantId))
        )
        .limit(1)
      if (!prod) {
        return c.json({ error: "Producto no encontrado" }, 404)
      }

      const [existing] = await db
        .select()
        .from(eventProducts)
        .where(
          and(
            eq(eventProducts.eventId, eventId),
            eq(eventProducts.productId, body.productId),
            eq(eventProducts.tenantId, tenantId)
          )
        )
        .limit(1)

      if (existing) {
        await db
          .update(eventProducts)
          .set({ isActive: body.isActive })
          .where(
            and(
              eq(eventProducts.id, existing.id),
              eq(eventProducts.tenantId, tenantId)
            )
          )
        return c.json({
          ok: true,
          eventProduct: {
            id: existing.id,
            eventId,
            productId: body.productId,
            tenantId,
            isActive: body.isActive,
            priceOverride: existing.priceOverride,
          },
        })
      }

      if (!body.isActive) {
        return c.json({
          ok: true,
          eventProduct: null,
        })
      }

      const newId = uuidv4()
      await db.insert(eventProducts).values({
        id: newId,
        eventId,
        productId: body.productId,
        tenantId,
        priceOverride: null,
        isActive: true,
        createdAt: new Date(),
      })

      return c.json(
        {
          ok: true,
          eventProduct: {
            id: newId,
            eventId,
            productId: body.productId,
            tenantId,
            isActive: true,
            priceOverride: null,
          },
        },
        201
      )
    }
  )
  .get("/:id/staff", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const db = drizzle(pool)

    const ev = await requireEventForTenant(db, eventId, tenantId)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const rows = await db
      .select({
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
        isActive: staff.isActive,
        assignmentId: eventStaff.id,
        barId: eventStaff.barId,
      })
      .from(staff)
      .leftJoin(
        eventStaff,
        and(
          eq(eventStaff.staffId, staff.id),
          eq(eventStaff.eventId, eventId),
          eq(eventStaff.tenantId, tenantId)
        )
      )
      .where(and(eq(staff.tenantId, tenantId), eq(staff.isActive, true)))
      .orderBy(asc(staff.name))

    return c.json({
      staff: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        isAssigned: r.assignmentId != null,
        barId: r.barId ?? null,
      })),
    })
  })
  .post(
    "/:id/staff/assign",
    zValidator("json", assignEventStaffSchema),
    async (c) => {
      const ctx = c as AuthenticatedContext
      const tenantId = requireTenantId(ctx)
      if (!tenantId) {
        return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
      }
      const eventId = c.req.param("id")
      const body = c.req.valid("json")
      const db = drizzle(pool)

      const ev = await requireEventForTenant(db, eventId, tenantId)
      if (!ev) {
        return c.json({ error: "Evento no encontrado" }, 404)
      }

      if (!body.isAssigned) {
        await db
          .delete(eventStaff)
          .where(
            and(
              eq(eventStaff.eventId, eventId),
              eq(eventStaff.staffId, body.staffId),
              eq(eventStaff.tenantId, tenantId)
            )
          )
        return c.json({ ok: true })
      }

      const [st] = await db
        .select({ id: staff.id })
        .from(staff)
        .where(
          and(
            eq(staff.id, body.staffId),
            eq(staff.tenantId, tenantId),
            eq(staff.isActive, true)
          )
        )
        .limit(1)
      if (!st) {
        return c.json(
          { error: "Personal no encontrado o inactivo en tu Productora" },
          404
        )
      }

      let nextBarId: string | null | undefined = undefined
      if (body.barId === null) {
        nextBarId = null
      } else if (typeof body.barId === "string") {
        const bar = await requireBarForEventTenant(
          db,
          body.barId,
          eventId,
          tenantId
        )
        if (!bar) {
          return c.json({ error: "Barra no encontrada en este evento" }, 404)
        }
        if (bar.isActive === false) {
          return c.json({ error: "La barra está inactiva" }, 400)
        }
        nextBarId = body.barId
      }

      const [existing] = await db
        .select()
        .from(eventStaff)
        .where(
          and(
            eq(eventStaff.eventId, eventId),
            eq(eventStaff.staffId, body.staffId),
            eq(eventStaff.tenantId, tenantId)
          )
        )
        .limit(1)

      if (existing) {
        if (nextBarId === undefined) {
          return c.json({ ok: true })
        }
        await db
          .update(eventStaff)
          .set({ barId: nextBarId })
          .where(
            and(
              eq(eventStaff.id, existing.id),
              eq(eventStaff.tenantId, tenantId)
            )
          )
        return c.json({ ok: true })
      }

      const newId = uuidv4()
      await db.insert(eventStaff).values({
        id: newId,
        eventId,
        tenantId,
        staffId: body.staffId,
        barId: nextBarId === undefined ? null : nextBarId,
        createdAt: new Date(),
      })

      return c.json({ ok: true }, 201)
    }
  )
  .get("/:id/bars", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const db = drizzle(pool)

    const ev = await requireEventForTenant(db, eventId, tenantId)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const rows = await db
      .select()
      .from(bars)
      .where(
        and(eq(bars.eventId, eventId), eq(bars.tenantId, tenantId))
      )
      .orderBy(asc(bars.name))

    return c.json({ bars: rows.map(sanitizeBar) })
  })
  .post("/:id/bars", zValidator("json", createBarSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const ev = await requireEventForTenant(db, eventId, tenantId)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const id = uuidv4()
    await db.insert(bars).values({
      id,
      eventId,
      tenantId,
      name: body.name,
      isActive: true,
      createdAt: new Date(),
    })

    const [row] = await db
      .select()
      .from(bars)
      .where(
        and(eq(bars.id, id), eq(bars.tenantId, tenantId), eq(bars.eventId, eventId))
      )
      .limit(1)

    return c.json({ bar: row ? sanitizeBar(row) : null }, 201)
  })
  .patch(
    "/:id/bars/:barId",
    zValidator("json", updateBarSchema),
    async (c) => {
      const ctx = c as AuthenticatedContext
      const tenantId = requireTenantId(ctx)
      if (!tenantId) {
        return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
      }
      const eventId = c.req.param("id")
      const barId = c.req.param("barId")
      const body = c.req.valid("json")
      const db = drizzle(pool)

      const ev = await requireEventForTenant(db, eventId, tenantId)
      if (!ev) {
        return c.json({ error: "Evento no encontrado" }, 404)
      }

      const existing = await requireBarForEventTenant(db, barId, eventId, tenantId)
      if (!existing) {
        return c.json({ error: "Barra no encontrada" }, 404)
      }

      const patch: Partial<{
        name: string
        isActive: boolean
      }> = {}
      if (body.name !== undefined) patch.name = body.name
      if (body.isActive !== undefined) patch.isActive = body.isActive

      await db
        .update(bars)
        .set(patch)
        .where(
          and(eq(bars.id, barId), eq(bars.tenantId, tenantId), eq(bars.eventId, eventId))
        )

      const [row] = await db
        .select()
        .from(bars)
        .where(
          and(
            eq(bars.id, barId),
            eq(bars.tenantId, tenantId),
            eq(bars.eventId, eventId)
          )
        )
        .limit(1)

      return c.json({ bar: row ? sanitizeBar(row) : null })
    }
  )
  .get("/:id/expenses", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const db = drizzle(pool)

    const ev = await requireEventForTenant(db, eventId, tenantId)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const rows = await db
      .select()
      .from(eventExpenses)
      .where(
        and(
          eq(eventExpenses.eventId, eventId),
          eq(eventExpenses.tenantId, tenantId)
        )
      )
      .orderBy(desc(eventExpenses.createdAt))

    return c.json({ expenses: rows.map(sanitizeExpense) })
  })
  .post("/:id/expenses", zValidator("json", createExpenseSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const ev = await requireEventForTenant(db, eventId, tenantId)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    let amt
    try {
      amt = dec(body.amount)
    } catch {
      return c.json({ error: "Monto inválido" }, 400)
    }
    if (amt.isNaN() || !amt.isFinite() || amt.lt(0)) {
      return c.json({ error: "Monto inválido" }, 400)
    }
    const amountStr = decToDb(amt)

    const id = uuidv4()
    await db.insert(eventExpenses).values({
      id,
      eventId,
      tenantId,
      description: body.description,
      category: body.category,
      amount: amountStr,
      date: new Date(),
      createdAt: new Date(),
    })

    const [row] = await db
      .select()
      .from(eventExpenses)
      .where(
        and(
          eq(eventExpenses.id, id),
          eq(eventExpenses.tenantId, tenantId),
          eq(eventExpenses.eventId, eventId)
        )
      )
      .limit(1)

    return c.json({ expense: row ? sanitizeExpense(row) : null }, 201)
  })
  .delete("/:id/expenses/:expenseId", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const expenseId = c.req.param("expenseId")
    const db = drizzle(pool)

    const ev = await requireEventForTenant(db, eventId, tenantId)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const [existing] = await db
      .select({ id: eventExpenses.id })
      .from(eventExpenses)
      .where(
        and(
          eq(eventExpenses.id, expenseId),
          eq(eventExpenses.eventId, eventId),
          eq(eventExpenses.tenantId, tenantId)
        )
      )
      .limit(1)
    if (!existing) {
      return c.json({ error: "Gasto no encontrado" }, 404)
    }

    await db
      .delete(eventExpenses)
      .where(
        and(
          eq(eventExpenses.id, expenseId),
          eq(eventExpenses.eventId, eventId),
          eq(eventExpenses.tenantId, tenantId)
        )
      )

    return c.json({ ok: true })
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
