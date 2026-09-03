import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { and, asc, count, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { pool } from "../db"
import { randomUUID } from "node:crypto"
import {
  barInventory,
  bars,
  digitalConsumptions,
  eventExpenses,
  eventInventory,
  eventProducts,
  events,
  inventoryItems,
  productCategories,
  productRecipes,
  products,
  promoters,
  saleItems,
  sales,
} from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { dec, decFromDb, decToDb } from "../lib/decimal-money"
import {
  bottleLoadStockDelta,
  recipeStockDeduction,
  baseUnitsPerServingFromYield,
  yieldPerPackageFromQuantityUsed,
} from "../lib/inventory-deduction"
import { findOrCreateCustomer } from "../lib/client-checkout"
import { creditBalance, debitBalance, getBalance } from "../lib/balance"
import { emitCommittedStockDeltas } from "../lib/event-stock-broadcast"
import {
  deleteFileByKey,
  keyFromPublicUrl,
  publicUrlForKey,
  uploadFile,
} from "../lib/s3-client"

function requireTenantId(ctx: AuthenticatedContext): string | null {
  const id = ctx.staff.tenantId
  if (id == null || id === "") return null
  return id
}

const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
const PRODUCT_IMAGE_ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
])

function safeProductUploadFilename(name: string): string {
  const base = name
    .replace(/^.*[/\\]/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
  return (base || "image").slice(0, 120)
}

function guessProductImageContentType(file: File, filename: string): string | null {
  const t = file.type?.trim()
  if (t && PRODUCT_IMAGE_ALLOWED_TYPES.has(t)) return t
  const lower = filename.toLowerCase()
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".gif")) return "image/gif"
  return null
}

async function requireProductForTenant(
  db: ReturnType<typeof drizzle>,
  productId: string,
  tenantId: string
): Promise<typeof products.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
    .limit(1)
  return row ?? null
}

async function categoryBelongsToTenant(
  db: ReturnType<typeof drizzle>,
  categoryId: string,
  tenantId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(
      and(
        eq(productCategories.id, categoryId),
        eq(productCategories.tenantId, tenantId),
        eq(productCategories.isActive, true)
      )
    )
    .limit(1)
  return row != null
}

const baseUnitSchema = z.enum(["ML", "GRAMS", "UNIT"])

const upsertItemSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(255),
  /** Unidad contable de la spec 1.4 (botella/lata/bolsa). Es lo único que se pide del insumo nuevo. */
  countingUnit: z.string().min(1).max(50).optional(),
  /** @deprecated modelo viejo; opcional para poder crear insumos "implícitos" solo con nombre+unidad. */
  baseUnit: baseUnitSchema.optional().default("UNIT"),
  packageSize: z
    .union([
      z.number().nonnegative(),
      z.string().regex(/^\d+(\.\d{1,2})?$/),
    ])
    .optional(),
})

const loadBottlesSchema = z
  .object({
    inventoryItemId: z.string().min(1),
    quantityOfBottles: z.coerce.number().int().positive(),
    customContentValue: z
      .union([
        z.coerce.number().positive(),
        z.string().regex(/^\d+(\.\d{1,4})?$/),
      ])
      .optional(),
    eventId: z.string().min(1).optional(),
    barId: z.string().min(1).optional(),
    costType: z.enum(["TOTAL", "UNIT"]).optional(),
    costAmount: z
      .union([
        z.string().regex(/^\d+(\.\d{1,2})?$/),
        z.coerce.number().nonnegative(),
      ])
      .optional(),
  })
  .superRefine((data, ctx) => {
    const hasE = data.eventId != null && data.eventId !== ""
    const hasB = data.barId != null && data.barId !== ""
    if (hasE === hasB) {
      ctx.addIssue({
        code: "custom",
        message: "Indicá exactamente eventId o barId",
        path: ["eventId"],
      })
    }
  })
  .superRefine((data, ctx) => {
    const hasType = data.costType != null
    const hasAmt =
      data.costAmount != null &&
      String(data.costAmount).trim() !== "" &&
      !Number.isNaN(Number(String(data.costAmount).replace(",", ".")))
    if (hasType !== hasAmt) {
      ctx.addIssue({
        code: "custom",
        message: "Completá tipo y monto de costo, o ninguno.",
        path: ["costAmount"],
      })
    }
  })

function totalExpenseFromLoadBottles(
  costType: "TOTAL" | "UNIT" | undefined,
  costAmount: string | number | undefined,
  quantityOfBottles: number
) {
  if (costType == null || costAmount == null) return dec(0)
  const str = String(costAmount).replace(",", ".").trim()
  if (str === "") return dec(0)
  const amt = dec(str)
  if (amt.lte(0)) return dec(0)
  if (costType === "UNIT") return amt.times(quantityOfBottles)
  return amt
}

const recipeLineSchema = z
  .object({
    inventoryItemId: z.string().min(1),
    /**
     * @deprecated Modelo viejo (base units por porción). Opcional: si viene `yieldPerPackage`
     * se deriva solo. Se mantiene para compatibilidad con clientes que aún mandan quantityUsed.
     */
    quantityUsed: z
      .union([z.string().regex(/^\d+(\.\d{1,4})?$/), z.number().positive()])
      .transform((v) => (typeof v === "number" ? String(v) : v))
      .optional(),
    /** Modelo 1.5: cuántas porciones salen de un envase ("10 tragos por botella"). */
    yieldPerPackage: z
      .union([z.string().regex(/^\d+(\.\d{1,3})?$/), z.number().positive()])
      .transform((v) => (typeof v === "number" ? String(v) : v))
      .optional(),
  })
  .refine((r) => r.quantityUsed != null || r.yieldPerPackage != null, {
    message: "La receta necesita quantityUsed o yieldPerPackage.",
  })

type RecipeItemFields = { baseUnit: "ML" | "GRAMS" | "UNIT"; packageSize: string }

/**
 * Compute the two stored recipe values from a submitted line. Keeps legacy `quantityUsed` (used
 * by the runtime stock deduction) and the new `yieldPerPackage` in sync: whichever the client
 * omits is derived from the other using the insumo's counting-unit config.
 */
function resolveRecipeStorage(
  line: { quantityUsed?: string; yieldPerPackage?: string },
  item: RecipeItemFields
): { quantityUsed: string; yieldPerPackage: string } {
  if (line.yieldPerPackage != null) {
    const yld = dec(line.yieldPerPackage)
    const qu =
      line.quantityUsed != null
        ? dec(line.quantityUsed)
        : baseUnitsPerServingFromYield(item, yld)
    return { quantityUsed: decToDb(qu), yieldPerPackage: yld.toFixed(3) }
  }
  const qu = dec(line.quantityUsed!)
  const yld = yieldPerPackageFromQuantityUsed(item, qu)
  return { quantityUsed: decToDb(qu), yieldPerPackage: yld.toFixed(3) }
}

/** yieldPerPackage to expose on read: stored column if present, else derived from quantityUsed. */
function recipeYieldOut(row: {
  quantityUsed: string
  yieldPerPackage: string | null
  inventoryBaseUnit: "ML" | "GRAMS" | "UNIT"
  inventoryPackageSize: string
}): string | null {
  if (row.yieldPerPackage != null) return row.yieldPerPackage
  const yld = yieldPerPackageFromQuantityUsed(
    { baseUnit: row.inventoryBaseUnit, packageSize: row.inventoryPackageSize },
    dec(row.quantityUsed)
  )
  return yld.gt(0) ? yld.toFixed(3) : null
}

const saleTypeSchema = z.enum(["BOTTLE", "GLASS"])

const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  price: z
    .union([z.string().regex(/^\d+(\.\d{1,2})?$/), z.number().nonnegative()])
    .transform((v) => (typeof v === "number" ? v.toFixed(2) : v)),
  saleType: saleTypeSchema.optional().default("GLASS"),
  categoryId: z
    .union([z.string().min(1).max(36), z.null()])
    .optional(),
  recipes: z.array(recipeLineSchema).default([]),
})

const categorySchema = z.object({
  name: z.string().min(1).max(100),
  sortOrder: z.coerce.number().int().optional(),
})

const updateProductSchema = createProductSchema

const createSaleSchema = z.object({
  eventId: z.string().min(1),
  barId: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.string().min(1).max(36).optional()
  ),
  /** Caja: registra la venta aun si el inventario quedó desactualizado o en cero. */
  allowNegativeStock: z.boolean().optional().default(false),
  /** Tarea 6.1 — SALDO: la caja cobra contra el saldo del DNI (requiere `customerDni`). */
  paymentMethod: z.enum(["CASH", "CARD", "MERCADOPAGO", "TRANSFER", "SALDO"]),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.coerce.number().int().positive(),
      })
    )
    .default([]),
  /** Importe de saldo que se cobra junto con los productos. Contablemente se registra como
   * una venta/deposito independiente, pero ambas operaciones se confirman atómicamente. */
  balanceCharge: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.string().min(1).max(20).optional()
  ),
  /** Tarea 5.1 — Venta de caja registrada a nombre del cliente: DNI opcional (identidad del
   * evento, visión §2.0). Si viene, el backend resuelve/persiste el customer y setea `sales.customerId`. */
  customerDni: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.string().min(6).max(20).optional()
  ),
  /** Tarea 5.1 — Nombre del cliente de caja (opcional; se usa al crear un customer nuevo). */
  customerName: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.string().max(255).optional()
  ),
  /** Tarea 9.1 — Promotor que originó la venta (caja/POS); atribución en sales.promoter_id. */
  promoterId: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.string().max(36).optional()
  ),
}).superRefine((data, ctx) => {
  if (data.items.length === 0 && data.balanceCharge == null) {
    ctx.addIssue({
      code: "custom",
      path: ["items"],
      message: "Agregá un producto o una carga de saldo",
    })
  }
  if (data.balanceCharge != null && data.customerDni == null) {
    ctx.addIssue({
      code: "custom",
      path: ["customerDni"],
      message: "Cargar saldo requiere el DNI del cliente",
    })
  }
  if (data.balanceCharge != null && data.paymentMethod === "SALDO") {
    ctx.addIssue({
      code: "custom",
      path: ["paymentMethod"],
      message: "No se puede cargar saldo pagando con saldo",
    })
  }
})

const productListed = or(eq(products.isActive, true), isNull(products.isActive))

function normalizePackageSize(body: z.infer<typeof upsertItemSchema>): string {
  const raw =
    body.packageSize === undefined
      ? "0"
      : typeof body.packageSize === "number"
        ? body.packageSize
        : body.packageSize
  return decToDb(dec(raw))
}

/**
 * Insumos IMPLÍCITOS (spec §2/§4.3, tarea 1.4): un insumo no es una entidad que el usuario
 * administre aparte; nace la primera vez que se lo menciona (en un rendimiento o una compra).
 * Busca por nombre (case-insensitive) dentro del tenant y, si no existe, lo crea con el modelo
 * nuevo: unidad contable + `baseUnit='UNIT'`. Devuelve la fila del insumo. Pensado para reusar
 * desde las rutas de recetas (1.5) y compra de mercadería (1.6).
 */
export async function findOrCreateInventoryItemByName(
  db: ReturnType<typeof drizzle>,
  tenantId: string,
  name: string,
  countingUnit = "unidad"
): Promise<typeof inventoryItems.$inferSelect> {
  const trimmed = name.trim()
  const [existing] = await db
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.tenantId, tenantId),
        sql`LOWER(${inventoryItems.name}) = LOWER(${trimmed})`
      )
    )
    .limit(1)
  if (existing) {
    // Un insumo desactivado que se vuelve a mencionar se reactiva (vuelve a existir).
    if (existing.isActive === false) {
      await db
        .update(inventoryItems)
        .set({ isActive: true })
        .where(eq(inventoryItems.id, existing.id))
      return { ...existing, isActive: true }
    }
    return existing
  }
  const id = uuidv4()
  await db.insert(inventoryItems).values({
    id,
    tenantId,
    name: trimmed,
    countingUnit,
    baseUnit: "UNIT",
    packageSize: "0",
    isActive: true,
  })
  const [row] = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.id, id))
    .limit(1)
  return row!
}

export class InsufficientStockError extends Error {
  constructor(
    message: string,
    public inventoryItemId: string,
    public inventoryItemName: string
  ) {
    super(message)
    this.name = "InsufficientStockError"
  }
}

export const inventoryRoute = new Hono()
  .use("*", authMiddleware)
  .get("/items", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const db = drizzle(pool)
    const rows = await db
      .select()
      .from(inventoryItems)
      .where(
        and(eq(inventoryItems.tenantId, tenantId), eq(inventoryItems.isActive, true))
      )

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      countingUnit: r.countingUnit,
      baseUnit: r.baseUnit,
      packageSize: r.packageSize,
    }))

    return c.json({ items })
  })
  .post("/items", zValidator("json", upsertItemSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const body = c.req.valid("json")
    const db = drizzle(pool)

    if (body.id) {
      const [existing] = await db
        .select()
        .from(inventoryItems)
        .where(
          and(eq(inventoryItems.id, body.id), eq(inventoryItems.tenantId, tenantId))
        )
        .limit(1)
      if (!existing) {
        return c.json({ error: "Ítem no encontrado" }, 404)
      }
      if (existing.isActive === false) {
        return c.json({ error: "El insumo está desactivado." }, 400)
      }
      const pkg = normalizePackageSize(body)
      await db
        .update(inventoryItems)
        .set({
          name: body.name,
          baseUnit: body.baseUnit,
          packageSize: pkg,
          ...(body.countingUnit ? { countingUnit: body.countingUnit } : {}),
        })
        .where(eq(inventoryItems.id, body.id))
      const [row] = await db
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.id, body.id))
        .limit(1)
      return c.json({
        item: {
          id: row!.id,
          name: row!.name,
          countingUnit: row!.countingUnit,
          baseUnit: row!.baseUnit,
          packageSize: row!.packageSize,
        },
      })
    }

    const id = uuidv4()
    const pkg = normalizePackageSize(body)
    await db.insert(inventoryItems).values({
      id,
      tenantId,
      name: body.name,
      countingUnit: body.countingUnit ?? "unidad",
      baseUnit: body.baseUnit,
      packageSize: pkg,
      isActive: true,
    })
    const [row] = await db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.id, id))
      .limit(1)
    return c.json(
      {
        item: {
          id: row!.id,
          name: row!.name,
          countingUnit: row!.countingUnit,
          baseUnit: row!.baseUnit,
          packageSize: row!.packageSize,
        },
      },
      201
    )
  })
  .delete("/items/:id", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const itemId = c.req.param("id")
    const db = drizzle(pool)

    const [item] = await db
      .select()
      .from(inventoryItems)
      .where(
        and(eq(inventoryItems.id, itemId), eq(inventoryItems.tenantId, tenantId))
      )
      .limit(1)
    if (!item) {
      return c.json({ error: "Ítem no encontrado" }, 404)
    }
    if (item.isActive === false) {
      return c.json({ ok: true, deactivated: true })
    }

    const [recipeRow] = await db
      .select({ n: count() })
      .from(productRecipes)
      .innerJoin(products, eq(productRecipes.productId, products.id))
      .where(
        and(
          eq(productRecipes.inventoryItemId, itemId),
          eq(products.tenantId, tenantId),
          productListed
        )
      )

    const nRecipes = Number(recipeRow?.n ?? 0)

    if (nRecipes > 0) {
      return c.json(
        {
          error:
            "No se puede desactivar: el insumo está en la receta de uno o más productos activos. Desactivá esos productos primero.",
        },
        400
      )
    }

    await db
      .update(inventoryItems)
      .set({ isActive: false })
      .where(
        and(eq(inventoryItems.id, itemId), eq(inventoryItems.tenantId, tenantId))
      )

    return c.json({ ok: true, deactivated: true })
  })
  .get("/categories", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const db = drizzle(pool)
    const rows = await db
      .select()
      .from(productCategories)
      .where(
        and(
          eq(productCategories.tenantId, tenantId),
          eq(productCategories.isActive, true)
        )
      )
      .orderBy(asc(productCategories.sortOrder), asc(productCategories.name))

    return c.json({
      categories: rows.map((r) => ({
        id: r.id,
        name: r.name,
        sortOrder: r.sortOrder,
      })),
    })
  })
  .post("/categories", zValidator("json", categorySchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const body = c.req.valid("json")
    const db = drizzle(pool)

    let sortOrder = body.sortOrder
    if (sortOrder == null) {
      const [maxRow] = await db
        .select({ m: sql<number>`coalesce(max(${productCategories.sortOrder}), 0)` })
        .from(productCategories)
        .where(eq(productCategories.tenantId, tenantId))
      sortOrder = Number(maxRow?.m ?? 0) + 1
    }

    const id = uuidv4()
    await db.insert(productCategories).values({
      id,
      tenantId,
      name: body.name.trim(),
      sortOrder,
      isActive: true,
      createdAt: new Date(),
    })

    return c.json(
      { category: { id, name: body.name.trim(), sortOrder } },
      201
    )
  })
  .put("/categories/:id", zValidator("json", categorySchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const categoryId = c.req.param("id")
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const [existing] = await db
      .select()
      .from(productCategories)
      .where(
        and(
          eq(productCategories.id, categoryId),
          eq(productCategories.tenantId, tenantId)
        )
      )
      .limit(1)
    if (!existing) {
      return c.json({ error: "Categoría no encontrada" }, 404)
    }

    await db
      .update(productCategories)
      .set({
        name: body.name.trim(),
        ...(body.sortOrder == null ? {} : { sortOrder: body.sortOrder }),
      })
      .where(eq(productCategories.id, categoryId))

    return c.json({
      category: {
        id: categoryId,
        name: body.name.trim(),
        sortOrder: body.sortOrder ?? existing.sortOrder,
      },
    })
  })
  .delete("/categories/:id", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const categoryId = c.req.param("id")
    const db = drizzle(pool)

    const [existing] = await db
      .select()
      .from(productCategories)
      .where(
        and(
          eq(productCategories.id, categoryId),
          eq(productCategories.tenantId, tenantId)
        )
      )
      .limit(1)
    if (!existing) {
      return c.json({ error: "Categoría no encontrada" }, 404)
    }

    // Desvincular productos y desactivar la categoría (sin borrar productos).
    await db.transaction(async (tx) => {
      await tx
        .update(products)
        .set({ categoryId: null })
        .where(
          and(
            eq(products.categoryId, categoryId),
            eq(products.tenantId, tenantId)
          )
        )
      await tx
        .update(productCategories)
        .set({ isActive: false })
        .where(eq(productCategories.id, categoryId))
    })

    return c.json({ ok: true })
  })
  .get("/products", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const db = drizzle(pool)
    const prods = await db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), productListed))

    if (prods.length === 0) {
      return c.json({ products: [] })
    }

    const pids = prods.map((p) => p.id)
    const recipeRows = await db
      .select({
        id: productRecipes.id,
        productId: productRecipes.productId,
        inventoryItemId: productRecipes.inventoryItemId,
        quantityUsed: productRecipes.quantityUsed,
        yieldPerPackage: productRecipes.yieldPerPackage,
        inventoryName: inventoryItems.name,
        inventoryBaseUnit: inventoryItems.baseUnit,
        inventoryPackageSize: inventoryItems.packageSize,
      })
      .from(productRecipes)
      .innerJoin(
        inventoryItems,
        eq(productRecipes.inventoryItemId, inventoryItems.id)
      )
      .where(
        and(
          inArray(productRecipes.productId, pids),
          eq(inventoryItems.tenantId, tenantId),
          eq(inventoryItems.isActive, true)
        )
      )

    const byProduct = new Map<string, typeof recipeRows>()
    for (const r of recipeRows) {
      const list = byProduct.get(r.productId) ?? []
      list.push(r)
      byProduct.set(r.productId, list)
    }

    return c.json({
      products: prods.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        isActive: p.isActive,
        saleType: p.saleType,
        imageUrl: p.imageUrl ?? null,
        categoryId: p.categoryId ?? null,
        recipes: (byProduct.get(p.id) ?? []).map((r) => ({
          id: r.id,
          inventoryItemId: r.inventoryItemId,
          quantityUsed: r.quantityUsed,
          yieldPerPackage: recipeYieldOut(r),
          inventoryItemName: r.inventoryName,
          inventoryBaseUnit: r.inventoryBaseUnit,
          inventoryPackageSize: r.inventoryPackageSize,
        })),
      })),
    })
  })
  .post("/products", zValidator("json", createProductSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const invIds = [...new Set(body.recipes.map((r) => r.inventoryItemId))]
    const itemFieldsById = new Map<string, RecipeItemFields>()
    if (invIds.length > 0) {
      const invRows = await db
        .select({
          id: inventoryItems.id,
          baseUnit: inventoryItems.baseUnit,
          packageSize: inventoryItems.packageSize,
        })
        .from(inventoryItems)
        .where(
          and(
            inArray(inventoryItems.id, invIds),
            eq(inventoryItems.tenantId, tenantId),
            eq(inventoryItems.isActive, true)
          )
        )
      if (invRows.length !== invIds.length) {
        return c.json(
          { error: "Una o más materias primas no existen o están desactivadas." },
          400
        )
      }
      for (const row of invRows) {
        itemFieldsById.set(row.id, {
          baseUnit: row.baseUnit,
          packageSize: row.packageSize,
        })
      }
    }

    if (body.categoryId != null && !(await categoryBelongsToTenant(db, body.categoryId, tenantId))) {
      return c.json({ error: "La categoría no existe." }, 400)
    }

    const productId = uuidv4()
    const priceStr = decToDb(dec(body.price))

    await db.transaction(async (tx) => {
      await tx.insert(products).values({
        id: productId,
        tenantId,
        name: body.name,
        price: priceStr,
        isActive: true,
        saleType: body.saleType,
        categoryId: body.categoryId ?? null,
      })
      if (body.recipes.length > 0) {
        await tx.insert(productRecipes).values(
          body.recipes.map((r) => {
            const stored = resolveRecipeStorage(
              r,
              itemFieldsById.get(r.inventoryItemId) ?? {
                baseUnit: "UNIT",
                packageSize: "0",
              }
            )
            return {
              id: uuidv4(),
              productId,
              inventoryItemId: r.inventoryItemId,
              quantityUsed: stored.quantityUsed,
              yieldPerPackage: stored.yieldPerPackage,
            }
          })
        )
      }
    })

    const [p] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1)
    const recipes = await db
      .select({
        id: productRecipes.id,
        inventoryItemId: productRecipes.inventoryItemId,
        quantityUsed: productRecipes.quantityUsed,
        yieldPerPackage: productRecipes.yieldPerPackage,
        inventoryName: inventoryItems.name,
        inventoryBaseUnit: inventoryItems.baseUnit,
        inventoryPackageSize: inventoryItems.packageSize,
      })
      .from(productRecipes)
      .innerJoin(
        inventoryItems,
        eq(productRecipes.inventoryItemId, inventoryItems.id)
      )
      .where(eq(productRecipes.productId, productId))

    return c.json(
      {
        product: {
          id: p!.id,
          name: p!.name,
          price: p!.price,
          isActive: p!.isActive,
          saleType: p!.saleType,
          imageUrl: p!.imageUrl ?? null,
          categoryId: p!.categoryId ?? null,
          recipes: recipes.map((r) => ({
            id: r.id,
            inventoryItemId: r.inventoryItemId,
            quantityUsed: r.quantityUsed,
            inventoryItemName: r.inventoryName,
            inventoryBaseUnit: r.inventoryBaseUnit,
            inventoryPackageSize: r.inventoryPackageSize,
          })),
        },
      },
      201
    )
  })
  .put("/products/:id", zValidator("json", updateProductSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const productId = c.req.param("id")
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const [existing] = await db
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .limit(1)
    if (!existing) {
      return c.json({ error: "Producto no encontrado" }, 404)
    }

    const invIds = [...new Set(body.recipes.map((r) => r.inventoryItemId))]
    const itemFieldsById = new Map<string, RecipeItemFields>()
    if (invIds.length > 0) {
      const invRows = await db
        .select({
          id: inventoryItems.id,
          baseUnit: inventoryItems.baseUnit,
          packageSize: inventoryItems.packageSize,
        })
        .from(inventoryItems)
        .where(
          and(
            inArray(inventoryItems.id, invIds),
            eq(inventoryItems.tenantId, tenantId),
            eq(inventoryItems.isActive, true)
          )
        )
      if (invRows.length !== invIds.length) {
        return c.json(
          { error: "Una o más materias primas no existen o están desactivadas." },
          400
        )
      }
      for (const row of invRows) {
        itemFieldsById.set(row.id, {
          baseUnit: row.baseUnit,
          packageSize: row.packageSize,
        })
      }
    }

    if (body.categoryId != null && !(await categoryBelongsToTenant(db, body.categoryId, tenantId))) {
      return c.json({ error: "La categoría no existe." }, 400)
    }

    const priceStr = decToDb(dec(body.price))

    await db.transaction(async (tx) => {
      await tx
        .update(products)
        .set({
          name: body.name,
          price: priceStr,
          saleType: body.saleType,
          categoryId: body.categoryId ?? null,
        })
        .where(eq(products.id, productId))
      await tx.delete(productRecipes).where(eq(productRecipes.productId, productId))
      if (body.recipes.length > 0) {
        await tx.insert(productRecipes).values(
          body.recipes.map((r) => {
            const stored = resolveRecipeStorage(
              r,
              itemFieldsById.get(r.inventoryItemId) ?? {
                baseUnit: "UNIT",
                packageSize: "0",
              }
            )
            return {
              id: uuidv4(),
              productId,
              inventoryItemId: r.inventoryItemId,
              quantityUsed: stored.quantityUsed,
              yieldPerPackage: stored.yieldPerPackage,
            }
          })
        )
      }
    })

    const [p] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1)
    const recipes = await db
      .select({
        id: productRecipes.id,
        inventoryItemId: productRecipes.inventoryItemId,
        quantityUsed: productRecipes.quantityUsed,
        yieldPerPackage: productRecipes.yieldPerPackage,
        inventoryName: inventoryItems.name,
        inventoryBaseUnit: inventoryItems.baseUnit,
        inventoryPackageSize: inventoryItems.packageSize,
      })
      .from(productRecipes)
      .innerJoin(
        inventoryItems,
        eq(productRecipes.inventoryItemId, inventoryItems.id)
      )
      .where(eq(productRecipes.productId, productId))

    return c.json({
      product: {
        id: p!.id,
        name: p!.name,
        price: p!.price,
        isActive: p!.isActive,
        saleType: p!.saleType,
        imageUrl: p!.imageUrl ?? null,
        categoryId: p!.categoryId ?? null,
        recipes: recipes.map((r) => ({
          id: r.id,
          inventoryItemId: r.inventoryItemId,
          quantityUsed: r.quantityUsed,
          yieldPerPackage: recipeYieldOut(r),
          inventoryItemName: r.inventoryName,
          inventoryBaseUnit: r.inventoryBaseUnit,
          inventoryPackageSize: r.inventoryPackageSize,
        })),
      },
    })
  })
  .post("/products/:id/image", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const productId = c.req.param("id")
    const db = drizzle(pool)

    const prod = await requireProductForTenant(db, productId, tenantId)
    if (!prod) {
      return c.json({ error: "Producto no encontrado" }, 404)
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

    if (raw.size > PRODUCT_IMAGE_MAX_BYTES) {
      return c.json({ error: "La imagen no puede superar los 5 MB." }, 400)
    }

    const contentType = guessProductImageContentType(raw, raw.name)
    if (!contentType) {
      return c.json(
        { error: "Formato no permitido. Usá JPEG, PNG, WebP o GIF." },
        400
      )
    }

    const segment = safeProductUploadFilename(raw.name)
    const key = `products/${productId}/${Date.now()}-${segment}`

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

    if (prod.imageUrl) {
      const oldKey = keyFromPublicUrl(prod.imageUrl)
      if (oldKey) {
        try {
          await deleteFileByKey(oldKey)
        } catch {
          /* reemplazo best-effort */
        }
      }
    }

    await db
      .update(products)
      .set({ imageUrl: publicUrl })
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))

    const [p] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1)
    const recipes = await db
      .select({
        id: productRecipes.id,
        inventoryItemId: productRecipes.inventoryItemId,
        quantityUsed: productRecipes.quantityUsed,
        yieldPerPackage: productRecipes.yieldPerPackage,
        inventoryName: inventoryItems.name,
        inventoryBaseUnit: inventoryItems.baseUnit,
        inventoryPackageSize: inventoryItems.packageSize,
      })
      .from(productRecipes)
      .innerJoin(
        inventoryItems,
        eq(productRecipes.inventoryItemId, inventoryItems.id)
      )
      .where(eq(productRecipes.productId, productId))

    return c.json({
      product: {
        id: p!.id,
        name: p!.name,
        price: p!.price,
        isActive: p!.isActive,
        saleType: p!.saleType,
        imageUrl: p!.imageUrl ?? null,
        categoryId: p!.categoryId ?? null,
        recipes: recipes.map((r) => ({
          id: r.id,
          inventoryItemId: r.inventoryItemId,
          quantityUsed: r.quantityUsed,
          yieldPerPackage: recipeYieldOut(r),
          inventoryItemName: r.inventoryName,
          inventoryBaseUnit: r.inventoryBaseUnit,
          inventoryPackageSize: r.inventoryPackageSize,
        })),
      },
    })
  })
  .delete("/products/:id/image", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const productId = c.req.param("id")
    const db = drizzle(pool)

    const prod = await requireProductForTenant(db, productId, tenantId)
    if (!prod) {
      return c.json({ error: "Producto no encontrado" }, 404)
    }

    if (prod.imageUrl) {
      const oldKey = keyFromPublicUrl(prod.imageUrl)
      if (oldKey) {
        try {
          await deleteFileByKey(oldKey)
        } catch {
          /* seguimos limpiando la DB */
        }
      }
    }

    await db
      .update(products)
      .set({ imageUrl: null })
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))

    const [p] = await db
      .select()
      .from(products)
      .where(eq(products.id, productId))
      .limit(1)
    const recipes = await db
      .select({
        id: productRecipes.id,
        inventoryItemId: productRecipes.inventoryItemId,
        quantityUsed: productRecipes.quantityUsed,
        yieldPerPackage: productRecipes.yieldPerPackage,
        inventoryName: inventoryItems.name,
        inventoryBaseUnit: inventoryItems.baseUnit,
        inventoryPackageSize: inventoryItems.packageSize,
      })
      .from(productRecipes)
      .innerJoin(
        inventoryItems,
        eq(productRecipes.inventoryItemId, inventoryItems.id)
      )
      .where(eq(productRecipes.productId, productId))

    return c.json({
      product: {
        id: p!.id,
        name: p!.name,
        price: p!.price,
        isActive: p!.isActive,
        saleType: p!.saleType,
        imageUrl: p!.imageUrl ?? null,
        categoryId: p!.categoryId ?? null,
        recipes: recipes.map((r) => ({
          id: r.id,
          inventoryItemId: r.inventoryItemId,
          quantityUsed: r.quantityUsed,
          yieldPerPackage: recipeYieldOut(r),
          inventoryItemName: r.inventoryName,
          inventoryBaseUnit: r.inventoryBaseUnit,
          inventoryPackageSize: r.inventoryPackageSize,
        })),
      },
    })
  })
  .delete("/products/:id", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const productId = c.req.param("id")
    const db = drizzle(pool)

    const [existing] = await db
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .limit(1)
    if (!existing) {
      return c.json({ error: "Producto no encontrado" }, 404)
    }

    await db
      .update(products)
      .set({ isActive: false })
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))

    return c.json({
      ok: true,
      deactivated: true,
      message: "Producto desactivado.",
    })
  })
  .post("/load-bottles", zValidator("json", loadBottlesSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const [item] = await db
      .select()
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.id, body.inventoryItemId),
          eq(inventoryItems.tenantId, tenantId)
        )
      )
      .limit(1)
    if (!item) {
      return c.json({ error: "Ítem de inventario no encontrado" }, 404)
    }
    if (item.isActive === false) {
      return c.json({ error: "El insumo está desactivado." }, 400)
    }

    const customStr =
      body.customContentValue === undefined
        ? null
        : typeof body.customContentValue === "number"
          ? decToDb(dec(body.customContentValue))
          : decToDb(dec(String(body.customContentValue).replace(",", ".")))

    const { delta, error: deltaErr } = bottleLoadStockDelta(
      item,
      body.quantityOfBottles,
      customStr
    )
    if (deltaErr) {
      return c.json({ error: deltaErr }, 400)
    }
    if (!delta.gt(0)) {
      return c.json({ error: "La cantidad a sumar debe ser mayor que 0" }, 400)
    }

    const deltaStr = decToDb(delta)
    const totalExpense = totalExpenseFromLoadBottles(
      body.costType,
      body.costAmount,
      body.quantityOfBottles
    )

    const result = await db.transaction(async (tx) => {
      if (body.eventId) {
        const [ev] = await tx
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, body.eventId), eq(events.tenantId, tenantId)))
          .limit(1)
        if (!ev) {
          return { kind: "bad_event" as const }
        }

        const [evInv] = await tx
          .select()
          .from(eventInventory)
          .where(
            and(
              eq(eventInventory.eventId, body.eventId),
              eq(eventInventory.inventoryItemId, body.inventoryItemId),
              eq(eventInventory.tenantId, tenantId)
            )
          )
          .limit(1)

        const next = (evInv ? decFromDb(evInv.stockAllocated) : dec(0)).plus(delta)
        await tx
          .insert(eventInventory)
          .values({
            id: uuidv4(),
            eventId: body.eventId,
            inventoryItemId: body.inventoryItemId,
            tenantId,
            stockAllocated: decToDb(next),
            createdAt: new Date(),
          })
          .onDuplicateKeyUpdate({
            set: { stockAllocated: decToDb(next) },
          })

        if (totalExpense.gt(0)) {
          await tx.insert(eventExpenses).values({
            id: uuidv4(),
            eventId: body.eventId,
            tenantId,
            description: `Compra de stock: ${body.quantityOfBottles} botellas de ${item.name}`.slice(0, 255),
            category: "FOOD",
            amount: decToDb(totalExpense),
            date: new Date(),
          })
        }

        return {
          kind: "event_ok" as const,
          next,
          outEventId: body.eventId,
        }
      }

      const barId = body.barId!
      const [bar] = await tx
        .select()
        .from(bars)
        .where(and(eq(bars.id, barId), eq(bars.tenantId, tenantId)))
        .limit(1)
      if (!bar) {
        return { kind: "bad_bar" as const }
      }

      const [evInv] = await tx
        .select()
        .from(eventInventory)
        .where(
          and(
            eq(eventInventory.eventId, bar.eventId),
            eq(eventInventory.inventoryItemId, body.inventoryItemId),
            eq(eventInventory.tenantId, tenantId)
          )
        )
        .limit(1)
      const cap = evInv ? decFromDb(evInv.stockAllocated) : dec(0)

      const [bRow] = await tx
        .select()
        .from(barInventory)
        .where(
          and(
            eq(barInventory.barId, barId),
            eq(barInventory.inventoryItemId, body.inventoryItemId),
            eq(barInventory.tenantId, tenantId)
          )
        )
        .limit(1)
      const curBar = bRow ? decFromDb(bRow.currentStock) : dec(0)
      const nextBar = curBar.plus(delta)

      const [sumOthersRow] = await tx
        .select({
          s: sql<string>`coalesce(sum(cast(${barInventory.currentStock} as decimal(14,2))), 0)`,
        })
        .from(barInventory)
        .innerJoin(bars, eq(barInventory.barId, bars.id))
        .where(
          and(
            eq(bars.eventId, bar.eventId),
            eq(bars.tenantId, tenantId),
            eq(barInventory.tenantId, tenantId),
            eq(barInventory.inventoryItemId, body.inventoryItemId),
            ne(barInventory.barId, barId)
          )
        )

      const others = decFromDb(sumOthersRow?.s ?? "0")
      if (others.plus(nextBar).gt(cap)) {
        return { kind: "bar_cap" as const }
      }

      if (bRow) {
        await tx
          .update(barInventory)
          .set({ currentStock: decToDb(nextBar) })
          .where(
            and(eq(barInventory.id, bRow.id), eq(barInventory.tenantId, tenantId))
          )
      } else {
        await tx.insert(barInventory).values({
          id: uuidv4(),
          barId,
          inventoryItemId: body.inventoryItemId,
          tenantId,
          currentStock: decToDb(nextBar),
        })
      }

      if (totalExpense.gt(0)) {
        await tx.insert(eventExpenses).values({
          id: uuidv4(),
          eventId: bar.eventId,
          tenantId,
          description: `Compra de stock: ${body.quantityOfBottles} botellas de ${item.name}`.slice(0, 255),
          category: "FOOD",
          amount: decToDb(totalExpense),
          date: new Date(),
        })
      }

      return {
        kind: "bar_ok" as const,
        nextBar,
        outEventId: bar.eventId,
        outBarId: barId,
      }
    })

    if (result.kind === "bad_event") {
      return c.json({ error: "Evento no encontrado" }, 404)
    }
    if (result.kind === "bad_bar") {
      return c.json({ error: "Barra no encontrada" }, 404)
    }
    if (result.kind === "bar_cap") {
      return c.json(
        {
          error:
            "El stock en barras no puede superar el stock asignado al evento para este insumo.",
        },
        400
      )
    }

    if (result.kind === "event_ok") {
      void emitCommittedStockDeltas(tenantId, result.outEventId, {
        eventItemIds: [body.inventoryItemId],
      })
      return c.json({
        ok: true,
        stockAdded: deltaStr,
        stockAllocated: decToDb(result.next),
      })
    }

    void emitCommittedStockDeltas(tenantId, result.outEventId, {
      barDeltas: { barId: result.outBarId, itemIds: [body.inventoryItemId] },
    })
    return c.json({
      ok: true,
      stockAdded: deltaStr,
      currentStock: decToDb(result.nextBar),
    })
  })
  .post("/sales", zValidator("json", createSaleSchema), async (c) => {
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
          .where(
            and(eq(events.id, body.eventId), eq(events.tenantId, tenantId))
          )
          .limit(1)
        if (!ev) {
          return { kind: "bad_event" as const }
        }

        let saleBarId: string | null = null
        if (body.barId != null && body.barId !== "") {
          const [barRow] = await tx
            .select({ id: bars.id })
            .from(bars)
            .where(
              and(
                eq(bars.id, body.barId),
                eq(bars.eventId, body.eventId),
                eq(bars.tenantId, tenantId)
              )
            )
            .limit(1)
          if (!barRow) {
            return { kind: "bad_bar" as const }
          }
          saleBarId = barRow.id
        }

        const productIds = [...new Set(body.items.map((i) => i.productId))]
        const prodRows =
          productIds.length === 0
            ? []
            : await tx
                .select()
                .from(products)
                .where(
                  and(inArray(products.id, productIds), eq(products.tenantId, tenantId))
                )
        if (prodRows.length !== productIds.length) {
          return { kind: "bad_product" as const }
        }

        const inactive = prodRows.find((p) => p.isActive === false)
        if (inactive) {
          return { kind: "inactive_product" as const, name: inactive.name }
        }

        let total = dec(0)
        for (const line of body.items) {
          const p = prodRows.find((x) => x.id === line.productId)!
          total = total.plus(decFromDb(p.price).times(line.quantity))
        }

        let balanceCharge = dec(0)
        if (body.balanceCharge != null) {
          try {
            balanceCharge = dec(body.balanceCharge)
          } catch {
            return { kind: "invalid_balance_charge" as const }
          }
          if (balanceCharge.isNaN() || !balanceCharge.isFinite() || balanceCharge.lte(0)) {
            return { kind: "invalid_balance_charge" as const }
          }
        }

        const recipeRows =
          productIds.length === 0
            ? []
            : await tx
                .select()
                .from(productRecipes)
                .where(inArray(productRecipes.productId, productIds))

        const recipeInvIds = [...new Set(recipeRows.map((r) => r.inventoryItemId))]
        const invForRecipes =
          recipeInvIds.length === 0
            ? []
            : await tx
                .select()
                .from(inventoryItems)
                .where(
                  and(
                    inArray(inventoryItems.id, recipeInvIds),
                    eq(inventoryItems.tenantId, tenantId)
                  )
                )
        const invById = new Map(invForRecipes.map((i) => [i.id, i]))

        const needs = new Map<string, ReturnType<typeof dec>>()
        for (const line of body.items) {
          const p = prodRows.find((x) => x.id === line.productId)!
          const saleType = p.saleType
          const lines = recipeRows.filter((r) => r.productId === line.productId)
          for (const r of lines) {
            const item = invById.get(r.inventoryItemId)
            if (!item) continue
            const add = recipeStockDeduction(
              r.quantityUsed,
              line.quantity,
              saleType,
              item
            )
            const prev = needs.get(r.inventoryItemId) ?? dec(0)
            needs.set(r.inventoryItemId, prev.plus(add))
          }
        }

        // Products without recipes: check directStock if set on eventProducts
        const productsWithRecipes = new Set(recipeRows.map((r) => r.productId))
        const directNeeds = new Map<string, number>()
        for (const line of body.items) {
          if (!productsWithRecipes.has(line.productId)) {
            directNeeds.set(line.productId, (directNeeds.get(line.productId) ?? 0) + line.quantity)
          }
        }

        type EpStockEntry = { rowId: string; stock: string }
        const epStockByProductId = new Map<string, EpStockEntry>()
        if (directNeeds.size > 0) {
          const epRows = await tx
            .select({
              id: eventProducts.id,
              productId: eventProducts.productId,
              directStock: eventProducts.directStock,
            })
            .from(eventProducts)
            .where(
              and(
                eq(eventProducts.eventId, body.eventId),
                eq(eventProducts.tenantId, tenantId),
                inArray(eventProducts.productId, [...directNeeds.keys()])
              )
            )

          for (const ep of epRows) {
            if (ep.directStock != null) {
              epStockByProductId.set(ep.productId, { rowId: ep.id, stock: String(ep.directStock) })
            }
          }

          for (const [productId, qty] of directNeeds.entries()) {
            const entry = epStockByProductId.get(productId)
            if (!entry) continue // null directStock = unlimited
            const avail = decFromDb(entry.stock)
            if (!body.allowNegativeStock && avail.lt(dec(qty))) {
              const prod = prodRows.find((p) => p.id === productId)!
              return { kind: "insufficient_direct_stock" as const, productName: prod.name }
            }
          }
        }

        let evInvByItem = new Map<string, typeof eventInventory.$inferSelect>()
        let invMetaById = new Map<
          string,
          { id: string; name: string }
        >()
        let barRowByInv = new Map<string, typeof barInventory.$inferSelect>()
        let sumBarsByInv = new Map<string, ReturnType<typeof dec>>()
        if (needs.size > 0) {
          const invIds = [...needs.keys()]
          const invRowsSnapshot = await tx
            .select({
              id: inventoryItems.id,
              name: inventoryItems.name,
            })
            .from(inventoryItems)
            .where(
              and(
                inArray(inventoryItems.id, invIds),
                eq(inventoryItems.tenantId, tenantId)
              )
            )
          if (invRowsSnapshot.length !== invIds.length) {
            return { kind: "bad_inventory" as const }
          }
          for (const r of invRowsSnapshot) {
            invMetaById.set(r.id, r)
          }

          const evInvRows = await tx
            .select()
            .from(eventInventory)
            .where(
              and(
                eq(eventInventory.eventId, body.eventId),
                eq(eventInventory.tenantId, tenantId),
                inArray(eventInventory.inventoryItemId, invIds)
              )
            )
          evInvByItem = new Map(evInvRows.map((r) => [r.inventoryItemId, r]))

          barRowByInv = new Map()
          sumBarsByInv = new Map()
          if (saleBarId) {
            for (const invId of invIds) {
              const [sumR] = await tx
                .select({
                  s: sql<string>`coalesce(sum(cast(${barInventory.currentStock} as decimal(14,2))), 0)`,
                })
                .from(barInventory)
                .innerJoin(bars, eq(barInventory.barId, bars.id))
                .where(
                  and(
                    eq(bars.eventId, body.eventId),
                    eq(bars.tenantId, tenantId),
                    eq(barInventory.tenantId, tenantId),
                    eq(barInventory.inventoryItemId, invId)
                  )
                )
              sumBarsByInv.set(
                invId,
                decFromDb(sumR?.s ?? "0")
              )
              const [br] = await tx
                .select()
                .from(barInventory)
                .where(
                  and(
                    eq(barInventory.barId, saleBarId),
                    eq(barInventory.inventoryItemId, invId),
                    eq(barInventory.tenantId, tenantId)
                  )
                )
                .limit(1)
              if (br) barRowByInv.set(invId, br)
            }
          }

          if (!body.allowNegativeStock) {
            for (const [invId, need] of Array.from(needs.entries())) {
              const evRow = evInvByItem.get(invId)
              const cap = evRow ? decFromDb(evRow.stockAllocated) : dec(0)
              if (!saleBarId) {
                if (cap.lt(need)) {
                  const meta = invMetaById.get(invId)!
                  throw new InsufficientStockError(
                    "Stock insuficiente",
                    meta.id,
                    meta.name
                  )
                }
              } else {
                const sumAll = sumBarsByInv.get(invId) ?? dec(0)
                const bRow = barRowByInv.get(invId)
                const barAvail = bRow ? decFromDb(bRow.currentStock) : dec(0)
                const unalloc = cap.minus(sumAll)
                if (need.gt(barAvail.plus(unalloc))) {
                  const meta = invMetaById.get(invId)!
                  throw new InsufficientStockError(
                    "Stock insuficiente",
                    meta.id,
                    meta.name
                  )
                }
              }
            }
          }
        }

        // Tarea 5.1 — Venta de caja con DNI: resolver/persistir el customer (upsert por DNI,
        // mismo criterio que el checkout web). Sin DNI la venta queda anónima como hoy.
        let customerId: string | null = null
        if (body.customerDni != null) {
          customerId = await findOrCreateCustomer(tx, {
            name: body.customerName?.trim() || "Cliente de caja",
            email: "",
            phone: "",
            dni: body.customerDni,
          })
        }

        // Tarea 9.1 — El promotor debe pertenecer al tenant (aislamiento multi-tenant); si no,
        // la venta se rechaza igual que un producto o una barra ajenos.
        let promoterId: string | null = null
        if (body.promoterId != null) {
          const [promo] = await tx
            .select({ id: promoters.id })
            .from(promoters)
            .where(
              and(
                eq(promoters.id, body.promoterId),
                eq(promoters.tenantId, tenantId)
              )
            )
            .limit(1)
          if (!promo) {
            return { kind: "bad_promoter" as const }
          }
          promoterId = promo.id
        }

        // Tarea 6.1 — Cobro con saldo (visión §2.7: "da el DNI y le dan el ticket"): el saldo
        // está atado al DNI, así que el cobro con saldo lo exige. Se verifica antes de crear la
        // sale; el débito va después de insertarla (el movimiento CONSUMO la referencia).
        let balanceAfter: string | null = null
        if (body.paymentMethod === "SALDO") {
          if (body.customerDni == null || customerId == null) {
            return { kind: "saldo_requires_dni" as const }
          }
          const balance = dec(await getBalance(tx, customerId, body.eventId))
          if (balance.lt(total)) {
            return { kind: "insufficient_balance" as const }
          }
        }

        const productSaleId = body.items.length > 0 ? uuidv4() : null
        // Tarea 5.2 — El token del recibo se devuelve en la respuesta: el ticket impreso en caja
        // lleva el comprobante y los QRs de las consumiciones para canjear en barra.
        const productReceiptToken = productSaleId ? randomUUID() : null
        if (productSaleId != null) await tx.insert(sales).values({
          id: productSaleId,
          eventId: body.eventId,
          tenantId,
          barId: saleBarId,
          staffId: ctx.staff.id,
          customerId,
          promoterId,
          receiptToken: productReceiptToken!,
          totalAmount: decToDb(total),
          paymentMethod: body.paymentMethod,
          status: "COMPLETED",
          createdAt: new Date(),
        })

        for (const line of body.items) {
          const p = prodRows.find((x) => x.id === line.productId)!
          await tx.insert(saleItems).values({
            id: uuidv4(),
            saleId: productSaleId!,
            productId: line.productId,
            quantity: line.quantity,
            priceAtTime: p.price,
          })
        }

        // Tarea 5.2 — Cada item de la venta genera UNA consumición canjeable (QR). Se acumulan
        // los hashes en la respuesta para que la caja imprima el ticket con sus QRs y la barra
        // los canjee con el `redeem` existente (escáner lee el hash crudo).
        const printedConsumptions: { productName: string; qrHash: string }[] = []
        for (const line of body.items) {
          const p = prodRows.find((x) => x.id === line.productId)!
          for (let u = 0; u < line.quantity; u++) {
            const qrHash = randomUUID()
            await tx.insert(digitalConsumptions).values({
              id: uuidv4(),
              // Tarea 5.1 — La consumición queda a nombre del cliente cuando la venta lo tiene
              // (visión §2.7: "todo queda registrado a nombre de esa persona").
              customerId,
              eventId: body.eventId,
              tenantId,
              productId: line.productId,
              saleId: productSaleId!,
              qrHash,
              status: "PENDING",
              createdAt: new Date(),
            })
            printedConsumptions.push({ productName: p.name, qrHash })
          }
        }

        // Tarea 6.1 — El saldo se debita con la sale ya insertada (el movimiento CONSUMO la
        // referencia). El chequeo de fondos se hizo arriba; si algo cambió en el medio,
        // `debitBalance` lanza BALANCE_INSUFFICIENT y la transacción entera se aborta.
        if (body.paymentMethod === "SALDO" && customerId != null) {
          balanceAfter = await debitBalance(tx, {
            customerId,
            eventId: body.eventId,
            tenantId,
            amount: decToDb(total),
            staffId: ctx.staff.id,
            saleId: productSaleId!,
            note: "Venta de caja con saldo",
          })
        }

        // La carga conserva su venta POS y movimiento de saldo propios, igual que una carga
        // aislada. Al estar dentro de esta transacción se confirma junto a los productos.
        let depositSaleId: string | null = null
        let depositReceiptToken: string | null = null
        if (balanceCharge.gt(0) && customerId != null) {
          depositSaleId = uuidv4()
          depositReceiptToken = randomUUID()
          await tx.insert(sales).values({
            id: depositSaleId,
            eventId: body.eventId,
            tenantId,
            staffId: ctx.staff.id,
            customerId,
            receiptToken: depositReceiptToken,
            source: "POS",
            totalAmount: decToDb(balanceCharge),
            paymentMethod: body.paymentMethod,
            status: "COMPLETED",
            guestCheckoutSnapshot: {
              kind: "deposit",
              ticketLines: [],
              drinkLines: [],
              contact: {
                name: body.customerName?.trim() || "Cliente de caja",
                email: "",
                phone: "",
                dni: body.customerDni,
              },
            },
            createdAt: new Date(),
          })
          balanceAfter = await creditBalance(tx, {
            customerId,
            eventId: body.eventId,
            tenantId,
            amount: decToDb(balanceCharge),
            type: "CAJA",
            paymentMethod: body.paymentMethod,
            staffId: ctx.staff.id,
            saleId: depositSaleId,
            note: "Carga de saldo junto a venta de caja",
          })
        }

        if (needs.size > 0) {
          for (const [invId, need] of Array.from(needs.entries())) {
            if (!need.gt(dec(0))) continue
            const evRow = evInvByItem.get(invId)
            // Si aún no se cargó este insumo en el evento, la venta de caja se
            // registra igual y queda como diferencia a regularizar en inventario.
            if (!evRow) continue
            const cap = decFromDb(evRow.stockAllocated)
            const newCap = cap.minus(need)
            await tx
              .update(eventInventory)
              .set({ stockAllocated: decToDb(newCap) })
              .where(
                and(
                  eq(eventInventory.id, evRow.id),
                  eq(eventInventory.tenantId, tenantId)
                )
              )

            if (saleBarId) {
              const bRow = barRowByInv.get(invId)
              const barAvail = bRow ? decFromDb(bRow.currentStock) : dec(0)
              const fromBar = need.lte(barAvail) ? need : barAvail
              if (bRow && fromBar.gt(0)) {
                const newBar = barAvail.minus(fromBar)
                await tx
                  .update(barInventory)
                  .set({ currentStock: decToDb(newBar) })
                  .where(
                    and(
                      eq(barInventory.id, bRow.id),
                      eq(barInventory.tenantId, tenantId)
                    )
                  )
              }
            }
          }
        }

        // Deduct directStock for products without recipes
        for (const [productId, qty] of directNeeds.entries()) {
          const entry = epStockByProductId.get(productId)
          if (!entry) continue
          const newStock = decFromDb(entry.stock).minus(dec(qty))
          await tx
            .update(eventProducts)
            .set({ directStock: decToDb(newStock) })
            .where(eq(eventProducts.id, entry.rowId))
        }

        return {
          kind: "ok" as const,
          saleId: productSaleId ?? depositSaleId!,
          receiptToken: productReceiptToken ?? depositReceiptToken!,
          totalAmount: decToDb(total.plus(balanceCharge)),
          productTotalAmount: decToDb(total),
          eventId: body.eventId,
          barId: saleBarId,
          customerId,
          consumptions: printedConsumptions,
          inventoryItemIds:
            needs.size > 0 ? [...needs.keys()] : ([] as string[]),
          ...(depositSaleId != null
            ? { depositSaleId, balanceCharge: decToDb(balanceCharge) }
            : {}),
          ...(balanceAfter != null ? { balance: balanceAfter } : {}),
        }
      })

      if (result.kind === "bad_event") {
        return c.json({ error: "Evento no encontrado" }, 404)
      }
      if (result.kind === "bad_bar") {
        return c.json({ error: "Barra no válida para este evento" }, 400)
      }
      if (result.kind === "bad_promoter") {
        return c.json({ error: "Promotor no válido para esta venta" }, 400)
      }
      if (result.kind === "bad_product") {
        return c.json({ error: "Uno o más productos no son válidos." }, 400)
      }
      if (result.kind === "inactive_product") {
        return c.json(
          { error: `Producto inactivo: ${result.name}` },
          400
        )
      }
      if (result.kind === "bad_inventory") {
        return c.json({ error: "Error al verificar inventario." }, 400)
      }
      if (result.kind === "invalid_balance_charge") {
        return c.json({ error: "Monto de carga de saldo inválido" }, 400)
      }
      if (result.kind === "saldo_requires_dni") {
        return c.json(
          { error: "Cobrar con saldo requiere el DNI del cliente" },
          400
        )
      }
      if (result.kind === "insufficient_balance") {
        return c.json({ error: "Saldo insuficiente para esta venta" }, 400)
      }
      if (result.kind === "insufficient_direct_stock") {
        return c.json(
          { error: `Stock insuficiente: ${result.productName}` },
          409
        )
      }

      if (
        result.kind === "ok" &&
        result.inventoryItemIds.length > 0
      ) {
        void emitCommittedStockDeltas(tenantId, result.eventId, {
          eventItemIds: result.inventoryItemIds,
          ...(result.barId
            ? {
                barDeltas: {
                  barId: result.barId,
                  itemIds: result.inventoryItemIds,
                },
              }
            : {}),
        })
      }

      return c.json(
        {
          message: "Venta registrada",
          saleId: result.saleId,
          // Tarea 5.2 — Token del recibo y QRs canjeables de la venta para el ticket impreso.
          receiptToken: result.receiptToken,
          totalAmount: result.totalAmount,
          customerId: result.customerId,
          consumptions: result.consumptions,
        },
        201
      )
    } catch (e) {
      if (e instanceof InsufficientStockError) {
        return c.json(
          {
            error: `Stock insuficiente: ${e.inventoryItemName}`,
            inventoryItemId: e.inventoryItemId,
          },
          409
        )
      }
      throw e
    }
  })
