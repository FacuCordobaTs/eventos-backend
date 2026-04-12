import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { and, eq, inArray } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { pool } from "../db"
import {
  events,
  inventoryItems,
  productRecipes,
  products,
  saleItems,
  sales,
} from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { dec, decFromDb, decToDb } from "../lib/decimal-money"

function requireTenantId(ctx: AuthenticatedContext): string | null {
  const id = ctx.staff.tenantId
  if (id == null || id === "") return null
  return id
}

const unitSchema = z.enum(["ML", "UNIDAD", "GRAMOS"])

const upsertItemSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(255),
  unit: unitSchema,
  currentStock: z
    .union([z.string().regex(/^\d+(\.\d{1,2})?$/), z.number()])
    .optional()
    .transform((v) => (v === undefined ? undefined : String(v))),
})

const adjustStockSchema = z.object({
  delta: z
    .union([z.string().regex(/^\d+(\.\d{1,4})?$/), z.number().positive()])
    .transform((v) => (typeof v === "number" ? String(v) : v)),
})

const recipeLineSchema = z.object({
  inventoryItemId: z.string().min(1),
  quantityUsed: z
    .union([z.string().regex(/^\d+(\.\d{1,4})?$/), z.number().positive()])
    .transform((v) => (typeof v === "number" ? String(v) : v)),
})

const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  price: z
    .union([z.string().regex(/^\d+(\.\d{1,2})?$/), z.number().nonnegative()])
    .transform((v) => (typeof v === "number" ? v.toFixed(2) : v)),
  recipes: z.array(recipeLineSchema).default([]),
})

const updateProductSchema = createProductSchema

const createSaleSchema = z.object({
  eventId: z.string().min(1),
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

function alertThreshold(): ReturnType<typeof dec> {
  return dec(process.env.INVENTORY_ALERT_THRESHOLD ?? "100")
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
      .where(eq(inventoryItems.tenantId, tenantId))

    const th = alertThreshold()
    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      unit: r.unit,
      currentStock: r.currentStock,
      isLowStock: decFromDb(r.currentStock).lt(th),
    }))

    return c.json({
      items,
      alertThreshold: decToDb(th),
    })
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
      const stock =
        body.currentStock !== undefined
          ? decToDb(dec(body.currentStock))
          : existing.currentStock
      await db
        .update(inventoryItems)
        .set({
          name: body.name,
          unit: body.unit,
          currentStock: stock,
        })
        .where(eq(inventoryItems.id, body.id))
      const [row] = await db
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.id, body.id))
        .limit(1)
      const th = alertThreshold()
      return c.json({
        item: {
          id: row!.id,
          name: row!.name,
          unit: row!.unit,
          currentStock: row!.currentStock,
          isLowStock: decFromDb(row!.currentStock).lt(th),
        },
        alertThreshold: decToDb(th),
      })
    }

    const id = uuidv4()
    const stock = body.currentStock !== undefined ? decToDb(dec(body.currentStock)) : "0.00"
    await db.insert(inventoryItems).values({
      id,
      tenantId,
      name: body.name,
      unit: body.unit,
      currentStock: stock,
    })
    const [row] = await db
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.id, id))
      .limit(1)
    const th = alertThreshold()
    return c.json(
      {
        item: {
          id: row!.id,
          name: row!.name,
          unit: row!.unit,
          currentStock: row!.currentStock,
          isLowStock: decFromDb(row!.currentStock).lt(th),
        },
        alertThreshold: decToDb(th),
      },
      201
    )
  })
  .patch("/items/:id/stock", zValidator("json", adjustStockSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const id = c.req.param("id")
    const { delta } = c.req.valid("json")
    const db = drizzle(pool)

    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(inventoryItems)
        .where(and(eq(inventoryItems.id, id), eq(inventoryItems.tenantId, tenantId)))
        .limit(1)
      if (!row) {
        return { kind: "notfound" as const }
      }
      const next = decFromDb(row.currentStock).plus(dec(delta))
      if (next.lt(0)) {
        return { kind: "negative" as const }
      }
      await tx
        .update(inventoryItems)
        .set({ currentStock: decToDb(next) })
        .where(eq(inventoryItems.id, id))
      const [updated] = await tx
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.id, id))
        .limit(1)
      return { kind: "ok" as const, row: updated! }
    })

    if (result.kind === "notfound") {
      return c.json({ error: "Ítem no encontrado" }, 404)
    }
    if (result.kind === "negative") {
      return c.json({ error: "El ajuste dejaría stock negativo." }, 400)
    }
    const th = alertThreshold()
    return c.json({
      item: {
        id: result.row.id,
        name: result.row.name,
        unit: result.row.unit,
        currentStock: result.row.currentStock,
        isLowStock: decFromDb(result.row.currentStock).lt(th),
      },
      alertThreshold: decToDb(th),
    })
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
      .where(eq(products.tenantId, tenantId))

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
        inventoryUnit: inventoryItems.unit,
      })
      .from(productRecipes)
      .innerJoin(
        inventoryItems,
        eq(productRecipes.inventoryItemId, inventoryItems.id)
      )
      .where(
        and(
          inArray(productRecipes.productId, pids),
          eq(inventoryItems.tenantId, tenantId)
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
        recipes: (byProduct.get(p.id) ?? []).map((r) => ({
          id: r.id,
          inventoryItemId: r.inventoryItemId,
          quantityUsed: r.quantityUsed,
          inventoryItemName: r.inventoryName,
          inventoryUnit: r.inventoryUnit,
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
            eq(inventoryItems.tenantId, tenantId)
          )
        )
      if (invRows.length !== invIds.length) {
        return c.json({ error: "Una o más materias primas no existen." }, 400)
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
        inventoryUnit: inventoryItems.unit,
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
          recipes: recipes.map((r) => ({
            id: r.id,
            inventoryItemId: r.inventoryItemId,
            quantityUsed: r.quantityUsed,
            inventoryItemName: r.inventoryName,
            inventoryUnit: r.inventoryUnit,
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
            eq(inventoryItems.tenantId, tenantId)
          )
        )
      if (invRows.length !== invIds.length) {
        return c.json({ error: "Una o más materias primas no existen." }, 400)
      }
    }

    const priceStr = decToDb(dec(body.price))

    await db.transaction(async (tx) => {
      await tx
        .update(products)
        .set({ name: body.name, price: priceStr })
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
        inventoryUnit: inventoryItems.unit,
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
        recipes: recipes.map((r) => ({
          id: r.id,
          inventoryItemId: r.inventoryItemId,
          quantityUsed: r.quantityUsed,
          inventoryItemName: r.inventoryName,
          inventoryUnit: r.inventoryUnit,
        })),
      },
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

        const needs = new Map<string, ReturnType<typeof dec>>()
        for (const line of body.items) {
          const lines = recipeRows.filter((r) => r.productId === line.productId)
          for (const r of lines) {
            const add = decFromDb(r.quantityUsed).times(line.quantity)
            const prev = needs.get(r.inventoryItemId) ?? dec(0)
            needs.set(r.inventoryItemId, prev.plus(add))
          }
        }

        let invRowsSnapshot: (typeof inventoryItems.$inferSelect)[] = []
        if (needs.size > 0) {
          const invIds = [...needs.keys()]
          invRowsSnapshot = await tx
            .select()
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
          for (const [invId, need] of needs) {
            const row = invRowsSnapshot.find((r) => r.id === invId)!
            if (decFromDb(row.currentStock).lt(need)) {
              throw new InsufficientStockError(
                "Stock insuficiente",
                row.id,
                row.name
              )
            }
          }
        }

        const saleId = uuidv4()
        await tx.insert(sales).values({
          id: saleId,
          eventId: body.eventId,
          tenantId,
          staffId: ctx.staff.id,
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

        if (needs.size > 0) {
          for (const [invId, need] of needs) {
            const row = invRowsSnapshot.find((r) => r.id === invId)!
            const next = decFromDb(row.currentStock).minus(need)
            await tx
              .update(inventoryItems)
              .set({ currentStock: decToDb(next) })
              .where(eq(inventoryItems.id, invId))
          }
        }

        return {
          kind: "ok" as const,
          saleId,
          totalAmount: decToDb(total),
        }
      })

      if (result.kind === "bad_event") {
        return c.json({ error: "Evento no encontrado" }, 404)
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
