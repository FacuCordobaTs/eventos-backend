import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { pool } from "../db"
import {
  barInventory,
  barProducts,
  bars,
  digitalConsumptions,
  eventInventory,
  eventProducts,
  events,
  inventoryItems,
  productRecipes,
  products,
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

const barProductToggleSchema = z.object({
  productId: z.string().min(1).max(36),
  isActive: z.boolean(),
})

const patchBarInventorySchema = z.object({
  inventoryItemId: z.string().min(1).max(36),
  stockToAddOrSet: z.union([
    z.number().nonnegative(),
    z.string().regex(/^\d+(\.\d{1,4})?$/),
  ]),
})

const redeemQrSchema = z.object({
  qrHash: z.string().min(1).max(255),
})

async function requireBarForTenant(
  db: ReturnType<typeof drizzle>,
  barId: string,
  tenantId: string
): Promise<typeof bars.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(bars)
    .where(and(eq(bars.id, barId), eq(bars.tenantId, tenantId)))
    .limit(1)
  return row ?? null
}

async function requireEventForTenant(
  db: ReturnType<typeof drizzle>,
  eventId: string,
  tenantId: string
): Promise<typeof events.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
    .limit(1)
  return row ?? null
}

export const barsRoute = new Hono()
  .use("*", authMiddleware)
  .get("/:barId/products", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const barId = c.req.param("barId")
    const eventId = c.req.query("eventId")
    if (!eventId || eventId.length === 0) {
      return c.json({ error: "Query eventId es requerido" }, 400)
    }

    const db = drizzle(pool)
    const bar = await requireBarForTenant(db, barId, tenantId)
    if (!bar) {
      return c.json({ error: "Barra no encontrada" }, 404)
    }
    if (bar.eventId !== eventId) {
      return c.json({ error: "La barra no pertenece a este evento" }, 400)
    }

    const ev = await requireEventForTenant(db, eventId, tenantId)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const rows = await db
      .select({
        id: products.id,
        name: products.name,
        price: products.price,
        barProductId: barProducts.id,
        barIsActive: barProducts.isActive,
      })
      .from(products)
      .innerJoin(
        eventProducts,
        and(
          eq(eventProducts.productId, products.id),
          eq(eventProducts.eventId, eventId),
          eq(eventProducts.tenantId, tenantId),
          eq(eventProducts.isActive, true)
        )
      )
      .leftJoin(
        barProducts,
        and(
          eq(barProducts.productId, products.id),
          eq(barProducts.barId, barId),
          eq(barProducts.tenantId, tenantId)
        )
      )
      .where(eq(products.tenantId, tenantId))
      .orderBy(asc(products.name))

    const productIds = rows.map((r) => r.id)
    const recipeRows =
      productIds.length === 0
        ? []
        : await db
            .select({
              productId: productRecipes.productId,
              inventoryItemId: productRecipes.inventoryItemId,
              quantityUsed: productRecipes.quantityUsed,
            })
            .from(productRecipes)
            .where(inArray(productRecipes.productId, productIds))

    const recipesByProduct = new Map<
      string,
      { inventoryItemId: string; quantityUsed: string }[]
    >()
    for (const rr of recipeRows) {
      const list = recipesByProduct.get(rr.productId) ?? []
      list.push({
        inventoryItemId: rr.inventoryItemId,
        quantityUsed: String(rr.quantityUsed),
      })
      recipesByProduct.set(rr.productId, list)
    }

    return c.json({
      products: rows.map((r) => ({
        id: r.id,
        name: r.name,
        price: String(r.price),
        isActiveForBar:
          r.barProductId != null && r.barIsActive === true,
        recipes: recipesByProduct.get(r.id) ?? [],
      })),
    })
  })
  .post(
    "/:barId/products/toggle",
    zValidator("json", barProductToggleSchema),
    async (c) => {
      const ctx = c as AuthenticatedContext
      const tenantId = requireTenantId(ctx)
      if (!tenantId) {
        return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
      }
      const barId = c.req.param("barId")
      const body = c.req.valid("json")
      const db = drizzle(pool)

      const bar = await requireBarForTenant(db, barId, tenantId)
      if (!bar) {
        return c.json({ error: "Barra no encontrada" }, 404)
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

      const [ep] = await db
        .select({ id: eventProducts.id })
        .from(eventProducts)
        .where(
          and(
            eq(eventProducts.eventId, bar.eventId),
            eq(eventProducts.productId, body.productId),
            eq(eventProducts.tenantId, tenantId),
            eq(eventProducts.isActive, true)
          )
        )
        .limit(1)
      if (!ep) {
        return c.json(
          { error: "El producto no está activo en el menú de este evento" },
          400
        )
      }

      const [existing] = await db
        .select()
        .from(barProducts)
        .where(
          and(
            eq(barProducts.barId, barId),
            eq(barProducts.productId, body.productId),
            eq(barProducts.tenantId, tenantId)
          )
        )
        .limit(1)

      if (existing) {
        await db
          .update(barProducts)
          .set({ isActive: body.isActive })
          .where(
            and(
              eq(barProducts.id, existing.id),
              eq(barProducts.tenantId, tenantId)
            )
          )
        return c.json({ ok: true })
      }

      if (!body.isActive) {
        return c.json({ ok: true })
      }

      const id = uuidv4()
      await db.insert(barProducts).values({
        id,
        barId,
        productId: body.productId,
        tenantId,
        isActive: true,
        createdAt: new Date(),
      })

      return c.json({ ok: true }, 201)
    }
  )
  .get("/:barId/inventory", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const barId = c.req.param("barId")
    const db = drizzle(pool)

    const bar = await requireBarForTenant(db, barId, tenantId)
    if (!bar) {
      return c.json({ error: "Barra no encontrada" }, 404)
    }

    const rows = await db
      .select({
        inventoryItemId: inventoryItems.id,
        name: inventoryItems.name,
        unit: inventoryItems.unit,
        eventStockAllocated: eventInventory.stockAllocated,
        barRowId: barInventory.id,
        barStock: barInventory.currentStock,
      })
      .from(inventoryItems)
      .leftJoin(
        eventInventory,
        and(
          eq(eventInventory.inventoryItemId, inventoryItems.id),
          eq(eventInventory.eventId, bar.eventId),
          eq(eventInventory.tenantId, tenantId)
        )
      )
      .leftJoin(
        barInventory,
        and(
          eq(barInventory.inventoryItemId, inventoryItems.id),
          eq(barInventory.barId, barId),
          eq(barInventory.tenantId, tenantId)
        )
      )
      .where(eq(inventoryItems.tenantId, tenantId))
      .orderBy(asc(inventoryItems.name))

    return c.json({
      items: rows.map((r) => ({
        inventoryItemId: r.inventoryItemId,
        name: r.name,
        unit: r.unit,
        eventStockAllocated:
          r.eventStockAllocated == null
            ? "0.00"
            : String(r.eventStockAllocated),
        barInventoryRowId: r.barRowId,
        barCurrentStock:
          r.barStock == null ? "0.00" : String(r.barStock),
      })),
    })
  })
  .patch(
    "/:barId/inventory",
    zValidator("json", patchBarInventorySchema),
    async (c) => {
      const ctx = c as AuthenticatedContext
      const tenantId = requireTenantId(ctx)
      if (!tenantId) {
        return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
      }
      const barId = c.req.param("barId")
      const body = c.req.valid("json")
      const db = drizzle(pool)

      const bar = await requireBarForTenant(db, barId, tenantId)
      if (!bar) {
        return c.json({ error: "Barra no encontrada" }, 404)
      }

      const [inv] = await db
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.id, body.inventoryItemId),
            eq(inventoryItems.tenantId, tenantId)
          )
        )
        .limit(1)
      if (!inv) {
        return c.json({ error: "Ítem de inventario no encontrado" }, 404)
      }

      const qty = dec(body.stockToAddOrSet)
      if (qty.lt(0)) {
        return c.json({ error: "El stock no puede ser negativo" }, 400)
      }
      const stockStr = decToDb(qty)

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
      const totalBars = others.plus(qty)
      if (totalBars.gt(cap)) {
        return c.json(
          {
            error:
              "El stock en barras no puede superar el stock asignado al evento para este insumo.",
          },
          400
        )
      }

      const [existing] = await db
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

      if (existing) {
        await db
          .update(barInventory)
          .set({ currentStock: stockStr })
          .where(
            and(
              eq(barInventory.id, existing.id),
              eq(barInventory.tenantId, tenantId)
            )
          )
        return c.json({ ok: true, currentStock: stockStr })
      }

      const id = uuidv4()
      await db.insert(barInventory).values({
        id,
        barId,
        inventoryItemId: body.inventoryItemId,
        tenantId,
        currentStock: stockStr,
      })

      return c.json({ ok: true, currentStock: stockStr }, 201)
    }
  )
  .post(
    "/:barId/redeem",
    zValidator("json", redeemQrSchema),
    async (c) => {
      const ctx = c as AuthenticatedContext
      const tenantId = requireTenantId(ctx)
      if (!tenantId) {
        return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
      }
      const barId = c.req.param("barId")
      const qrHash = c.req.valid("json").qrHash.trim()
      const db = drizzle(pool)

      const result = await db.transaction(async (tx) => {
        const [bar] = await tx
          .select()
          .from(bars)
          .where(and(eq(bars.id, barId), eq(bars.tenantId, tenantId)))
          .limit(1)
        if (!bar) {
          return { kind: "no_bar" as const }
        }

        const [row] = await tx
          .select({
            consumption: digitalConsumptions,
            sale: sales,
            productName: products.name,
          })
          .from(digitalConsumptions)
          .innerJoin(sales, eq(digitalConsumptions.saleId, sales.id))
          .innerJoin(products, eq(digitalConsumptions.productId, products.id))
          .where(
            and(
              eq(digitalConsumptions.qrHash, qrHash),
              eq(digitalConsumptions.tenantId, tenantId)
            )
          )
          .limit(1)

        if (!row) {
          return { kind: "invalid_qr" as const }
        }

        if (row.consumption.status !== "PENDING") {
          return { kind: "used" as const }
        }

        if (row.consumption.eventId !== bar.eventId) {
          return { kind: "wrong_event" as const }
        }

        if (row.sale.barId != null && row.sale.barId !== barId) {
          return { kind: "wrong_bar" as const }
        }

        await tx
          .update(digitalConsumptions)
          .set({
            status: "REDEEMED",
            redeemedAt: new Date(),
            redeemedBy: ctx.staff.id,
          })
          .where(
            and(
              eq(digitalConsumptions.id, row.consumption.id),
              eq(digitalConsumptions.status, "PENDING")
            )
          )

        const [verify] = await tx
          .select({ status: digitalConsumptions.status })
          .from(digitalConsumptions)
          .where(eq(digitalConsumptions.id, row.consumption.id))
          .limit(1)

        if (!verify || verify.status !== "REDEEMED") {
          return { kind: "race_used" as const }
        }

        const recipes = await tx
          .select()
          .from(productRecipes)
          .where(eq(productRecipes.productId, row.consumption.productId))

        for (const r of recipes) {
          const deduct = decFromDb(r.quantityUsed)
          const [bRow] = await tx
            .select()
            .from(barInventory)
            .where(
              and(
                eq(barInventory.barId, barId),
                eq(barInventory.inventoryItemId, r.inventoryItemId),
                eq(barInventory.tenantId, tenantId)
              )
            )
            .limit(1)

          if (bRow) {
            const next = decFromDb(bRow.currentStock).minus(deduct)
            await tx
              .update(barInventory)
              .set({ currentStock: decToDb(next) })
              .where(
                and(
                  eq(barInventory.id, bRow.id),
                  eq(barInventory.tenantId, tenantId)
                )
              )
          } else {
            const next = dec(0).minus(deduct)
            await tx.insert(barInventory).values({
              id: uuidv4(),
              barId,
              inventoryItemId: r.inventoryItemId,
              tenantId,
              currentStock: decToDb(next),
            })
          }
        }

        return {
          kind: "ok" as const,
          productName: row.productName,
          eventId: bar.eventId,
          inventoryItemIds: recipes.map((r) => r.inventoryItemId),
        }
      })

      if (result.kind === "no_bar") {
        return c.json({ error: "Barra no encontrada" }, 404)
      }
      if (result.kind === "invalid_qr") {
        return c.json({ error: "QR inválido" }, 404)
      }
      if (result.kind === "used" || result.kind === "race_used") {
        return c.json({ error: "QR ya usado o cancelado" }, 400)
      }
      if (result.kind === "wrong_event") {
        return c.json({ error: "Este código no pertenece a este evento" }, 400)
      }
      if (result.kind === "wrong_bar") {
        return c.json({ error: "Este código no es válido en esta barra" }, 400)
      }

      if (
        result.kind === "ok" &&
        result.inventoryItemIds.length > 0
      ) {
        void emitCommittedStockDeltas(tenantId, result.eventId, {
          barDeltas: { barId, itemIds: result.inventoryItemIds },
        })
      }

      return c.json({
        ok: true,
        productName: result.productName,
        message: `Servir: 1× ${result.productName}`,
      })
    }
  )
