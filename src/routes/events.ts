import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import {
  barInventory,
  barProducts,
  bars,
  courtesies,
  customers,
  digitalConsumptions,
  eventInventory,
  eventProducts,
  eventExpenses,
  events,
  type EventClosingReport,
  eventStaff,
  inventoryItems,
  products,
  purchases,
  saleItems,
  sales,
  staff,
  tenants,
  ticketTiers,
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
import { evaluateTicketTiers, type TicketTier } from "../lib/ticket-tiers"
import {
  EVENT_STATUSES,
  eventStatusRank,
  outgoingTransition,
  type EventStatus,
} from "../lib/event-status"
import {
  bottleLoadStockDelta,
  stockAllocatedToBaseUnits,
} from "../lib/inventory-deduction"
import { findOrCreateInventoryItemByName } from "./inventory"
import { emitCommittedStockDeltas } from "../lib/event-stock-broadcast"
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

// Tarea 1.9 — "Partir de: [último evento]". Duplica la CONFIGURACIÓN de un evento en un
// nuevo borrador. Todos los campos son opcionales: sin body, el nuevo evento hereda nombre
// ("... (copia)"), fecha y lugar del origen.
const duplicateEventSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  date: z.string().min(1).optional(),
  location: z.string().max(255).optional(),
})

/** ISO 8601 instant from client (UTC or offset); null clears the window. */
const patchEventSchema = z
  .object({
    ticketsAvailableFrom: z.union([z.string().min(1), z.null()]).optional(),
    consumptionsAvailableFrom: z.union([z.string().min(1), z.null()]).optional(),
    slug: z
      .union([
        z
          .string()
          .min(2)
          .max(100)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Solo minúsculas, números y guiones"),
        z.null(),
      ])
      .optional(),
    designType: z.enum(["GLASS", "MINIMAL"]).optional(),
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
      data.consumptionsAvailableFrom === undefined &&
      data.slug === undefined &&
      data.designType === undefined
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

// Edición de un tipo de entrada (spec §4.2: persiste al blur, sin "Guardar" global).
// Todos los campos opcionales: el front manda solo lo que cambió.
const patchTicketTypeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  price: z.coerce.number().nonnegative().optional(),
  stockLimit: z
    .union([z.coerce.number().int().positive(), z.null()])
    .optional(),
})

// Tandas (spec §4.2): reemplazo atómico de TODA la escalera de un tipo. El editor de la
// UI arma la frase completa ("Early $8.000 (200) → General $10.000") y la manda entera;
// acá se borran las tandas viejas y se insertan las nuevas con `position` = orden del array.
const replaceTiersSchema = z.object({
  tiers: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        price: z.coerce.number().nonnegative(),
        stockLimit: z
          .union([z.coerce.number().int().positive(), z.null()])
          .optional(),
        activeFrom: z.union([z.string().datetime(), z.null()]).optional(),
        activeUntil: z.union([z.string().datetime(), z.null()]).optional(),
      })
    )
    .max(20),
})

const createCourtesySchema = z.object({
  ticketTypeId: z.string().min(1).max(36),
  guestName: z.string().min(1).max(255),
  guestEmail: z.union([z.string().email(), z.literal(""), z.null()]).optional(),
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

// Tarea 1.6 — Compra de mercadería. El insumo se identifica por id (existente) o por nombre
// (nace implícito). La cantidad va en unidad contable (botellas/latas); el costo total asienta
// el gasto. Exactamente uno de inventoryItemId / itemName.
const createPurchaseSchema = z
  .object({
    inventoryItemId: z.string().min(1).max(36).optional(),
    itemName: z.string().min(1).max(255).optional(),
    // Unidad contable si el insumo nace implícito (se ignora si el insumo ya existe).
    countingUnit: z.string().min(1).max(50).optional(),
    quantity: z.union([
      z.number().finite().positive(),
      z.string().regex(/^\d+(\.\d{1,2})?$/),
    ]),
    // Costo total de la compra. 0 = ajuste sin costo (no asienta gasto).
    totalCost: z
      .union([z.number().finite().nonnegative(), z.string().regex(/^\d+(\.\d{1,2})?$/)])
      .optional(),
    note: z.string().max(255).optional(),
  })
  .superRefine((data, ctx) => {
    const hasId = data.inventoryItemId != null && data.inventoryItemId !== ""
    const hasName = data.itemName != null && data.itemName.trim() !== ""
    if (hasId === hasName) {
      ctx.addIssue({
        code: "custom",
        message: "Indicá exactamente inventoryItemId o itemName",
        path: ["itemName"],
      })
    }
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

// Cortesías canjeadas (entradas emitidas por invitación) de un tipo, para contarlas
// "aparte" de las ventas pagas (spec §4.2). Una cortesía cuenta acá cuando ya emitió
// su entrada (status REDEEMED) y esa entrada no fue anulada.
async function countRedeemedCourtesies(
  db: ReturnType<typeof drizzle>,
  tenantId: string,
  ticketTypeId: string
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(courtesies)
    .innerJoin(tickets, eq(courtesies.ticketId, tickets.id))
    .where(
      and(
        eq(courtesies.tenantId, tenantId),
        eq(courtesies.ticketTypeId, ticketTypeId),
        eq(courtesies.status, "REDEEMED"),
        ne(tickets.status, "CANCELLED")
      )
    )
  return Number(row?.n ?? 0)
}

function sanitizeCourtesy(row: typeof courtesies.$inferSelect) {
  return {
    id: row.id,
    eventId: row.eventId,
    ticketTypeId: row.ticketTypeId,
    guestName: row.guestName,
    guestEmail: row.guestEmail ?? null,
    token: row.token,
    status: row.status,
    ticketId: row.ticketId ?? null,
    redeemedAt: row.redeemedAt ? row.redeemedAt.toISOString() : null,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
  }
}

function sanitizeEvent(row: typeof events.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    slug: row.slug ?? null,
    date: row.date,
    location: row.location,
    isActive: row.isActive,
    status: row.status ?? "draft",
    doorsAt: row.doorsAt ? row.doorsAt.toISOString() : null,
    salesOpenedAt: row.salesOpenedAt ? row.salesOpenedAt.toISOString() : null,
    wentLiveAt: row.wentLiveAt ? row.wentLiveAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closingReport: row.closingReport ?? null,
    createdAt: row.createdAt,
    imageUrl: row.imageUrl ?? null,
    designType: row.designType ?? "GLASS",
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

/**
 * Requisitos esenciales para "Abrir venta" (spec §5). Devuelve las piezas que faltan como
 * fragmentos ("al menos un tipo de entrada", "configurar el cobro") para que el header las una
 * en una sola frase. Esencial = al menos un tipo de entrada + el cobro configurado a nivel tenant.
 */
type OpenSaleReadiness = { canOpenSale: boolean; missing: string[] }

async function computeOpenSaleReadiness(
  db: ReturnType<typeof drizzle>,
  eventId: string,
  tenantId: string
): Promise<OpenSaleReadiness> {
  const [typeRows, tenantRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(ticketTypes)
      .where(
        and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.tenantId, tenantId))
      ),
    db
      .select({
        mpConnected: tenants.mpConnected,
        cucuruEnabled: tenants.cucuruEnabled,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1),
  ])
  const missing: string[] = []
  if (Number(typeRows[0]?.n ?? 0) === 0) {
    missing.push("al menos un tipo de entrada")
  }
  const paymentConfigured =
    Boolean(tenantRows[0]?.mpConnected) || Boolean(tenantRows[0]?.cucuruEnabled)
  if (!paymentConfigured) {
    missing.push("configurar el cobro")
  }
  return { canOpenSale: missing.length === 0, missing }
}

/**
 * Datos base para la ceremonia de cierre (tarea 4.4 / spec §5). Reúne, en una sola pasada, lo
 * que el flujo por pasos necesita: ingresos (entradas + barra), gastos operativos vs. mercadería
 * comprada, la caja esperada en efectivo, y por cada insumo su estimación de sobrante (lo que el
 * sistema cree que queda, en unidad contable) más su costo unitario derivado de las compras.
 * El conteo REAL lo aporta el productor en `POST /:id/closing`; acá no se persiste nada.
 */
type ClosingInsumo = {
  inventoryItemId: string
  name: string
  countingUnit: string
  estimated: number
  purchased: number
  unitCost: string
  purchasedCost: string
}
type ClosingData = {
  income: { tickets: string; bar: string; gross: string }
  expenses: { operational: string; merchandisePurchased: string }
  cash: { expected: string; hasCashSales: boolean }
  insumos: ClosingInsumo[]
}

/** Stock en base units (ml/g/unidad) → unidad contable (botellas/latas/unidades). */
function baseToCounting(
  base: ReturnType<typeof dec>,
  baseUnit: "ML" | "GRAMS" | "UNIT",
  packageSize: string
): number {
  if (baseUnit === "ML" || baseUnit === "GRAMS") {
    const per = dec(packageSize)
    if (per.gt(0)) return base.div(per).toNumber()
  }
  return base.toNumber()
}

async function computeClosingData(
  db: ReturnType<typeof drizzle>,
  eventId: string,
  tenantId: string
): Promise<ClosingData> {
  const whereTicketsNonCancelled = () =>
    and(
      eq(tickets.eventId, eventId),
      eq(tickets.tenantId, tenantId),
      ne(tickets.status, "CANCELLED")
    )

  const [
    ticketRevenueRow,
    barRevenueRow,
    operationalRow,
    merchandiseRow,
    cashRow,
    invRows,
    purchaseRows,
  ] = await Promise.all([
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
        total: sql<string>`coalesce(sum(cast(${saleItems.quantity} as decimal(14,4)) * cast(${saleItems.priceAtTime} as decimal(14,4))), 0)`,
      })
      .from(saleItems)
      .innerJoin(sales, eq(saleItems.saleId, sales.id))
      .where(
        and(
          eq(sales.eventId, eventId),
          eq(sales.tenantId, tenantId),
          eq(sales.status, "COMPLETED")
        )
      ),
    db
      .select({
        total: sql<string>`coalesce(sum(cast(${eventExpenses.amount} as decimal(14,2))), 0)`,
      })
      .from(eventExpenses)
      .where(
        and(
          eq(eventExpenses.eventId, eventId),
          eq(eventExpenses.tenantId, tenantId),
          isNull(eventExpenses.purchaseId)
        )
      ),
    db
      .select({
        total: sql<string>`coalesce(sum(cast(${eventExpenses.amount} as decimal(14,2))), 0)`,
      })
      .from(eventExpenses)
      .where(
        and(
          eq(eventExpenses.eventId, eventId),
          eq(eventExpenses.tenantId, tenantId),
          sql`${eventExpenses.purchaseId} is not null`
        )
      ),
    db
      .select({
        total: sql<string>`coalesce(sum(cast(${sales.totalAmount} as decimal(14,2))), 0)`,
      })
      .from(sales)
      .where(
        and(
          eq(sales.eventId, eventId),
          eq(sales.tenantId, tenantId),
          eq(sales.status, "COMPLETED"),
          eq(sales.paymentMethod, "CASH")
        )
      ),
    db
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        countingUnit: inventoryItems.countingUnit,
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
      .orderBy(asc(inventoryItems.name)),
    db
      .select({
        inventoryItemId: purchases.inventoryItemId,
        qty: sql<string>`coalesce(sum(cast(${purchases.quantity} as decimal(14,2))), 0)`,
        cost: sql<string>`coalesce(sum(cast(${purchases.totalCost} as decimal(14,2))), 0)`,
      })
      .from(purchases)
      .where(
        and(eq(purchases.eventId, eventId), eq(purchases.tenantId, tenantId))
      )
      .groupBy(purchases.inventoryItemId),
  ])

  const ticketDec = decFromDb(ticketRevenueRow[0]?.total ?? "0")
  const barDec = decFromDb(barRevenueRow[0]?.total ?? "0")
  const grossDec = ticketDec.plus(barDec)
  const cashDec = decFromDb(cashRow[0]?.total ?? "0")

  const purchaseByItem = new Map(
    purchaseRows.map((r) => [r.inventoryItemId, { qty: r.qty, cost: r.cost }])
  )

  const insumos: ClosingInsumo[] = invRows.map((r) => {
    const purchase = purchaseByItem.get(r.id)
    const purchasedQtyDec = dec(purchase?.qty ?? "0")
    const purchasedCostDec = dec(purchase?.cost ?? "0")
    const unitCostDec = purchasedQtyDec.gt(0)
      ? purchasedCostDec.div(purchasedQtyDec)
      : dec(0)
    return {
      inventoryItemId: r.id,
      name: r.name,
      countingUnit: r.countingUnit,
      estimated: baseToCounting(
        decFromDb(r.stockAllocated),
        r.baseUnit,
        String(r.packageSize)
      ),
      purchased: purchasedQtyDec.toNumber(),
      unitCost: decToDb(unitCostDec),
      purchasedCost: decToDb(purchasedCostDec),
    }
  })

  return {
    income: {
      tickets: decToDb(ticketDec),
      bar: decToDb(barDec),
      gross: decToDb(grossDec),
    },
    expenses: {
      operational: decToDb(decFromDb(operationalRow[0]?.total ?? "0")),
      merchandisePurchased: decToDb(decFromDb(merchandiseRow[0]?.total ?? "0")),
    },
    cash: {
      expected: decToDb(cashDec),
      hasCashSales: cashDec.gt(0),
    },
    insumos,
  }
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

/**
 * Devuelve la barra implícita del evento (la que "vende todo" por defecto),
 * materializándola on-demand si hace falta. Encarna la "barra implícita" de la
 * spec §4.3: el productor nunca la crea; existe sola. Reglas:
 *  - si ya hay una barra con isDefault=true, la devuelve;
 *  - si hay barras pero ninguna default (datos viejos), promueve la más vieja;
 *  - si el evento no tiene barras, crea "Barra general" (isDefault=true).
 * No la llama ningún read por sí solo (para no cambiar el comportamiento del POS,
 * que sigue operando a nivel evento con barId=null); se invoca en acciones
 * deliberadas como "Dividir en puestos". Exportada para reusar en Fase 3.2.
 */
export async function ensureDefaultBar(
  db: ReturnType<typeof drizzle>,
  tenantId: string,
  eventId: string
): Promise<typeof bars.$inferSelect> {
  const existing = await db
    .select()
    .from(bars)
    .where(and(eq(bars.eventId, eventId), eq(bars.tenantId, tenantId)))
    .orderBy(desc(bars.isDefault), asc(bars.createdAt), asc(bars.id))

  const current = existing[0]
  if (current) {
    if (!current.isDefault) {
      // Datos viejos sin default: promuevo la más vieja.
      await db
        .update(bars)
        .set({ isDefault: true })
        .where(and(eq(bars.id, current.id), eq(bars.tenantId, tenantId)))
      return { ...current, isDefault: true }
    }
    return current
  }

  const id = uuidv4()
  await db.insert(bars).values({
    id,
    eventId,
    tenantId,
    name: "Barra general",
    isDefault: true,
    isActive: true,
    createdAt: new Date(),
  })
  const [row] = await db
    .select()
    .from(bars)
    .where(and(eq(bars.id, id), eq(bars.tenantId, tenantId)))
    .limit(1)
  return row!
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
    isDefault: row.isDefault,
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
    // Tarea 1.6: != null cuando el gasto vino de una compra de mercadería (no editable a mano).
    purchaseId: row.purchaseId ?? null,
  }
}

function sanitizePurchase(row: typeof purchases.$inferSelect) {
  return {
    id: row.id,
    eventId: row.eventId,
    tenantId: row.tenantId,
    inventoryItemId: row.inventoryItemId,
    quantity: String(row.quantity),
    countingUnit: row.countingUnit,
    totalCost: String(row.totalCost),
    note: row.note ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
  }
}

function tierRowToTier(row: typeof ticketTiers.$inferSelect): TicketTier {
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    position: row.position,
    stockLimit: row.stockLimit,
    activeFrom: row.activeFrom ? row.activeFrom.toISOString() : null,
    activeUntil: row.activeUntil ? row.activeUntil.toISOString() : null,
  }
}

function sanitizeTicketType(
  row: typeof ticketTypes.$inferSelect,
  sold: number,
  tierRows: (typeof ticketTiers.$inferSelect)[] = [],
  // Cortesías canjeadas de este tipo, contadas aparte (spec §4.2). No consumen
  // el cupo pago ni las tandas: son un regalo extra del productor.
  courtesyCount = 0
) {
  const limit = row.stockLimit
  const remaining =
    limit == null ? null : Math.max(0, limit - sold)

  // Tandas (spec §4.2): si el tipo tiene escalera, el precio efectivo y el stock
  // vigente salen de la tanda activa; si no, hereda el precio/stock plano del tipo.
  const tiers = tierRows.map(tierRowToTier)
  let activeTier = null as null | {
    id: string
    name: string
    price: string
    remaining: number | null
  }
  let effectivePrice = row.price
  if (tiers.length > 0) {
    const evalResult = evaluateTicketTiers(tiers, sold)
    if (evalResult.active) {
      activeTier = {
        id: evalResult.active.id,
        name: evalResult.active.name,
        price: evalResult.active.price,
        remaining: evalResult.remainingInActive,
      }
      effectivePrice = evalResult.active.price
    }
  }

  return {
    id: row.id,
    eventId: row.eventId,
    tenantId: row.tenantId,
    name: row.name,
    price: row.price,
    stockLimit: row.stockLimit,
    sold,
    remaining,
    // Cortesías canjeadas de este tipo, contadas aparte de `sold`.
    courtesies: courtesyCount,
    // Precio que efectivamente sale ahora (tanda activa o precio plano).
    effectivePrice,
    // La escalera completa (ordenada) + la tanda vigente, o vacío si no hay tandas.
    tiers: tiers.sort((a, b) => a.position - b.position),
    activeTier,
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
      status: "draft",
      createdAt: new Date(),
    })
    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, id), eq(events.tenantId, tenantId)))
    return c.json({ event: sanitizeEvent(row) }, 201)
  })
  // Tarea 1.9 — Duplicar evento ("Partir de: [último evento]"). Clona la CONFIGURACIÓN del
  // evento origen en un nuevo BORRADOR: tipos de entrada + tandas, menú (event_products) con
  // sus precios/isActive, barras (default + puestos) con su menú (bar_products), y el equipo
  // (event_staff, con su puesto). NO clona los HECHOS del evento: ventas, entradas emitidas,
  // cortesías canjeadas, stock (event/bar inventory), compras ni gastos. El evento nuevo nace
  // 'draft' (isActive true), sin slug (es único), sin fechas de apertura/cierre.
  .post("/:id/duplicate", zValidator("json", duplicateEventSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const sourceId = c.req.param("id")
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const [source] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, sourceId), eq(events.tenantId, tenantId)))
      .limit(1)
    if (!source) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    // Config a clonar del evento origen.
    const [srcTypes, srcTiers, srcEventProducts, srcBars, srcBarProducts, srcEventStaff] =
      await Promise.all([
        db
          .select()
          .from(ticketTypes)
          .where(and(eq(ticketTypes.eventId, sourceId), eq(ticketTypes.tenantId, tenantId))),
        db
          .select()
          .from(ticketTiers)
          .where(and(eq(ticketTiers.eventId, sourceId), eq(ticketTiers.tenantId, tenantId))),
        db
          .select()
          .from(eventProducts)
          .where(and(eq(eventProducts.eventId, sourceId), eq(eventProducts.tenantId, tenantId))),
        db
          .select()
          .from(bars)
          .where(and(eq(bars.eventId, sourceId), eq(bars.tenantId, tenantId))),
        db
          .select()
          .from(barProducts)
          .where(eq(barProducts.tenantId, tenantId)),
        db
          .select()
          .from(eventStaff)
          .where(and(eq(eventStaff.eventId, sourceId), eq(eventStaff.tenantId, tenantId))),
      ])

    // barProducts no tiene eventId: filtro las filas cuyas barras pertenecen al evento origen.
    const srcBarIds = new Set(srcBars.map((b) => b.id))
    const srcBarProductsForEvent = srcBarProducts.filter((bp) => srcBarIds.has(bp.barId))

    const newEventId = uuidv4()
    const newName = body.name?.trim() || `${source.name} (copia)`
    const newDate = body.date ? new Date(body.date) : source.date
    const newLocation = body.location ?? source.location ?? null

    // Mapas id origen → id nuevo para remapear las FKs entre tablas.
    const typeIdMap = new Map<string, string>()
    const barIdMap = new Map<string, string>()

    await db.transaction(async (tx) => {
      await tx.insert(events).values({
        id: newEventId,
        tenantId,
        name: newName,
        date: newDate,
        location: newLocation,
        isActive: true,
        status: "draft",
        designType: source.designType,
        imageUrl: source.imageUrl ?? null,
        createdAt: new Date(),
      })

      // Tipos de entrada (precio + stock).
      for (const t of srcTypes) {
        const id = uuidv4()
        typeIdMap.set(t.id, id)
        await tx.insert(ticketTypes).values({
          id,
          eventId: newEventId,
          tenantId,
          name: t.name,
          price: t.price,
          stockLimit: t.stockLimit,
        })
      }

      // Tandas (escalera de precios) remapeadas al nuevo tipo y evento.
      for (const tier of srcTiers) {
        const newTypeId = typeIdMap.get(tier.ticketTypeId)
        if (!newTypeId) continue
        await tx.insert(ticketTiers).values({
          id: uuidv4(),
          ticketTypeId: newTypeId,
          eventId: newEventId,
          tenantId,
          name: tier.name,
          price: tier.price,
          position: tier.position,
          stockLimit: tier.stockLimit,
          activeFrom: tier.activeFrom,
          activeUntil: tier.activeUntil,
          createdAt: new Date(),
        })
      }

      // Menú del evento con precios de evento. NO se clona el stock (directStock queda null):
      // el stock es un hecho del evento, no configuración.
      for (const ep of srcEventProducts) {
        await tx.insert(eventProducts).values({
          id: uuidv4(),
          eventId: newEventId,
          productId: ep.productId,
          tenantId,
          priceOverride: ep.priceOverride,
          isActive: ep.isActive,
          directStock: null,
          createdAt: new Date(),
        })
      }

      // Barras (default + puestos) — sin stock (bar_inventory no se clona).
      for (const b of srcBars) {
        const id = uuidv4()
        barIdMap.set(b.id, id)
        await tx.insert(bars).values({
          id,
          eventId: newEventId,
          tenantId,
          name: b.name,
          isDefault: b.isDefault,
          isActive: b.isActive,
          createdAt: new Date(),
        })
      }

      // Menú de cada barra/puesto remapeado a la barra nueva.
      for (const bp of srcBarProductsForEvent) {
        const newBarId = barIdMap.get(bp.barId)
        if (!newBarId) continue
        await tx.insert(barProducts).values({
          id: uuidv4(),
          barId: newBarId,
          productId: bp.productId,
          tenantId,
          isActive: bp.isActive,
          createdAt: new Date(),
        })
      }

      // Equipo: cada persona con su puesto (barId remapeado si estaba asignada a uno).
      for (const es of srcEventStaff) {
        const newBarId = es.barId ? barIdMap.get(es.barId) ?? null : null
        await tx.insert(eventStaff).values({
          id: uuidv4(),
          eventId: newEventId,
          tenantId,
          staffId: es.staffId,
          barId: newBarId,
          createdAt: new Date(),
        })
      }
    })

    const [row] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, newEventId), eq(events.tenantId, tenantId)))
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
    const tierRows = await db
      .select()
      .from(ticketTiers)
      .where(
        and(eq(ticketTiers.eventId, eventId), eq(ticketTiers.tenantId, tenantId))
      )
    const tiersByType = new Map<string, (typeof ticketTiers.$inferSelect)[]>()
    for (const t of tierRows) {
      const list = tiersByType.get(t.ticketTypeId) ?? []
      list.push(t)
      tiersByType.set(t.ticketTypeId, list)
    }
    const enriched = []
    for (const t of types) {
      // `issued` = todas las entradas no anuladas; `courtesyCount` = las que vinieron
      // de una cortesía. Las ventas pagas (`sold`) son la diferencia: así las cortesías
      // se cuentan aparte y no consumen cupo pago ni tandas (spec §4.2).
      const issued = await countIssuedTickets(db, tenantId, t.id)
      const courtesyCount = await countRedeemedCourtesies(db, tenantId, t.id)
      const sold = Math.max(0, issued - courtesyCount)
      enriched.push(
        sanitizeTicketType(t, sold, tiersByType.get(t.id) ?? [], courtesyCount)
      )
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
  .patch(
    "/:id/ticket-types/:typeId",
    zValidator("json", patchTicketTypeSchema),
    async (c) => {
      const ctx = c as AuthenticatedContext
      const tenantId = requireTenantId(ctx)
      if (!tenantId) {
        return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
      }
      const eventId = c.req.param("id")
      const typeId = c.req.param("typeId")
      const body = c.req.valid("json")
      const db = drizzle(pool)
      const [row] = await db
        .select()
        .from(ticketTypes)
        .where(
          and(
            eq(ticketTypes.id, typeId),
            eq(ticketTypes.eventId, eventId),
            eq(ticketTypes.tenantId, tenantId)
          )
        )
        .limit(1)
      if (!row) {
        return c.json({ error: "Tipo de entrada no encontrado" }, 404)
      }
      const patch: Partial<typeof ticketTypes.$inferInsert> = {}
      if (body.name !== undefined) patch.name = body.name
      if (body.price !== undefined) patch.price = body.price.toFixed(2)
      if (body.stockLimit !== undefined) patch.stockLimit = body.stockLimit
      if (Object.keys(patch).length > 0) {
        await db
          .update(ticketTypes)
          .set(patch)
          .where(
            and(eq(ticketTypes.id, typeId), eq(ticketTypes.tenantId, tenantId))
          )
      }
      const [updated] = await db
        .select()
        .from(ticketTypes)
        .where(and(eq(ticketTypes.id, typeId), eq(ticketTypes.tenantId, tenantId)))
        .limit(1)
      const tierRows = await db
        .select()
        .from(ticketTiers)
        .where(
          and(
            eq(ticketTiers.ticketTypeId, typeId),
            eq(ticketTiers.tenantId, tenantId)
          )
        )
      const issued = await countIssuedTickets(db, tenantId, typeId)
      const courtesyCount = await countRedeemedCourtesies(db, tenantId, typeId)
      const sold = Math.max(0, issued - courtesyCount)
      return c.json({
        ticketType: sanitizeTicketType(updated, sold, tierRows, courtesyCount),
      })
    }
  )
  .delete("/:id/ticket-types/:typeId", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const typeId = c.req.param("typeId")
    const db = drizzle(pool)
    const [row] = await db
      .select()
      .from(ticketTypes)
      .where(
        and(
          eq(ticketTypes.id, typeId),
          eq(ticketTypes.eventId, eventId),
          eq(ticketTypes.tenantId, tenantId)
        )
      )
      .limit(1)
    if (!row) {
      return c.json({ error: "Tipo de entrada no encontrado" }, 404)
    }
    // No se borra un tipo que ya emitió entradas: tocaría dinero/accesos ya vivos.
    const issued = await countIssuedTickets(db, tenantId, typeId)
    if (issued > 0) {
      return c.json(
        {
          error:
            "Este tipo ya tiene entradas emitidas. No se puede eliminar; ajustá su cupo o precio.",
        },
        409
      )
    }
    // Limpiar la escalera de tandas antes de borrar el tipo (FK).
    await db
      .delete(ticketTiers)
      .where(
        and(eq(ticketTiers.ticketTypeId, typeId), eq(ticketTiers.tenantId, tenantId))
      )
    await db
      .delete(ticketTypes)
      .where(and(eq(ticketTypes.id, typeId), eq(ticketTypes.tenantId, tenantId)))
    return c.json({ ok: true })
  })
  // Tandas (spec §4.2): reemplaza TODA la escalera de un tipo de una vez. La UI arma la
  // frase completa y la manda entera; acá se borra lo viejo y se inserta lo nuevo.
  .put(
    "/:id/ticket-types/:typeId/tiers",
    zValidator("json", replaceTiersSchema),
    async (c) => {
      const ctx = c as AuthenticatedContext
      const tenantId = requireTenantId(ctx)
      if (!tenantId) {
        return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
      }
      const eventId = c.req.param("id")
      const typeId = c.req.param("typeId")
      const body = c.req.valid("json")
      const db = drizzle(pool)
      const [tt] = await db
        .select()
        .from(ticketTypes)
        .where(
          and(
            eq(ticketTypes.id, typeId),
            eq(ticketTypes.eventId, eventId),
            eq(ticketTypes.tenantId, tenantId)
          )
        )
        .limit(1)
      if (!tt) {
        return c.json({ error: "Tipo de entrada no encontrado" }, 404)
      }
      await db.transaction(async (tx) => {
        await tx
          .delete(ticketTiers)
          .where(
            and(
              eq(ticketTiers.ticketTypeId, typeId),
              eq(ticketTiers.tenantId, tenantId)
            )
          )
        for (let i = 0; i < body.tiers.length; i++) {
          const t = body.tiers[i]
          await tx.insert(ticketTiers).values({
            id: uuidv4(),
            ticketTypeId: typeId,
            eventId,
            tenantId,
            name: t.name,
            price: t.price.toFixed(2),
            position: i,
            stockLimit: t.stockLimit ?? null,
            activeFrom: t.activeFrom ? new Date(t.activeFrom) : null,
            activeUntil: t.activeUntil ? new Date(t.activeUntil) : null,
            createdAt: new Date(),
          })
        }
      })
      const tierRows = await db
        .select()
        .from(ticketTiers)
        .where(
          and(
            eq(ticketTiers.ticketTypeId, typeId),
            eq(ticketTiers.tenantId, tenantId)
          )
        )
      const issued = await countIssuedTickets(db, tenantId, typeId)
      const courtesyCount = await countRedeemedCourtesies(db, tenantId, typeId)
      const sold = Math.max(0, issued - courtesyCount)
      return c.json({
        ticketType: sanitizeTicketType(tt, sold, tierRows, courtesyCount),
      })
    }
  )
  // Cortesías / invitaciones (spec §4.2): links nominados que emiten una entrada.
  .get("/:id/courtesies", async (c) => {
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
      .select()
      .from(courtesies)
      .where(
        and(eq(courtesies.eventId, eventId), eq(courtesies.tenantId, tenantId))
      )
      .orderBy(desc(courtesies.createdAt))
    return c.json({ courtesies: rows.map(sanitizeCourtesy) })
  })
  .post(
    "/:id/courtesies",
    zValidator("json", createCourtesySchema),
    async (c) => {
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
      // El tipo de entrada tiene que ser de este evento y tenant.
      const [tt] = await db
        .select()
        .from(ticketTypes)
        .where(
          and(
            eq(ticketTypes.id, body.ticketTypeId),
            eq(ticketTypes.eventId, eventId),
            eq(ticketTypes.tenantId, tenantId)
          )
        )
        .limit(1)
      if (!tt) {
        return c.json({ error: "Tipo de entrada no encontrado" }, 404)
      }
      const email =
        body.guestEmail != null && body.guestEmail !== ""
          ? body.guestEmail
          : null
      const id = uuidv4()
      const token = uuidv4()
      await db.insert(courtesies).values({
        id,
        tenantId,
        eventId,
        ticketTypeId: body.ticketTypeId,
        guestName: body.guestName,
        guestEmail: email,
        token,
        status: "PENDING",
        createdBy: ctx.staff.id,
        createdAt: new Date(),
      })
      const [row] = await db
        .select()
        .from(courtesies)
        .where(and(eq(courtesies.id, id), eq(courtesies.tenantId, tenantId)))
        .limit(1)
      return c.json({ courtesy: sanitizeCourtesy(row) }, 201)
    }
  )
  .post("/:id/courtesies/:courtesyId/revoke", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const eventId = c.req.param("id")
    const courtesyId = c.req.param("courtesyId")
    const db = drizzle(pool)
    const [row] = await db
      .select()
      .from(courtesies)
      .where(
        and(
          eq(courtesies.id, courtesyId),
          eq(courtesies.eventId, eventId),
          eq(courtesies.tenantId, tenantId)
        )
      )
      .limit(1)
    if (!row) {
      return c.json({ error: "Cortesía no encontrada" }, 404)
    }
    if (row.status === "REDEEMED") {
      return c.json(
        {
          error:
            "No se puede anular una cortesía ya canjeada. Anulá la entrada emitida desde Entradas.",
        },
        409
      )
    }
    if (row.status === "REVOKED") {
      return c.json({ courtesy: sanitizeCourtesy(row) })
    }
    await db
      .update(courtesies)
      .set({ status: "REVOKED" })
      .where(and(eq(courtesies.id, courtesyId), eq(courtesies.tenantId, tenantId)))
    const [updated] = await db
      .select()
      .from(courtesies)
      .where(eq(courtesies.id, courtesyId))
      .limit(1)
    return c.json({ courtesy: sanitizeCourtesy(updated) })
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
        eq(sales.status, "COMPLETED")
      )

    const [
      ticketsRow,
      ticketsUsedRow,
      ticketRevenueRow,
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
    const barSalesDec = decFromDb(barProductRevenueRow[0]?.total ?? "0")
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
      barProductRevenue: decToDb(barSalesDec),
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
        directStock: eventProducts.directStock,
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
        imageUrl: products.imageUrl,
      })
      .from(products)
      .where(catalogWhere)
      .orderBy(asc(products.name))

    const byProduct = new Map(
      links.map((r) => [
        r.productId,
        { isActive: r.isActive, priceOverride: r.priceOverride, directStock: r.directStock },
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
          imageUrl: p.imageUrl ?? null,
          isActiveForEvent: row?.isActive === true,
          priceOverride:
            row?.priceOverride === null || row?.priceOverride === undefined
              ? null
              : String(row.priceOverride),
          directStock:
            row?.directStock == null ? null : String(row.directStock),
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
  .patch(
    "/:id/products/set-override",
    zValidator(
      "json",
      z.object({
        productId: z.string().min(1).max(36),
        priceOverride: z.union([z.string(), z.null()]),
      })
    ),
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
      if (!ev) return c.json({ error: "Evento no encontrado" }, 404)

      const override =
        body.priceOverride === null || body.priceOverride === ""
          ? null
          : decToDb(dec(body.priceOverride))

      const [existing] = await db
        .select({ id: eventProducts.id })
        .from(eventProducts)
        .where(
          and(
            eq(eventProducts.eventId, eventId),
            eq(eventProducts.productId, body.productId),
            eq(eventProducts.tenantId, tenantId)
          )
        )
        .limit(1)

      if (!existing) {
        return c.json({ error: "El producto no está en el evento" }, 404)
      }

      await db
        .update(eventProducts)
        .set({ priceOverride: override })
        .where(eq(eventProducts.id, existing.id))

      return c.json({ ok: true })
    }
  )
  .post(
    "/:id/products/load-direct-stock",
    zValidator(
      "json",
      z.object({
        productId: z.string().min(1).max(36),
        quantity: z.coerce.number().int().positive(),
        costType: z.enum(["TOTAL", "UNIT"]).optional(),
        costAmount: z
          .union([z.string().regex(/^\d+(\.\d{1,2})?$/), z.coerce.number().nonnegative()])
          .optional(),
      })
    ),
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
      if (!ev) return c.json({ error: "Evento no encontrado" }, 404)

      const [epRow] = await db
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

      if (!epRow) {
        return c.json({ error: "El producto no está en el evento" }, 404)
      }

      const current = epRow.directStock != null ? decFromDb(String(epRow.directStock)) : dec(0)
      const next = current.plus(dec(body.quantity))

      await db.transaction(async (tx) => {
        await tx
          .update(eventProducts)
          .set({ directStock: decToDb(next) })
          .where(eq(eventProducts.id, epRow.id))

        const hasCost =
          body.costType != null &&
          body.costAmount != null &&
          String(body.costAmount).trim() !== ""
        if (hasCost) {
          const amt = dec(String(body.costAmount).replace(",", "."))
          const total = body.costType === "UNIT" ? amt.times(body.quantity) : amt
          if (total.gt(0)) {
            const [prod] = await tx
              .select({ name: products.name })
              .from(products)
              .where(eq(products.id, body.productId))
              .limit(1)
            await tx.insert(eventExpenses).values({
              id: uuidv4(),
              eventId,
              tenantId,
              description: `Compra de stock: ${body.quantity} u. de ${prod?.name ?? body.productId}`.slice(0, 255),
              category: "FOOD",
              amount: decToDb(total),
              date: new Date(),
            })
          }
        }
      })

      return c.json({ ok: true, directStock: decToDb(next) })
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

    // "Dividir en puestos": el puesto nuevo hereda del default y jamás nace
    // vacío. Materializo primero la barra implícita, luego creo el puesto
    // copiando su menú (los barProducts activos del default).
    const defaultBar = await ensureDefaultBar(db, tenantId, eventId)

    const id = uuidv4()
    await db.insert(bars).values({
      id,
      eventId,
      tenantId,
      name: body.name,
      isDefault: false,
      isActive: true,
      createdAt: new Date(),
    })

    // Hereda el menú del default: copia sus overrides de barProducts, así el
    // puesto jamás nace vacío. El menú real (con nombres) se ve en el próximo
    // GET /:id/bars; acá devuelvo stats vacías como hacía antes.
    const menu = await db
      .select({
        productId: barProducts.productId,
        isActive: barProducts.isActive,
      })
      .from(barProducts)
      .where(
        and(
          eq(barProducts.barId, defaultBar.id),
          eq(barProducts.tenantId, tenantId)
        )
      )
    if (menu.length > 0) {
      await db.insert(barProducts).values(
        menu.map((m) => ({
          id: uuidv4(),
          barId: id,
          productId: m.productId,
          tenantId,
          isActive: m.isActive ?? true,
          createdAt: new Date(),
        }))
      )
    }

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

      // La barra implícita siempre existe y vende todo: no se puede desactivar
      // (sí renombrar). Los puestos sí se pueden desactivar.
      if (existing.isDefault && body.isActive === false) {
        return c.json(
          { error: "No se puede desactivar la barra general del evento." },
          400
        )
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
  // Tarea 1.6 — Compras de mercadería del evento. Registro único: sube stock del evento y
  // asienta el gasto a la vez, enlazado por `eventExpenses.purchaseId` para no duplicar.
  .get("/:id/purchases", async (c) => {
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
      .from(purchases)
      .where(and(eq(purchases.eventId, eventId), eq(purchases.tenantId, tenantId)))
      .orderBy(desc(purchases.createdAt))

    return c.json({ purchases: rows.map(sanitizePurchase) })
  })
  .post("/:id/purchases", zValidator("json", createPurchaseSchema), async (c) => {
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

    // Cantidad (unidad contable) y costo total, validados a Decimal.
    let qty
    let cost
    try {
      qty = dec(body.quantity)
      cost = body.totalCost == null ? dec(0) : dec(body.totalCost)
    } catch {
      return c.json({ error: "Cantidad o costo inválidos" }, 400)
    }
    if (qty.isNaN() || !qty.isFinite() || qty.lte(0)) {
      return c.json({ error: "La cantidad debe ser mayor que 0" }, 400)
    }
    if (cost.isNaN() || !cost.isFinite() || cost.lt(0)) {
      return c.json({ error: "Costo inválido" }, 400)
    }

    // Resolvé el insumo: por id (existente) o por nombre (nace implícito, spec §2/§4.3).
    let item
    if (body.inventoryItemId) {
      const [found] = await db
        .select()
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.id, body.inventoryItemId),
            eq(inventoryItems.tenantId, tenantId)
          )
        )
        .limit(1)
      if (!found) {
        return c.json({ error: "Insumo no encontrado" }, 404)
      }
      if (found.isActive === false) {
        return c.json({ error: "El insumo está desactivado." }, 400)
      }
      item = found
    } else {
      item = await findOrCreateInventoryItemByName(
        db,
        tenantId,
        body.itemName!,
        body.countingUnit?.trim() || "unidad"
      )
    }

    // Convertí la cantidad contable a base units para el stock del evento (mismo criterio que
    // load-bottles). Para insumos del modelo nuevo (UNIT) el delta es la cantidad tal cual.
    const { delta, error: deltaErr } = bottleLoadStockDelta(item, qty.toNumber())
    if (deltaErr) {
      return c.json({ error: deltaErr }, 400)
    }
    if (!delta.gt(0)) {
      return c.json({ error: "La cantidad a sumar debe ser mayor que 0" }, 400)
    }

    const purchaseId = uuidv4()
    const costStr = decToDb(cost)
    const noteTrimmed = body.note?.trim() || null

    const nextAllocated = await db.transaction(async (tx) => {
      // 1) El registro físico de la compra (fuente de verdad del hecho).
      await tx.insert(purchases).values({
        id: purchaseId,
        tenantId,
        eventId,
        inventoryItemId: item.id,
        quantity: decToDb(qty),
        countingUnit: item.countingUnit,
        totalCost: costStr,
        note: noteTrimmed,
        createdBy: ctx.staff.id,
        createdAt: new Date(),
      })

      // 2) El gasto enlazado (solo si hubo costo). purchaseId lo marca como mercadería, así
      //    Finanzas (3.5) lo excluye de los gastos operativos y el /summary lo cuenta una vez.
      if (cost.gt(0)) {
        await tx.insert(eventExpenses).values({
          id: uuidv4(),
          eventId,
          tenantId,
          description: `Compra: ${decToDb(qty)} ${item.countingUnit} de ${item.name}`.slice(0, 255),
          category: "FOOD",
          amount: costStr,
          date: new Date(),
          createdAt: new Date(),
          purchaseId,
        })
      }

      // 3) Subí el stock asignado al evento (upsert), igual que la rama de evento de load-bottles.
      const [evInv] = await tx
        .select()
        .from(eventInventory)
        .where(
          and(
            eq(eventInventory.eventId, eventId),
            eq(eventInventory.inventoryItemId, item.id),
            eq(eventInventory.tenantId, tenantId)
          )
        )
        .limit(1)
      const next = (evInv ? decFromDb(evInv.stockAllocated) : dec(0)).plus(delta)
      await tx
        .insert(eventInventory)
        .values({
          id: uuidv4(),
          eventId,
          inventoryItemId: item.id,
          tenantId,
          stockAllocated: decToDb(next),
          createdAt: new Date(),
        })
        .onDuplicateKeyUpdate({ set: { stockAllocated: decToDb(next) } })

      return next
    })

    void emitCommittedStockDeltas(tenantId, eventId, {
      eventItemIds: [item.id],
    })

    const [row] = await db
      .select()
      .from(purchases)
      .where(and(eq(purchases.id, purchaseId), eq(purchases.tenantId, tenantId)))
      .limit(1)

    return c.json(
      {
        purchase: row ? sanitizePurchase(row) : null,
        stockAllocated: decToDb(nextAllocated),
        inventoryItemId: item.id,
        itemName: item.name,
      },
      201
    )
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
  // Readiness para "Abrir venta" (spec §5). El header lee esto en borrador para atenuar el
  // botón y mostrar en una línea qué falta. Ver `computeOpenSaleReadiness`.
  .get("/:id/readiness", async (c) => {
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
    const readiness = await computeOpenSaleReadiness(db, eventId, tenantId)
    return c.json(readiness)
  })
  // Transición de estado del evento (spec §5). El productor solo empuja dos manualmente:
  // "Abrir venta" (draft→on_sale) y "Cerrar el evento" (live→closed). "Arrancar ahora"
  // (on_sale→live) es override de lo automático a la hora de puertas. Solo se avanza (nunca se
  // retrocede). El grafo es lineal (draft→on_sale→live→closed): para llegar a `to` se recorre
  // el camino sellando las marcas efectivas. Abrir venta exige readiness. Si algún `to` saltea
  // estados (p. ej. cerrar directo desde on_sale) se sellan todas las marcas intermedias.
  .post(
    "/:id/transition",
    zValidator(
      "json",
      z.object({
        to: z.enum(EVENT_STATUSES as unknown as [EventStatus, ...EventStatus[]]),
      })
    ),
    async (c) => {
      const ctx = c as AuthenticatedContext
      const tenantId = requireTenantId(ctx)
      if (!tenantId) {
        return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
      }
      const eventId = c.req.param("id")
      const { to } = c.req.valid("json")
      const db = drizzle(pool)

      const ev = await requireEventForTenant(db, eventId, tenantId)
      if (!ev) {
        return c.json({ error: "Evento no encontrado" }, 404)
      }

      const from = (ev.status ?? "draft") as EventStatus
      if (from === to) {
        return c.json({ event: sanitizeEvent(ev) })
      }
      if (eventStatusRank(to) <= eventStatusRank(from)) {
        return c.json(
          { error: "El estado del evento solo avanza, no retrocede." },
          400
        )
      }

      // Abrir venta exige lo esencial (tipo de entrada + cobro configurado).
      if (from === "draft") {
        const readiness = await computeOpenSaleReadiness(db, eventId, tenantId)
        if (!readiness.canOpenSale) {
          return c.json(
            {
              error: `Falta ${readiness.missing.join(" y ")}.`,
              missing: readiness.missing,
            },
            422
          )
        }
      }

      const now = new Date()
      const setPayload: {
        status: EventStatus
        isActive?: boolean
        salesOpenedAt?: Date
        wentLiveAt?: Date
        closedAt?: Date
      } = { status: to }

      // Recorrer el grafo lineal desde `from` hasta `to`, sellando cada marca efectiva.
      let cursor: EventStatus | undefined = from
      while (cursor && cursor !== to) {
        const step = outgoingTransition(cursor)
        if (!step) break
        const next = step.to
        if (next === "on_sale" && !ev.salesOpenedAt) setPayload.salesOpenedAt = now
        if (next === "live" && !ev.wentLiveAt) setPayload.wentLiveAt = now
        if (next === "closed") setPayload.closedAt = now
        cursor = next
      }

      // Sync legacy `isActive`: activo mientras vende/está en vivo, inactivo al cerrar.
      setPayload.isActive = to !== "closed"

      await db
        .update(events)
        .set(setPayload)
        .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))

      const [row] = await db
        .select()
        .from(events)
        .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
        .limit(1)
      return c.json({ event: sanitizeEvent(row) })
    }
  )
  // Ceremonia de cierre (tarea 4.4 / spec §5). GET prepara los datos del flujo por pasos:
  // insumos con su estimación de sobrante + costo unitario, ingresos, gastos y caja esperada.
  // Si el evento ya está cerrado, devuelve además el `report` congelado (para 4.5).
  .get("/:id/closing", async (c) => {
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
    const data = await computeClosingData(db, eventId, tenantId)
    return c.json({ ...data, report: ev.closingReport ?? null })
  })
  // POST cierra el evento con la liquidación de la ceremonia: recibe el conteo REAL de insumos y
  // la caja contada, recalcula todo del lado servidor (autoridad), congela el reporte en
  // `events.closing_report` y transiciona el evento a `closed`. El costo se cuenta sobre la
  // mercadería CONSUMIDA (lo comprado menos lo que sobró, valuado al costo unitario): el sobrante
  // no es pérdida, viaja como stock valuado. La merma es la diferencia estimado − contado.
  .post(
    "/:id/closing",
    zValidator(
      "json",
      z.object({
        counts: z.array(
          z.object({
            inventoryItemId: z.string(),
            counted: z.number().min(0),
          })
        ),
        cashCounted: z.union([z.number(), z.string()]).nullable().optional(),
      })
    ),
    async (c) => {
      const ctx = c as AuthenticatedContext
      const tenantId = requireTenantId(ctx)
      if (!tenantId) {
        return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
      }
      const eventId = c.req.param("id")
      const { counts, cashCounted } = c.req.valid("json")
      const db = drizzle(pool)

      const ev = await requireEventForTenant(db, eventId, tenantId)
      if (!ev) {
        return c.json({ error: "Evento no encontrado" }, 404)
      }
      const from = (ev.status ?? "draft") as EventStatus
      if (from === "closed") {
        return c.json({ error: "El evento ya está cerrado." }, 409)
      }

      const data = await computeClosingData(db, eventId, tenantId)
      const countedById = new Map(
        counts.map((r) => [r.inventoryItemId, Math.max(0, r.counted)])
      )

      let consumedDec = dec(0)
      let leftoverDec = dec(0)
      let mermaValueDec = dec(0)
      const reportInsumos: EventClosingReport["insumos"] = data.insumos.map(
        (i) => {
          const counted = countedById.get(i.inventoryItemId) ?? i.estimated
          const unitCostDec = dec(i.unitCost)
          // Sobrante valuado: acotado a lo comprado (no se valúa más de lo que costó plata).
          const leftoverUnits = Math.min(counted, i.purchased)
          const itemLeftoverDec = dec(leftoverUnits).times(unitCostDec)
          const itemConsumedDec = dec(i.purchasedCost).minus(itemLeftoverDec)
          const mermaUnits = i.estimated - counted
          const itemMermaDec =
            mermaUnits > 0 ? dec(mermaUnits).times(unitCostDec) : dec(0)
          consumedDec = consumedDec.plus(itemConsumedDec)
          leftoverDec = leftoverDec.plus(itemLeftoverDec)
          mermaValueDec = mermaValueDec.plus(itemMermaDec)
          return {
            inventoryItemId: i.inventoryItemId,
            name: i.name,
            countingUnit: i.countingUnit,
            estimated: i.estimated,
            counted,
            purchased: i.purchased,
            unitCost: i.unitCost,
            consumedCost: decToDb(itemConsumedDec),
            leftoverValue: decToDb(itemLeftoverDec),
            mermaUnits,
            mermaValue: decToDb(itemMermaDec),
          }
        }
      )

      const grossDec = decFromDb(data.income.gross)
      const operationalDec = decFromDb(data.expenses.operational)
      const merchandisePurchasedDec = decFromDb(
        data.expenses.merchandisePurchased
      )
      // Neto real: ingresos − gastos operativos − mercadería CONSUMIDA (el sobrante no resta).
      const netRealDec = grossDec.minus(operationalDec).minus(consumedDec)
      // Neto proyectado: como si toda la mercadería comprada fuera costo (lo que muestra /summary).
      const netProjectedDec = grossDec
        .minus(operationalDec)
        .minus(merchandisePurchasedDec)

      const now = new Date()
      const report: EventClosingReport = {
        closedAt: now.toISOString(),
        income: data.income,
        expenses: {
          operational: data.expenses.operational,
          merchandisePurchased: data.expenses.merchandisePurchased,
          merchandiseConsumed: decToDb(consumedDec),
        },
        leftoverValue: decToDb(leftoverDec),
        netReal: decToDb(netRealDec),
        netProjected: decToDb(netProjectedDec),
        cash:
          data.cash.hasCashSales && cashCounted != null
            ? {
                expected: data.cash.expected,
                counted: decToDb(dec(cashCounted)),
              }
            : null,
        insumos: reportInsumos,
      }

      // Cierre = transición a `closed` sellando las marcas efectivas intermedias (grafo lineal).
      const setPayload: {
        status: EventStatus
        isActive: boolean
        salesOpenedAt?: Date
        wentLiveAt?: Date
        closedAt: Date
        closingReport: EventClosingReport
      } = {
        status: "closed",
        isActive: false,
        closedAt: now,
        closingReport: report,
      }
      let cursor: EventStatus | undefined = from
      while (cursor && cursor !== "closed") {
        const step = outgoingTransition(cursor)
        if (!step) break
        if (step.to === "on_sale" && !ev.salesOpenedAt)
          setPayload.salesOpenedAt = now
        if (step.to === "live" && !ev.wentLiveAt) setPayload.wentLiveAt = now
        cursor = step.to
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
      return c.json({ event: sanitizeEvent(row), report })
    }
  )
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
      slug?: string | null
      designType?: "GLASS" | "MINIMAL"
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
    if (body.slug !== undefined) {
      setPayload.slug = body.slug
    }
    if (body.designType !== undefined) {
      setPayload.designType = body.designType
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
