import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import {
  barInventory,
  barProducts,
  bars,
  customers,
  digitalConsumptions,
  eventInventory,
  eventProducts,
  eventExpenses,
  events,
  eventStaff,
  inventoryItems,
  products,
  saleItems,
  sales,
  staff,
  ticketTypes,
  tickets,
} from "../db/schema"
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  or,
  sql,
  sum,
} from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { dec, decFromDb, decToDb } from "../lib/decimal-money"
import { stockAllocatedToBaseUnits } from "../lib/inventory-deduction"
import {
  deleteFileByKey,
  keyFromPublicUrl,
  publicUrlForKey,
  uploadFile,
} from "../lib/s3-client"

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

/** ISO 8601 instant from client (UTC or offset); null clears the window. */
const patchEventSchema = z
  .object({
    ticketsAvailableFrom: z.union([z.string().min(1), z.null()]).optional(),
    consumptionsAvailableFrom: z.union([z.string().min(1), z.null()]).optional(),
  })
  .superRefine((data, ctx) => {
    const check = (key: "ticketsAvailableFrom" | "consumptionsAvailableFrom") => {
      const v = data[key]
      if (v === undefined || v === null) return
      const t = Date.parse(v)
      if (Number.isNaN(t)) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid date",
          path: [key],
        })
      }
    }
    check("ticketsAvailableFrom")
    check("consumptionsAvailableFrom")
    if (
      data.ticketsAvailableFrom === undefined &&
      data.consumptionsAvailableFrom === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "At least one field is required",
        path: ["ticketsAvailableFrom"],
      })
    }
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

const stockInputAsSchema = z.enum(["BASE_UNITS", "PACKAGES"])

const patchEventInventorySchema = z.object({
  inventoryItemId: z.string().min(1).max(36),
  stockAllocated: z.union([
    z.number().nonnegative(),
    z.string().regex(/^\d+(\.\d{1,2})?$/),
  ]),
  stockInputAs: stockInputAsSchema.optional().default("BASE_UNITS"),
})

const createEventInsumoSchema = z.object({
  name: z.string().min(1).max(255),
  baseUnit: z.enum(["ML", "GRAMS", "UNIT"]),
  packageSize: z
    .union([
      z.number().nonnegative(),
      z.string().regex(/^\d+(\.\d{1,2})?$/),
    ])
    .optional(),
  initialStock: z
    .union([
      z.number().nonnegative(),
      z.string().regex(/^\d+(\.\d{1,2})?$/),
    ])
    .optional(),
  initialStockInputAs: stockInputAsSchema.optional().default("BASE_UNITS"),
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
    imageUrl: row.imageUrl ?? null,
    ticketsAvailableFrom: row.ticketsAvailableFrom
      ? row.ticketsAvailableFrom.toISOString()
      : null,
    consumptionsAvailableFrom: row.consumptionsAvailableFrom
      ? row.consumptionsAvailableFrom.toISOString()
      : null,
  }
}

const EVENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const EVENT_IMAGE_ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
])

function safeEventUploadFilename(name: string): string {
  const base = name
    .replace(/^.*[/\\]/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
  return (base || "image").slice(0, 120)
}

function guessImageContentType(file: File, filename: string): string | null {
  const t = file.type?.trim()
  if (t && EVENT_IMAGE_ALLOWED_TYPES.has(t)) return t
  const lower = filename.toLowerCase()
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".gif")) return "image/gif"
  return null
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

async function sumBarStockForEventItem(
  db: ReturnType<typeof drizzle>,
  eventId: string,
  tenantId: string,
  inventoryItemId: string
): Promise<string> {
  const [row] = await db
    .select({
      s: sql<string>`coalesce(sum(cast(${barInventory.currentStock} as decimal(14,2))), 0)`,
    })
    .from(barInventory)
    .innerJoin(bars, eq(barInventory.barId, bars.id))
    .where(
      and(
        eq(bars.eventId, eventId),
        eq(bars.tenantId, tenantId),
        eq(barInventory.tenantId, tenantId),
        eq(barInventory.inventoryItemId, inventoryItemId)
      )
    )
  return row?.s ?? "0"
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

const EMPTY_BAR_STATS = {
  staffList: [] as string[],
  productList: [] as string[],
  inventoryList: [] as { name: string; bottles: number }[],
  totalSales: "0.00",
} as const

/** Bottle-equivalent units for bar inventory row (aligned with admin display logic). */
function bottlesForBarInventoryRow(
  baseUnit: (typeof inventoryItems.$inferSelect)["baseUnit"],
  packageSize: string | null | undefined,
  currentStock: string
): number {
  const stock = decFromDb(currentStock)
  if (baseUnit === "UNIT") {
    return Math.max(0, Math.floor(stock.toNumber() + 1e-9))
  }
  const per = decFromDb(packageSize ?? "0")
  if (!per.gt(0)) {
    return Math.max(0, Math.floor(stock.toNumber() + 1e-9))
  }
  return Math.max(0, Math.floor(stock.div(per).toNumber() + 1e-9))
}

function sanitizeBar(
  row: typeof bars.$inferSelect,
  stats?: {
    staffList: string[]
    productList: string[]
    inventoryList: { name: string; bottles: number }[]
    totalSales: string
  }
) {
  const base = {
    id: row.id,
    eventId: row.eventId,
    tenantId: row.tenantId,
    name: row.name,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (!stats) {
    return base
  }
  return {
    ...base,
    staffList: stats.staffList,
    productList: stats.productList,
    inventoryList: stats.inventoryList,
    totalSales: stats.totalSales,
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
    const statusQ = c.req.query("status")
    const ticketTypeIdQ = c.req.query("ticketTypeId")
    const orderByQ = c.req.query("orderBy") ?? "createdAt"
    const orderQ = c.req.query("order") ?? "desc"

    if (
      statusQ != null &&
      statusQ !== "" &&
      statusQ !== "PENDING" &&
      statusQ !== "USED"
    ) {
      return c.json(
        { error: "status debe ser PENDING, USED u omitirse" },
        400
      )
    }
    if (orderByQ !== "createdAt" && orderByQ !== "scannedAt") {
      return c.json(
        { error: "orderBy debe ser createdAt o scannedAt" },
        400
      )
    }
    if (orderQ !== "asc" && orderQ !== "desc") {
      return c.json({ error: "order debe ser asc o desc" }, 400)
    }

    const db = drizzle(pool)
    const [ev] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
      .limit(1)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const conditions = [
      eq(tickets.eventId, eventId),
      eq(tickets.tenantId, tenantId),
      eq(ticketTypes.tenantId, tenantId),
      eq(ticketTypes.eventId, eventId),
    ]

    if (statusQ === "PENDING" || statusQ === "USED") {
      conditions.push(eq(tickets.status, statusQ))
    }

    if (ticketTypeIdQ != null && ticketTypeIdQ !== "") {
      conditions.push(eq(tickets.ticketTypeId, ticketTypeIdQ))
    }

    const orderColumn =
      orderByQ === "scannedAt" ? tickets.scannedAt : tickets.createdAt
    const orderFn = orderQ === "asc" ? asc : desc

    const rows = await db
      .select({
        id: tickets.id,
        qrHash: tickets.qrHash,
        status: tickets.status,
        buyerName: tickets.buyerName,
        buyerEmail: tickets.buyerEmail,
        createdAt: tickets.createdAt,
        scannedAt: tickets.scannedAt,
        emailSentAt: tickets.emailSentAt,
        ticketTypeId: tickets.ticketTypeId,
        ticketTypeName: ticketTypes.name,
      })
      .from(tickets)
      .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
      .where(and(...conditions))
      .orderBy(orderFn(orderColumn))

    return c.json({
      tickets: rows.map((r) => ({
        id: r.id,
        qrHash: r.qrHash,
        status: r.status,
        buyerName: r.buyerName,
        buyerEmail: r.buyerEmail,
        createdAt: r.createdAt,
        scannedAt: r.scannedAt,
        emailSentAt: r.emailSentAt,
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

    const canViewFinancials =
      ctx.staff.role === "ADMIN" || ctx.staff.role === "MANAGER"

    /** Predicado nuevo por consulta: reutilizar el mismo `and(...)` en paralelo puede mutar el AST en Drizzle. */
    const whereTicketsNonCancelled = () =>
      and(
        eq(tickets.eventId, eventId),
        eq(tickets.tenantId, tenantId),
        ne(tickets.status, "CANCELLED")
      )

    const whereSaleCountsAsRevenue = () =>
      and(
        eq(sales.eventId, eventId),
        eq(sales.tenantId, tenantId),
        or(isNull(sales.status), eq(sales.status, "COMPLETED"))
      )

    const [
      ticketsRow,
      ticketsUsedRow,
      ticketRevenueRow,
      revenueRow,
      barProductRevenueRow,
      consumptionsRow,
      consumptionsRedeemedRow,
      typeLimitRows,
      expenseRow,
    ] = await Promise.all([
      db
        .select({ n: count() })
        .from(tickets)
        .where(whereTicketsNonCancelled()),
      db
        .select({ n: count() })
        .from(tickets)
        .where(and(whereTicketsNonCancelled(), eq(tickets.status, "USED"))),
      db
        .select({
          total: sql<string>`coalesce(sum(cast(${ticketTypes.price} as decimal(14,2))), 0)`,
        })
        .from(tickets)
        .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
        .where(
          and(
            whereTicketsNonCancelled(),
            eq(ticketTypes.eventId, eventId),
            eq(ticketTypes.tenantId, tenantId)
          )
        ),
      db
        .select({
          total: sql<string>`coalesce(sum(cast(${sales.totalAmount} as decimal(14,2))), 0)`,
        })
        .from(sales)
        .where(whereSaleCountsAsRevenue()),
      db
        .select({
          total: sql<string>`coalesce(sum(cast(${saleItems.quantity} as decimal(14,4)) * cast(${saleItems.priceAtTime} as decimal(14,4))), 0)`,
        })
        .from(saleItems)
        .innerJoin(sales, eq(saleItems.saleId, sales.id))
        .where(whereSaleCountsAsRevenue()),
      db
        .select({ n: count() })
        .from(digitalConsumptions)
        .where(
          and(
            eq(digitalConsumptions.eventId, eventId),
            eq(digitalConsumptions.tenantId, tenantId),
            ne(digitalConsumptions.status, "CANCELLED")
          )
        ),
      db
        .select({ n: count() })
        .from(digitalConsumptions)
        .where(
          and(
            eq(digitalConsumptions.eventId, eventId),
            eq(digitalConsumptions.tenantId, tenantId),
            eq(digitalConsumptions.status, "REDEEMED")
          )
        ),
      db
        .select({ stockLimit: ticketTypes.stockLimit })
        .from(ticketTypes)
        .where(
          and(
            eq(ticketTypes.eventId, eventId),
            eq(ticketTypes.tenantId, tenantId)
          )
        ),
      canViewFinancials
        ? db
            .select({
              total: sql<string>`coalesce(sum(cast(${eventExpenses.amount} as decimal(14,2))), 0)`,
            })
            .from(eventExpenses)
            .where(
              and(
                eq(eventExpenses.eventId, eventId),
                eq(eventExpenses.tenantId, tenantId)
              )
            )
        : Promise.resolve([{ total: "0" }] as { total: string }[]),
    ])

    const ticketsSold = Number(ticketsRow[0]?.n ?? 0)
    const ticketsCheckedIn = Number(ticketsUsedRow[0]?.n ?? 0)
    const ticketRevenueDec = decFromDb(ticketRevenueRow[0]?.total ?? "0")
    const barSalesDec = decFromDb(revenueRow[0]?.total ?? "0")
    const grossDec = ticketRevenueDec.plus(barSalesDec)
    const expensesDec = canViewFinancials
      ? decFromDb(expenseRow[0]?.total ?? "0")
      : dec(0)
    const netDec = canViewFinancials ? grossDec.minus(expensesDec) : dec(0)

    let ticketCapacity: number | null = null
    if (typeLimitRows.length > 0) {
      const unlimited = typeLimitRows.some((r) => r.stockLimit == null)
      if (!unlimited) {
        ticketCapacity = typeLimitRows.reduce(
          (s, r) => s + (r.stockLimit ?? 0),
          0
        )
      }
    }

    const digitalGenerated = Number(consumptionsRow[0]?.n ?? 0)
    const digitalRedeemed = Number(consumptionsRedeemedRow[0]?.n ?? 0)

    const barProductDec = decFromDb(barProductRevenueRow[0]?.total ?? "0")

    return c.json({
      canViewFinancials,
      ticketsSold,
      ticketsCheckedIn,
      ticketCapacity,
      ticketRevenue: decToDb(ticketRevenueDec),
      barSalesRevenue: decToDb(barSalesDec),
      grossRevenue: decToDb(grossDec),
      totalExpenses: canViewFinancials ? decToDb(expensesDec) : null,
      netProfit: canViewFinancials ? decToDb(netDec) : null,
      totalRevenue: decToDb(barSalesDec),
      barProductRevenue: decToDb(barProductDec),
      digitalConsumptionsSold: digitalGenerated,
      digitalConsumptionsGenerated: digitalGenerated,
      digitalConsumptionsRedeemed: digitalRedeemed,
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
          ne(tickets.status, "CANCELLED"),
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

    const linkedIds = [...new Set(links.map((l) => l.productId))]
    const catalogListed = or(eq(products.isActive, true), isNull(products.isActive))
    const catalogWhere =
      linkedIds.length === 0
        ? and(eq(products.tenantId, tenantId), catalogListed)
        : and(
            eq(products.tenantId, tenantId),
            or(catalogListed, inArray(products.id, linkedIds))
          )

    const catalog = await db
      .select({
        id: products.id,
        name: products.name,
        price: products.price,
        catalogIsActive: products.isActive,
      })
      .from(products)
      .where(catalogWhere)
      .orderBy(asc(products.name))

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
  .get("/:id/inventory", async (c) => {
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
        id: inventoryItems.id,
        name: inventoryItems.name,
        baseUnit: inventoryItems.baseUnit,
        packageSize: inventoryItems.packageSize,
        eventInventoryId: eventInventory.id,
        stockAllocated: eventInventory.stockAllocated,
      })
      .from(inventoryItems)
      .leftJoin(
        eventInventory,
        and(
          eq(eventInventory.inventoryItemId, inventoryItems.id),
          eq(eventInventory.eventId, eventId),
          eq(eventInventory.tenantId, tenantId)
        )
      )
      .where(
        and(
          eq(inventoryItems.tenantId, tenantId),
          eq(inventoryItems.isActive, true)
        )
      )
      .orderBy(asc(inventoryItems.name))

    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        baseUnit: r.baseUnit,
        packageSize: r.packageSize,
        eventInventoryId: r.eventInventoryId ?? null,
        stockAllocated:
          r.stockAllocated == null ? "0.00" : String(r.stockAllocated),
      })),
    })
  })
  .patch(
    "/:id/inventory",
    zValidator("json", patchEventInventorySchema),
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

      const [itemRow] = await db
        .select()
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.id, body.inventoryItemId),
            eq(inventoryItems.tenantId, tenantId),
            eq(inventoryItems.isActive, true)
          )
        )
        .limit(1)
      if (!itemRow) {
        return c.json({ error: "Ítem no encontrado" }, 404)
      }

      const conv = stockAllocatedToBaseUnits(
        itemRow,
        body.stockAllocated,
        body.stockInputAs
      )
      if (conv.error) {
        return c.json({ error: conv.error }, 400)
      }
      const stockStr = decToDb(conv.value)
      const sumBars = decFromDb(
        await sumBarStockForEventItem(db, eventId, tenantId, body.inventoryItemId)
      )
      if (decFromDb(stockStr).lt(sumBars)) {
        return c.json(
          {
            error:
              "El stock del evento no puede ser menor que la suma ya distribuida en las barras.",
          },
          400
        )
      }

      await db
        .insert(eventInventory)
        .values({
          id: uuidv4(),
          eventId,
          inventoryItemId: body.inventoryItemId,
          tenantId,
          stockAllocated: stockStr,
          createdAt: new Date(),
        })
        .onDuplicateKeyUpdate({
          set: { stockAllocated: stockStr },
        })

      return c.json({ ok: true, stockAllocated: stockStr })
    }
  )
  .post(
    "/:id/inventory/create",
    zValidator("json", createEventInsumoSchema),
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

      const pkgStr =
        body.packageSize !== undefined
          ? decToDb(dec(body.packageSize))
          : "0.00"

      const virtualItem = {
        baseUnit: body.baseUnit,
        packageSize: pkgStr,
      } as const

      let initialStr = "0.00"
      if (body.initialStock !== undefined) {
        const initConv = stockAllocatedToBaseUnits(
          virtualItem,
          body.initialStock,
          body.initialStockInputAs
        )
        if (initConv.error) {
          return c.json({ error: initConv.error }, 400)
        }
        initialStr = decToDb(initConv.value)
      }

      const itemId = uuidv4()
      const evInvId = uuidv4()

      await db.transaction(async (tx) => {
        await tx.insert(inventoryItems).values({
          id: itemId,
          tenantId,
          name: body.name.trim(),
          baseUnit: body.baseUnit,
          packageSize: pkgStr,
          isActive: true,
        })
        await tx.insert(eventInventory).values({
          id: evInvId,
          eventId,
          inventoryItemId: itemId,
          tenantId,
          stockAllocated: initialStr,
          createdAt: new Date(),
        })
      })

      return c.json(
        {
          item: {
            id: itemId,
            name: body.name.trim(),
            baseUnit: body.baseUnit,
            packageSize: pkgStr,
            eventInventoryId: evInvId,
            stockAllocated: initialStr,
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

    if (rows.length === 0) {
      return c.json({ bars: [] })
    }

    const barIds = rows.map((r) => r.id)

    const [staffRows, productRows, invRows, salesAgg] = await Promise.all([
      db
        .select({
          barId: eventStaff.barId,
          staffName: staff.name,
        })
        .from(eventStaff)
        .innerJoin(staff, eq(eventStaff.staffId, staff.id))
        .where(
          and(
            eq(eventStaff.eventId, eventId),
            eq(eventStaff.tenantId, tenantId),
            eq(staff.tenantId, tenantId),
            inArray(eventStaff.barId, barIds)
          )
        )
        .orderBy(asc(staff.name)),
      db
        .select({
          barId: barProducts.barId,
          productName: products.name,
        })
        .from(barProducts)
        .innerJoin(products, eq(barProducts.productId, products.id))
        .where(
          and(
            eq(barProducts.tenantId, tenantId),
            eq(products.tenantId, tenantId),
            eq(barProducts.isActive, true),
            inArray(barProducts.barId, barIds)
          )
        )
        .orderBy(asc(products.name)),
      db
        .select({
          barId: barInventory.barId,
          itemName: inventoryItems.name,
          baseUnit: inventoryItems.baseUnit,
          packageSize: inventoryItems.packageSize,
          currentStock: barInventory.currentStock,
        })
        .from(barInventory)
        .innerJoin(
          inventoryItems,
          eq(barInventory.inventoryItemId, inventoryItems.id)
        )
        .where(
          and(
            eq(barInventory.tenantId, tenantId),
            eq(inventoryItems.tenantId, tenantId),
            inArray(barInventory.barId, barIds)
          )
        )
        .orderBy(asc(inventoryItems.name)),
      db
        .select({
          barId: sales.barId,
          total: sql<string>`coalesce(sum(cast(${sales.totalAmount} as decimal(14,4))), 0)`,
        })
        .from(sales)
        .where(
          and(
            eq(sales.eventId, eventId),
            eq(sales.tenantId, tenantId),
            eq(sales.status, "COMPLETED"),
            inArray(sales.barId, barIds)
          )
        )
        .groupBy(sales.barId),
    ])

    const staffListByBar = new Map<string, string[]>()
    for (const r of staffRows) {
      if (r.barId == null) continue
      const list = staffListByBar.get(r.barId) ?? []
      list.push(r.staffName)
      staffListByBar.set(r.barId, list)
    }

    const productListByBar = new Map<string, string[]>()
    for (const r of productRows) {
      if (r.barId == null) continue
      const list = productListByBar.get(r.barId) ?? []
      list.push(r.productName)
      productListByBar.set(r.barId, list)
    }

    const inventoryListByBar = new Map<string, { name: string; bottles: number }[]>()
    for (const r of invRows) {
      if (r.barId == null) continue
      const bottles = bottlesForBarInventoryRow(
        r.baseUnit,
        r.packageSize,
        String(r.currentStock)
      )
      const list = inventoryListByBar.get(r.barId) ?? []
      list.push({ name: r.itemName, bottles })
      inventoryListByBar.set(r.barId, list)
    }

    const salesByBar = new Map<string, string>()
    for (const r of salesAgg) {
      if (r.barId != null) {
        salesByBar.set(r.barId, String(r.total ?? "0"))
      }
    }

    function money2(raw: string): string {
      const n = Number.parseFloat(raw)
      if (Number.isNaN(n)) return "0.00"
      return n.toFixed(2)
    }

    return c.json({
      bars: rows.map((row) => {
        const id = row.id
        return sanitizeBar(row, {
          staffList: staffListByBar.get(id) ?? [],
          productList: productListByBar.get(id) ?? [],
          inventoryList: inventoryListByBar.get(id) ?? [],
          totalSales: money2(salesByBar.get(id) ?? "0"),
        })
      }),
    })
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

    return c.json(
      { bar: row ? sanitizeBar(row, { ...EMPTY_BAR_STATS }) : null },
      201
    )
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

      return c.json({
        bar: row ? sanitizeBar(row, { ...EMPTY_BAR_STATS }) : null,
      })
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
  .get("/:id/sales", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const limitRaw = c.req.query("limit")
    const offsetRaw = c.req.query("offset")
    const barIdRaw = c.req.query("barId")?.trim()
    const limit = Math.min(
      Math.max(Number.parseInt(limitRaw ?? "50", 10) || 50, 1),
      200
    )
    const offset = Math.max(Number.parseInt(offsetRaw ?? "0", 10) || 0, 0)

    const db = drizzle(pool)
    const ev = await requireEventForTenant(db, eventId, tenantId)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    let filterBarId: string | undefined
    if (barIdRaw && barIdRaw.length > 0) {
      const bar = await requireBarForEventTenant(db, barIdRaw, eventId, tenantId)
      if (!bar) {
        return c.json({ error: "Barra no encontrada" }, 404)
      }
      filterBarId = barIdRaw
    }

    const saleFilters = [
      eq(sales.eventId, eventId),
      eq(sales.tenantId, tenantId),
      eq(sales.status, "COMPLETED"),
      exists(
        db
          .select({ id: saleItems.id })
          .from(saleItems)
          .where(eq(saleItems.saleId, sales.id))
      ),
    ]
    if (filterBarId) {
      saleFilters.push(eq(sales.barId, filterBarId))
    }

    const pageRows = await db
      .select({
        id: sales.id,
        createdAt: sales.createdAt,
        source: sales.source,
        totalAmount: sales.totalAmount,
        paymentMethod: sales.paymentMethod,
        staffName: staff.name,
        customerName: customers.name,
      })
      .from(sales)
      .leftJoin(
        staff,
        and(eq(sales.staffId, staff.id), eq(staff.tenantId, tenantId))
      )
      .leftJoin(customers, eq(sales.customerId, customers.id))
      .where(and(...saleFilters))
      .orderBy(desc(sales.createdAt))
      .limit(limit + 1)
      .offset(offset)

    const hasMore = pageRows.length > limit
    const slice = hasMore ? pageRows.slice(0, limit) : pageRows
    const saleIds = slice.map((r) => r.id)

    const itemsBySale = new Map<
      string,
      { quantity: number; productName: string; priceAtTime: string }[]
    >()

    if (saleIds.length > 0) {
      const itemRows = await db
        .select({
          saleId: saleItems.saleId,
          quantity: saleItems.quantity,
          productName: products.name,
          priceAtTime: saleItems.priceAtTime,
        })
        .from(saleItems)
        .innerJoin(products, eq(saleItems.productId, products.id))
        .where(
          and(inArray(saleItems.saleId, saleIds), eq(products.tenantId, tenantId))
        )

      for (const row of itemRows) {
        const list = itemsBySale.get(row.saleId) ?? []
        list.push({
          quantity: row.quantity,
          productName: row.productName,
          priceAtTime: String(row.priceAtTime),
        })
        itemsBySale.set(row.saleId, list)
      }
    }

    function itemsSummary(saleId: string): string {
      const lines = itemsBySale.get(saleId) ?? []
      if (lines.length === 0) return "—"
      return lines
        .map((l) => `${l.quantity}× ${l.productName}`)
        .join(", ")
    }

    function productLinesTotal(saleId: string): string {
      const lines = itemsBySale.get(saleId) ?? []
      let t = dec(0)
      for (const l of lines) {
        t = t.plus(dec(l.quantity).times(decFromDb(l.priceAtTime)))
      }
      return decToDb(t)
    }

    return c.json({
      sales: slice.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        source: r.source,
        totalAmount: productLinesTotal(r.id),
        paymentMethod: r.paymentMethod,
        staffName: r.staffName,
        customerName: r.customerName,
        itemsSummary: itemsSummary(r.id),
      })),
      hasMore,
      limit,
      offset,
    })
  })
  .get("/:id/stock-snapshot", async (c) => {
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

    const eventBars = await db
      .select({ id: bars.id })
      .from(bars)
      .where(and(eq(bars.eventId, eventId), eq(bars.tenantId, tenantId)))
    const barIds = eventBars.map((b) => b.id)

    const evInvRows = await db
      .select({
        inventoryItemId: eventInventory.inventoryItemId,
        stockAllocated: eventInventory.stockAllocated,
      })
      .from(eventInventory)
      .where(
        and(
          eq(eventInventory.eventId, eventId),
          eq(eventInventory.tenantId, tenantId)
        )
      )

    const barInvRows =
      barIds.length === 0
        ? []
        : await db
            .select({
              barId: barInventory.barId,
              inventoryItemId: barInventory.inventoryItemId,
              currentStock: barInventory.currentStock,
            })
            .from(barInventory)
            .innerJoin(bars, eq(barInventory.barId, bars.id))
            .where(
              and(
                eq(barInventory.tenantId, tenantId),
                eq(bars.eventId, eventId),
                eq(bars.tenantId, tenantId),
                inArray(barInventory.barId, barIds)
              )
            )

    return c.json({
      eventInventory: evInvRows.map((r) => ({
        inventoryItemId: r.inventoryItemId,
        stockAllocated: String(r.stockAllocated),
      })),
      barInventory: barInvRows.map((r) => ({
        barId: r.barId,
        inventoryItemId: r.inventoryItemId,
        currentStock: String(r.currentStock),
      })),
    })
  })
  .get("/:id/inventory-breakdown", async (c) => {
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

    const eventBars = await db
      .select({ id: bars.id, name: bars.name })
      .from(bars)
      .where(and(eq(bars.eventId, eventId), eq(bars.tenantId, tenantId)))

    const barIds = eventBars.map((b) => b.id)
    const barNameById = new Map(eventBars.map((b) => [b.id, b.name]))

    const evInvRows = await db
      .select({
        inventoryItemId: inventoryItems.id,
        itemName: inventoryItems.name,
        baseUnit: inventoryItems.baseUnit,
        packageSize: inventoryItems.packageSize,
        stockAllocated: eventInventory.stockAllocated,
      })
      .from(eventInventory)
      .innerJoin(
        inventoryItems,
        eq(eventInventory.inventoryItemId, inventoryItems.id)
      )
      .where(
        and(
          eq(eventInventory.eventId, eventId),
          eq(eventInventory.tenantId, tenantId),
          eq(inventoryItems.tenantId, tenantId),
          eq(inventoryItems.isActive, true)
        )
      )

    const barDistRows =
      barIds.length === 0
        ? []
        : await db
            .select({
              inventoryItemId: inventoryItems.id,
              itemName: inventoryItems.name,
              baseUnit: inventoryItems.baseUnit,
              packageSize: inventoryItems.packageSize,
              barId: barInventory.barId,
              stock: barInventory.currentStock,
            })
            .from(barInventory)
            .innerJoin(bars, eq(barInventory.barId, bars.id))
            .innerJoin(
              inventoryItems,
              eq(barInventory.inventoryItemId, inventoryItems.id)
            )
            .where(
              and(
                eq(barInventory.tenantId, tenantId),
                eq(inventoryItems.tenantId, tenantId),
                eq(inventoryItems.isActive, true),
                eq(bars.eventId, eventId),
                eq(bars.tenantId, tenantId),
                inArray(bars.id, barIds)
              )
            )

    type Agg = {
      itemName: string
      baseUnit: (typeof inventoryItems.$inferSelect)["baseUnit"]
      packageSize: string
      stockAllocated: ReturnType<typeof dec>
      bars: { barName: string; stock: string }[]
      sumBars: ReturnType<typeof dec>
    }

    const byItem = new Map<string, Agg>()

    for (const r of evInvRows) {
      byItem.set(r.inventoryItemId, {
        itemName: r.itemName,
        baseUnit: r.baseUnit,
        packageSize: String(r.packageSize),
        stockAllocated: decFromDb(r.stockAllocated),
        bars: [],
        sumBars: dec(0),
      })
    }

    for (const r of barDistRows) {
      let agg = byItem.get(r.inventoryItemId)
      if (!agg) {
        agg = {
          itemName: r.itemName,
          baseUnit: r.baseUnit,
          packageSize: String(r.packageSize),
          stockAllocated: dec(0),
          bars: [],
          sumBars: dec(0),
        }
        byItem.set(r.inventoryItemId, agg)
      }
      const stockDec = dec(r.stock)
      agg.sumBars = agg.sumBars.plus(stockDec)
      const barName = barNameById.get(r.barId) ?? "—"
      agg.bars.push({
        barName,
        stock: decToDb(stockDec),
      })
    }

    const items = [...byItem.entries()]
      .map(([inventoryItemId, agg]) => ({
        inventoryItemId,
        itemName: agg.itemName,
        baseUnit: agg.baseUnit,
        packageSize: agg.packageSize,
        stockAllocated: decToDb(agg.stockAllocated),
        totalInBars: decToDb(agg.sumBars),
        bars: agg.bars.sort((a, b) => a.barName.localeCompare(b.barName)),
      }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName))

    return c.json({ items })
  })
  .patch("/:id", zValidator("json", patchEventSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const [existing] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
      .limit(1)
    if (!existing) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const setPayload: {
      ticketsAvailableFrom?: Date | null
      consumptionsAvailableFrom?: Date | null
    } = {}
    if (body.ticketsAvailableFrom !== undefined) {
      setPayload.ticketsAvailableFrom =
        body.ticketsAvailableFrom === null
          ? null
          : new Date(body.ticketsAvailableFrom)
    }
    if (body.consumptionsAvailableFrom !== undefined) {
      setPayload.consumptionsAvailableFrom =
        body.consumptionsAvailableFrom === null
          ? null
          : new Date(body.consumptionsAvailableFrom)
    }

    await db
      .update(events)
      .set(setPayload)
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))

    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
      .limit(1)
    if (!row) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }
    return c.json({ event: sanitizeEvent(row) })
  })
  .post("/:id/image", async (c) => {
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

    let body: Record<string, string | File>
    try {
      body = (await c.req.parseBody()) as Record<string, string | File>
    } catch {
      return c.json({ error: "No se pudo leer el formulario." }, 400)
    }

    const raw = body.image ?? body.file
    if (!(raw instanceof File)) {
      return c.json(
        { error: "Adjuntá una imagen en el campo «image» (multipart/form-data)." },
        400
      )
    }

    if (raw.size > EVENT_IMAGE_MAX_BYTES) {
      return c.json({ error: "La imagen no puede superar los 5 MB." }, 400)
    }

    const contentType = guessImageContentType(raw, raw.name)
    if (!contentType) {
      return c.json(
        { error: "Formato no permitido. Usá JPEG, PNG, WebP o GIF." },
        400
      )
    }

    const segment = safeEventUploadFilename(raw.name)
    const key = `events/${eventId}/${Date.now()}-${segment}`

    let publicUrl: string
    try {
      const buf = Buffer.from(await raw.arrayBuffer())
      await uploadFile(buf, key, contentType)
      publicUrl = publicUrlForKey(key)
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error al subir la imagen"
      if (msg.includes("Missing required environment variable")) {
        return c.json(
          { error: "Almacenamiento no configurado (variables R2)." },
          503
        )
      }
      return c.json({ error: "No se pudo subir la imagen al almacenamiento." }, 502)
    }

    if (publicUrl.length > 512) {
      return c.json({ error: "La URL pública generada supera el límite permitido." }, 400)
    }

    if (ev.imageUrl) {
      const oldKey = keyFromPublicUrl(ev.imageUrl)
      if (oldKey) {
        try {
          await deleteFileByKey(oldKey)
        } catch {
          /* reemplazo best-effort */
        }
      }
    }

    await db
      .update(events)
      .set({ imageUrl: publicUrl })
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))

    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
      .limit(1)
    if (!row) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }
    return c.json({ event: sanitizeEvent(row) })
  })
  .delete("/:id/image", async (c) => {
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

    if (ev.imageUrl) {
      const oldKey = keyFromPublicUrl(ev.imageUrl)
      if (oldKey) {
        try {
          await deleteFileByKey(oldKey)
        } catch {
          /* seguimos limpiando la DB */
        }
      }
    }

    await db
      .update(events)
      .set({ imageUrl: null })
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))

    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
      .limit(1)
    if (!row) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }
    return c.json({ event: sanitizeEvent(row) })
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
