import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { and, eq, inArray } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { pool } from "../db"
import { randomUUID } from "node:crypto"
import {
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
import { emitCommittedStockDeltas } from "../lib/event-stock-broadcast"

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
  barId: z.string().min(1).max(36).optional(),
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

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      unit: r.unit,
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
      await db
        .update(inventoryItems)
        .set({
          name: body.name,
          unit: body.unit,
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
          unit: row!.unit,
        },
      })
    }

    const id = uuidv4()
    await db.insert(inventoryItems).values({
      id,
      tenantId,
      name: body.name,
      unit: body.unit,
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
          unit: row!.unit,
        },
      },
      201
    )
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

        const needs = new Map<string, ReturnType<typeof dec>>()
        for (const line of body.items) {
          const lines = recipeRows.filter((r) => r.productId === line.productId)
          for (const r of lines) {
            const add = decFromDb(r.quantityUsed).times(line.quantity)
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
