import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { and, count, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { pool } from "../db"
import { randomUUID } from "node:crypto"
import {
  barInventory,
  bars,
  digitalConsumptions,
  eventInventory,
  events,
  inventoryItems,
  productRecipes,
  products,
  saleItems,
  sales,
} from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { dec, decFromDb, decToDb } from "../lib/decimal-money"
import {
  bottleLoadStockDelta,
  recipeStockDeduction,
} from "../lib/inventory-deduction"
import { emitCommittedStockDeltas } from "../lib/event-stock-broadcast"

function requireTenantId(ctx: AuthenticatedContext): string | null {
  const id = ctx.staff.tenantId
  if (id == null || id === "") return null
  return id
}

const baseUnitSchema = z.enum(["ML", "GRAMS", "UNIT"])

const upsertItemSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(255),
  baseUnit: baseUnitSchema,
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

const recipeLineSchema = z.object({
  inventoryItemId: z.string().min(1),
  quantityUsed: z
    .union([z.string().regex(/^\d+(\.\d{1,4})?$/), z.number().positive()])
    .transform((v) => (typeof v === "number" ? String(v) : v)),
})

const saleTypeSchema = z.enum(["BOTTLE", "GLASS"])

const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  price: z
    .union([z.string().regex(/^\d+(\.\d{1,2})?$/), z.number().nonnegative()])
    .transform((v) => (typeof v === "number" ? v.toFixed(2) : v)),
  saleType: saleTypeSchema.optional().default("GLASS"),
  recipes: z.array(recipeLineSchema).default([]),
})

const updateProductSchema = createProductSchema

const createSaleSchema = z.object({
  eventId: z.string().min(1),
  barId: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.string().min(1).max(36).optional()
  ),
  paymentMethod: z.enum(["CASH", "CARD", "MERCADOPAGO", "TRANSFER"]),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.coerce.number().int().positive(),
      })
    )
    .min(1),
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
        recipes: (byProduct.get(p.id) ?? []).map((r) => ({
          id: r.id,
          inventoryItemId: r.inventoryItemId,
          quantityUsed: r.quantityUsed,
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
    if (invIds.length > 0) {
      const invRows = await db
        .select({ id: inventoryItems.id })
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
      })
      if (body.recipes.length > 0) {
        await tx.insert(productRecipes).values(
          body.recipes.map((r) => ({
            id: uuidv4(),
            productId,
            inventoryItemId: r.inventoryItemId,
            quantityUsed: decToDb(dec(r.quantityUsed)),
          }))
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
    if (invIds.length > 0) {
      const invRows = await db
        .select({ id: inventoryItems.id })
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
    }

    const priceStr = decToDb(dec(body.price))

    await db.transaction(async (tx) => {
      await tx
        .update(products)
        .set({ name: body.name, price: priceStr, saleType: body.saleType })
        .where(eq(products.id, productId))
      await tx.delete(productRecipes).where(eq(productRecipes.productId, productId))
      if (body.recipes.length > 0) {
        await tx.insert(productRecipes).values(
          body.recipes.map((r) => ({
            id: uuidv4(),
            productId,
            inventoryItemId: r.inventoryItemId,
            quantityUsed: decToDb(dec(r.quantityUsed)),
          }))
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
        recipes: recipes.map((r) => ({
          id: r.id,
          inventoryItemId: r.inventoryItemId,
          quantityUsed: r.quantityUsed,
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

    if (body.eventId) {
      const [ev] = await db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.id, body.eventId), eq(events.tenantId, tenantId)))
        .limit(1)
      if (!ev) {
        return c.json({ error: "Evento no encontrado" }, 404)
      }

      const [evInv] = await db
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
      await db
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

      void emitCommittedStockDeltas(tenantId, body.eventId, {
        eventItemIds: [body.inventoryItemId],
      })

      return c.json({
        ok: true,
        stockAdded: deltaStr,
        stockAllocated: decToDb(next),
      })
    }

    const barId = body.barId!
    const [bar] = await db
      .select()
      .from(bars)
      .where(and(eq(bars.id, barId), eq(bars.tenantId, tenantId)))
      .limit(1)
    if (!bar) {
      return c.json({ error: "Barra no encontrada" }, 404)
    }

    const [evInv] = await db
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

    const [bRow] = await db
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

    const [sumOthersRow] = await db
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
      return c.json(
        {
          error:
            "El stock en barras no puede superar el stock asignado al evento para este insumo.",
        },
        400
      )
    }

    if (bRow) {
      await db
        .update(barInventory)
        .set({ currentStock: decToDb(nextBar) })
        .where(
          and(eq(barInventory.id, bRow.id), eq(barInventory.tenantId, tenantId))
        )
    } else {
      await db.insert(barInventory).values({
        id: uuidv4(),
        barId,
        inventoryItemId: body.inventoryItemId,
        tenantId,
        currentStock: decToDb(nextBar),
      })
    }

    void emitCommittedStockDeltas(tenantId, bar.eventId, {
      barDeltas: { barId, itemIds: [body.inventoryItemId] },
    })

    return c.json({
      ok: true,
      stockAdded: deltaStr,
      currentStock: decToDb(nextBar),
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
        const prodRows = await tx
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

        const recipeRows = await tx
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

        let evInvByItem = new Map<string, typeof eventInventory.$inferSelect>()
        let invMetaById = new Map<
          string,
          { id: string; name: string }
        >()
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

          for (const [invId, need] of needs) {
            const evRow = evInvByItem.get(invId)
            const avail = evRow ? decFromDb(evRow.stockAllocated) : dec(0)
            if (avail.lt(need)) {
              const meta = invMetaById.get(invId)!
              throw new InsufficientStockError(
                "Stock insuficiente",
                meta.id,
                meta.name
              )
            }
          }
        }

        const saleId = uuidv4()
        await tx.insert(sales).values({
          id: saleId,
          eventId: body.eventId,
          tenantId,
          barId: saleBarId,
          staffId: ctx.staff.id,
          receiptToken: randomUUID(),
          totalAmount: decToDb(total),
          paymentMethod: body.paymentMethod,
          status: "COMPLETED",
          createdAt: new Date(),
        })

        for (const line of body.items) {
          const p = prodRows.find((x) => x.id === line.productId)!
          await tx.insert(saleItems).values({
            id: uuidv4(),
            saleId,
            productId: line.productId,
            quantity: line.quantity,
            priceAtTime: p.price,
          })
        }

        for (const line of body.items) {
          for (let u = 0; u < line.quantity; u++) {
            await tx.insert(digitalConsumptions).values({
              id: uuidv4(),
              customerId: null,
              eventId: body.eventId,
              tenantId,
              productId: line.productId,
              saleId,
              qrHash: randomUUID(),
              status: "PENDING",
              createdAt: new Date(),
            })
          }
        }

        if (needs.size > 0) {
          for (const [invId, need] of needs) {
            if (!need.gt(dec(0))) continue
            const evRow = evInvByItem.get(invId)!
            const next = decFromDb(evRow.stockAllocated).minus(need)
            await tx
              .update(eventInventory)
              .set({ stockAllocated: decToDb(next) })
              .where(eq(eventInventory.id, evRow.id))
          }
        }

        return {
          kind: "ok" as const,
          saleId,
          totalAmount: decToDb(total),
          eventId: body.eventId,
          inventoryItemIds:
            needs.size > 0 ? [...needs.keys()] : ([] as string[]),
        }
      })

      if (result.kind === "bad_event") {
        return c.json({ error: "Evento no encontrado" }, 404)
      }
      if (result.kind === "bad_bar") {
        return c.json({ error: "Barra no válida para este evento" }, 400)
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

      if (
        result.kind === "ok" &&
        result.inventoryItemIds.length > 0
      ) {
        void emitCommittedStockDeltas(tenantId, result.eventId, {
          eventItemIds: result.inventoryItemIds,
        })
      }

      return c.json(
        {
          message: "Venta registrada",
          saleId: result.saleId,
          totalAmount: result.totalAmount,
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
