import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
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
import { InsufficientStockError } from "./inventory"
import {
  recipeStockDeduction,
  stockAllocatedToBaseUnits,
} from "../lib/inventory-deduction"

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
  stockInputAs: z
    .enum(["BASE_UNITS", "PACKAGES"])
    .optional()
    .default("BASE_UNITS"),
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
      .where(
        and(
          eq(products.tenantId, tenantId),
          or(eq(products.isActive, true), isNull(products.isActive))
        )
      )
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
        baseUnit: inventoryItems.baseUnit,
        packageSize: inventoryItems.packageSize,
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
      .where(
        and(
          eq(inventoryItems.tenantId, tenantId),
          eq(inventoryItems.isActive, true)
        )
      )
      .orderBy(asc(inventoryItems.name))

    const sumByItem = new Map<string, string>()
    const sumRows = await db
      .select({
        iid: barInventory.inventoryItemId,
        s: sql<string>`coalesce(sum(cast(${barInventory.currentStock} as decimal(14,2))), 0)`,
      })
      .from(barInventory)
      .innerJoin(bars, eq(barInventory.barId, bars.id))
      .where(
        and(
          eq(bars.eventId, bar.eventId),
          eq(bars.tenantId, tenantId),
          eq(barInventory.tenantId, tenantId)
        )
      )
      .groupBy(barInventory.inventoryItemId)

    for (const sr of sumRows) {
      sumByItem.set(sr.iid, sr.s)
    }

    return c.json({
      items: rows.map((r) => {
        const cap = decFromDb(
          r.eventStockAllocated == null ? "0" : String(r.eventStockAllocated)
        )
        const sumBars = decFromDb(sumByItem.get(r.inventoryItemId) ?? "0")
        const unallocRaw = cap.minus(sumBars)
        const unalloc = unallocRaw.lt(dec(0)) ? dec(0) : unallocRaw
        return {
          inventoryItemId: r.inventoryItemId,
          name: r.name,
          baseUnit: r.baseUnit,
          packageSize: r.packageSize,
          eventStockAllocated:
            r.eventStockAllocated == null
              ? "0.00"
              : String(r.eventStockAllocated),
          unallocatedEventStock: decToDb(unalloc),
          barInventoryRowId: r.barRowId,
          barCurrentStock: r.barStock == null ? "0.00" : String(r.barStock),
        }
      }),
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
        return c.json({ error: "Ítem de inventario no encontrado" }, 404)
      }

      const conv = stockAllocatedToBaseUnits(
        itemRow,
        body.stockToAddOrSet,
        body.stockInputAs
      )
      if (conv.error) {
        return c.json({ error: conv.error }, 400)
      }
      const qty = conv.value
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
  .delete("/:barId/inventory/:inventoryItemId", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const barId = c.req.param("barId")
    const inventoryItemId = c.req.param("inventoryItemId")
    if (inventoryItemId == null || inventoryItemId === "") {
      return c.json({ error: "Falta el ítem" }, 400)
    }
    const db = drizzle(pool)
    const bar = await requireBarForTenant(db, barId, tenantId)
    if (!bar) {
      return c.json({ error: "Barra no encontrada" }, 404)
    }

    const [row] = await db
      .select({ id: barInventory.id })
      .from(barInventory)
      .where(
        and(
          eq(barInventory.barId, barId),
          eq(barInventory.inventoryItemId, inventoryItemId),
          eq(barInventory.tenantId, tenantId)
        )
      )
      .limit(1)
    if (!row) {
      return c.json({ ok: true, removed: false })
    }

    await db
      .delete(barInventory)
      .where(
        and(
          eq(barInventory.id, row.id),
          eq(barInventory.tenantId, tenantId)
        )
      )

    void emitCommittedStockDeltas(tenantId, bar.eventId, {
      barDeltas: { barId, itemIds: [inventoryItemId] },
    })
    return c.json({ ok: true, removed: true })
  })
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

      let result: {
        kind: "no_bar" | "invalid_qr" | "used" | "wrong_event" | "wrong_bar" | "race_used" | "ok"
        productName?: string
        eventId?: string
        inventoryItemIds?: string[]
      }
      try {
        result = await db.transaction(async (tx) => {
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
            productSaleType: products.saleType,
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

        const recipeInvIds = [...new Set(recipes.map((r) => r.inventoryItemId))]
        const invRows =
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
        const invById = new Map(invRows.map((i) => [i.id, i]))
        const saleType = row.productSaleType

        for (const r of recipes) {
          const item = invById.get(r.inventoryItemId)
          if (!item) continue
          const deduct = recipeStockDeduction(
            r.quantityUsed,
            1,
            saleType,
            item
          )
          if (!deduct.gt(dec(0))) continue

          const [evRow] = await tx
            .select()
            .from(eventInventory)
            .where(
              and(
                eq(eventInventory.eventId, bar.eventId),
                eq(eventInventory.inventoryItemId, r.inventoryItemId),
                eq(eventInventory.tenantId, tenantId)
              )
            )
            .limit(1)
          const cap = evRow ? decFromDb(evRow.stockAllocated) : dec(0)

          const [sumR] = await tx
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
                eq(barInventory.inventoryItemId, r.inventoryItemId)
              )
            )

          const sumAll = decFromDb(sumR?.s ?? "0")
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
          const barAvail = bRow ? decFromDb(bRow.currentStock) : dec(0)

          if (!evRow) {
            if (deduct.gt(barAvail)) {
              throw new InsufficientStockError(
                "Stock insuficiente",
                r.inventoryItemId,
                item.name
              )
            }
            if (bRow) {
              await tx
                .update(barInventory)
                .set({ currentStock: decToDb(barAvail.minus(deduct)) })
                .where(
                  and(
                    eq(barInventory.id, bRow.id),
                    eq(barInventory.tenantId, tenantId)
                  )
                )
            }
            continue
          }

          const unalloc = cap.minus(sumAll)
          if (deduct.gt(barAvail.plus(unalloc))) {
            throw new InsufficientStockError(
              "Stock insuficiente",
              r.inventoryItemId,
              item.name
            )
          }

          const fromBar = deduct.lte(barAvail) ? deduct : barAvail
          const newCap = cap.minus(deduct)
          await tx
            .update(eventInventory)
            .set({ stockAllocated: decToDb(newCap) })
            .where(
              and(
                eq(eventInventory.id, evRow.id),
                eq(eventInventory.tenantId, tenantId)
              )
            )

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

        return {
          kind: "ok" as const,
          productName: row.productName,
          eventId: bar.eventId,
          inventoryItemIds: recipes.map((r) => r.inventoryItemId),
        }
        })
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
        result.inventoryItemIds &&
        result.inventoryItemIds.length > 0
      ) {
        void emitCommittedStockDeltas(tenantId, result.eventId!, {
          eventItemIds: result.inventoryItemIds,
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
