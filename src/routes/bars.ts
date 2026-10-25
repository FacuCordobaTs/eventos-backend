import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type TablesRelationalConfig,
} from "drizzle-orm"
import type { MySql2Database, MySql2Transaction } from "drizzle-orm/mysql2"
import { v4 as uuidv4 } from "uuid"
import { pool } from "../db"
import {
  barInventory,
  barProducts,
  bars,
  digitalConsumptions,
  eventInventory,
  eventExpenses,
  purchases,
  eventProducts,
  events,
  inventoryItems,
  pickupOrders,
  productCategories,
  productRecipes,
  products,
  saleItems,
  sales,
} from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { dec, decFromDb, decToDb } from "../lib/decimal-money"
import { emitCommittedStockDeltas } from "../lib/event-stock-broadcast"
import { broadcastPickupUpdate, broadcastReceiptUpdate } from "../lib/public-qr-broadcast"
import { pickupItemsWithNames } from "../lib/pickup-items"
import { InsufficientStockError } from "./inventory"
import {
  recipeStockDeduction,
  stockAllocatedToBaseUnits,
  type ProductSaleType,
} from "../lib/inventory-deduction"
import { eventSupportsConsumptions, eventTracksStock } from "../lib/event-operation-mode"

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

const setBarStockSchema = z.object({
  inventoryItemId: z.string().min(1).max(36),
  quantity: z.string().regex(/^\d+(\.\d{1,4})?$/).max(18),
  totalCost: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/).optional(),
  expectedCurrentStock: z.string().regex(/^-?\d+(\.\d{1,4})?$/).max(18),
  stockInputAs: z.enum(["BASE_UNITS", "PACKAGES"]),
})

const setBarProductStockSchema = z.object({
  productId: z.string().min(1).max(36),
  quantity: z.string().regex(/^-?\d{1,8}(\.\d{1,2})?$/).nullable(),
  expectedCurrentStock: z.string().regex(/^-?\d{1,8}(\.\d{1,2})?$/).nullable(),
  totalCost: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/).optional(),
})

const redeemQrSchema = z.object({
  qrHash: z.string().min(1).max(255),
})

async function requireBarForTenant(
  db: MySql2Database<Record<string, never>>,
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
  db: MySql2Database<Record<string, never>>,
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

/** Tx de `db.transaction()` — mismo truco de tipado que `pickupItemsWithNames` en public.ts. */
type Tx = MySql2Transaction<Record<string, never>, TablesRelationalConfig>

/** Una línea de descuento de stock: producto + cuántas unidades + tipo de venta. */
type DeductionLine = { productId: string; quantity: number; saleType: ProductSaleType }

/**
 * Descuenta stock de la barra por receta dentro de la transacción abierta, UNA vez por
 * producto (cantidad agregada de la línea). Compartido por el canje 1×1 (`redeem`) y la
 * entrega de pedidos (`deliver`): entregar 2 fernets de un pedido descuenta exactamente lo
 * mismo que canjear 2 QRs individuales (un Fernet descuenta Coca y Alcohol). Lanza
 * `InsufficientStockError` si no alcanza. Devuelve los inventoryItemIds que cambiaron.
 */
async function deductRecipeStock(
  tx: Tx,
  params: { tenantId: string; eventId: string; barId: string },
  lines: DeductionLine[]
): Promise<string[]> {
  const [event] = await tx
    .select({ operationMode: events.operationMode })
    .from(events)
    .where(
      and(
        eq(events.id, params.eventId),
        eq(events.tenantId, params.tenantId)
      )
    )
    .limit(1).for("update")
  if (
    !event ||
    !eventTracksStock(event.operationMode ?? "FULL_OPERATION")
  ) {
    return []
  }

  const changedItemIds: string[] = []
  for (const line of lines) {
    const recipes = await tx
      .select()
      .from(productRecipes)
      .where(eq(productRecipes.productId, line.productId))

    if (recipes.length === 0) {
      const [stock] = await tx.select().from(barProducts).where(and(
        eq(barProducts.barId, params.barId), eq(barProducts.productId, line.productId),
        eq(barProducts.tenantId, params.tenantId)
      )).limit(1).for("update")
      if (stock?.directStock != null) {
        const remaining = decFromDb(stock.directStock).minus(line.quantity)
        if (remaining.lt(0)) {
          const [product] = await tx.select({ name: products.name }).from(products).where(and(eq(products.id, line.productId), eq(products.tenantId, params.tenantId))).limit(1)
          throw new InsufficientStockError("Stock insuficiente", line.productId, product?.name ?? "Producto")
        }
        await tx.update(barProducts).set({ directStock: decToDb(remaining) }).where(eq(barProducts.id, stock.id))
      }
    }

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
                eq(inventoryItems.tenantId, params.tenantId)
              )
            )
    const invById = new Map(invRows.map((i) => [i.id, i]))

    for (const r of recipes) {
      const item = invById.get(r.inventoryItemId)
      if (!item) continue
      const deduct = recipeStockDeduction(
        r.quantityUsed,
        line.quantity,
        line.saleType,
        item
      )
      if (!deduct.gt(dec(0))) continue

      const [evRow] = await tx
        .select()
        .from(eventInventory)
        .where(
          and(
            eq(eventInventory.eventId, params.eventId),
            eq(eventInventory.inventoryItemId, r.inventoryItemId),
            eq(eventInventory.tenantId, params.tenantId)
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
            eq(bars.eventId, params.eventId),
            eq(bars.tenantId, params.tenantId),
            eq(barInventory.tenantId, params.tenantId),
            eq(barInventory.inventoryItemId, r.inventoryItemId)
          )
        )

      const sumAll = decFromDb(sumR?.s ?? "0")
      const [bRow] = await tx
        .select()
        .from(barInventory)
        .where(
          and(
            eq(barInventory.barId, params.barId),
            eq(barInventory.inventoryItemId, r.inventoryItemId),
            eq(barInventory.tenantId, params.tenantId)
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
                eq(barInventory.tenantId, params.tenantId)
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
            eq(eventInventory.tenantId, params.tenantId)
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
              eq(barInventory.tenantId, params.tenantId)
            )
          )
      }

      changedItemIds.push(r.inventoryItemId)
    }
  }
  return [...new Set(changedItemIds)]
}

type PickupStockShortage = {
  inventoryItemId: string
  inventoryItemName: string
  required: string
  available: string
}

/**
 * Calcula el faltante completo de un pedido antes de intentar entregarlo. Las recetas se
 * agregan por insumo: así, si dos productos usan la misma Coca, se informa el faltante real
 * una sola vez y no sólo el primer insumo que fallaría al descontar.
 */
async function findPickupStockShortages(
  db: MySql2Database<Record<string, never>>,
  params: { tenantId: string; eventId: string; barId: string },
  items: { productId: string; quantity: number }[]
): Promise<PickupStockShortage[]> {
  const event = await requireEventForTenant(db, params.eventId, params.tenantId)
  if (
    !event ||
    !eventTracksStock(event.operationMode ?? "FULL_OPERATION")
  ) {
    return []
  }

  const consumptionIds = items.flatMap((item) => "consumptionId" in item ? [String(item.consumptionId)] : [])
  if (consumptionIds.length) {
    const posConsumptions = await db.select({ id: digitalConsumptions.id }).from(digitalConsumptions)
      .innerJoin(sales, eq(sales.id, digitalConsumptions.saleId)).where(and(
        inArray(digitalConsumptions.id, consumptionIds), eq(digitalConsumptions.tenantId, params.tenantId),
        eq(digitalConsumptions.eventId, params.eventId), eq(sales.tenantId, params.tenantId), eq(sales.source, "POS")
      ))
    const alreadyDeducted = new Set(posConsumptions.map((row) => row.id))
    items = items.filter((item) => !("consumptionId" in item) || !alreadyDeducted.has(String(item.consumptionId)))
  }
  const productIds = [...new Set(items.map((item) => item.productId))]
  if (productIds.length === 0) return []

  const [productRows, recipeRows] = await Promise.all([
    db
      .select({ id: products.id, name: products.name, saleType: products.saleType })
      .from(products)
      .where(inArray(products.id, productIds)),
    db
      .select()
      .from(productRecipes)
      .where(inArray(productRecipes.productId, productIds)),
  ])
  const saleTypeByProductId = new Map(productRows.map((product) => [product.id, product.saleType]))
  const quantityByProductId = new Map<string, number>()
  for (const item of items) {
    quantityByProductId.set(
      item.productId,
      (quantityByProductId.get(item.productId) ?? 0) + item.quantity
    )
  }

  const withRecipes = new Set(recipeRows.map((recipe) => recipe.productId))
  const unitStocks = await db.select().from(barProducts).where(and(
    eq(barProducts.barId, params.barId), eq(barProducts.tenantId, params.tenantId), inArray(barProducts.productId, productIds)
  ))
  const directShortages: PickupStockShortage[] = []
  for (const row of unitStocks) {
    if (row.directStock == null || withRecipes.has(row.productId)) continue
    const required = dec(quantityByProductId.get(row.productId) ?? 0)
    if (required.gt(decFromDb(row.directStock))) directShortages.push({
      inventoryItemId: row.productId, inventoryItemName: productRows.find((product) => product.id === row.productId)?.name ?? "Producto",
      required: decToDb(required), available: String(row.directStock),
    })
  }
  const inventoryItemIds = [...new Set(recipeRows.map((recipe) => recipe.inventoryItemId))]
  if (inventoryItemIds.length === 0) return directShortages

  const [inventoryRows, eventRows, barRows, allocatedRows] = await Promise.all([
    db
      .select()
      .from(inventoryItems)
      .where(and(inArray(inventoryItems.id, inventoryItemIds), eq(inventoryItems.tenantId, params.tenantId))),
    db
      .select()
      .from(eventInventory)
      .where(
        and(
          eq(eventInventory.eventId, params.eventId),
          eq(eventInventory.tenantId, params.tenantId),
          inArray(eventInventory.inventoryItemId, inventoryItemIds)
        )
      ),
    db
      .select()
      .from(barInventory)
      .where(
        and(
          eq(barInventory.barId, params.barId),
          eq(barInventory.tenantId, params.tenantId),
          inArray(barInventory.inventoryItemId, inventoryItemIds)
        )
      ),
    db
      .select({
        inventoryItemId: barInventory.inventoryItemId,
        total: sql<string>`coalesce(sum(cast(${barInventory.currentStock} as decimal(14,2))), 0)`,
      })
      .from(barInventory)
      .innerJoin(bars, eq(barInventory.barId, bars.id))
      .where(
        and(
          eq(bars.eventId, params.eventId),
          eq(bars.tenantId, params.tenantId),
          eq(barInventory.tenantId, params.tenantId),
          inArray(barInventory.inventoryItemId, inventoryItemIds)
        )
      )
      .groupBy(barInventory.inventoryItemId),
  ])

  const inventoryById = new Map(inventoryRows.map((item) => [item.id, item]))
  const eventByInventoryId = new Map(eventRows.map((row) => [row.inventoryItemId, row]))
  const barByInventoryId = new Map(barRows.map((row) => [row.inventoryItemId, row]))
  const allocatedByInventoryId = new Map(allocatedRows.map((row) => [row.inventoryItemId, row.total]))
  const requiredByInventoryId = new Map<string, ReturnType<typeof dec>>()

  for (const recipe of recipeRows) {
    const inventoryItem = inventoryById.get(recipe.inventoryItemId)
    if (!inventoryItem) continue
    const quantity = quantityByProductId.get(recipe.productId) ?? 0
    const required = recipeStockDeduction(
      recipe.quantityUsed,
      quantity,
      saleTypeByProductId.get(recipe.productId) ?? "GLASS",
      inventoryItem
    )
    requiredByInventoryId.set(
      recipe.inventoryItemId,
      (requiredByInventoryId.get(recipe.inventoryItemId) ?? dec(0)).plus(required)
    )
  }

  const shortages: PickupStockShortage[] = [...directShortages]
  for (const [inventoryItemId, required] of requiredByInventoryId) {
    if (!required.gt(0)) continue
    const inventoryItem = inventoryById.get(inventoryItemId)
    if (!inventoryItem) continue
    const barAvailable = decFromDb(barByInventoryId.get(inventoryItemId)?.currentStock ?? "0")
    const eventRow = eventByInventoryId.get(inventoryItemId)
    const unallocated = eventRow
      ? decFromDb(eventRow.stockAllocated).minus(
          decFromDb(allocatedByInventoryId.get(inventoryItemId) ?? "0")
        )
      : dec(0)
    const available = eventRow
      ? barAvailable.plus(unallocated.lt(0) ? dec(0) : unallocated)
      : barAvailable
    if (required.gt(available)) {
      shortages.push({
        inventoryItemId,
        inventoryItemName: inventoryItem.name,
        required: decToDb(required),
        available: decToDb(available),
      })
    }
  }
  return shortages
}

type ConsumptionRow = typeof digitalConsumptions.$inferSelect

type RedeemSetResult =
  | {
      kind: "ok"
      items: { productId: string; productName: string; quantity: number }[]
      totalAmount: string
      inventoryItemIds: string[]
    }
  | { kind: "wrong_event" }
  | { kind: "race_used" }

/**
 * Marca REDEEMED un conjunto de consumiciones PENDING y descuenta el stock por receta UNA vez
 * por producto (cantidad agregada). Lo comparten la entrega de pedidos de retiro (tarea 4.2) y
 * la entrega por comprobante de la venta: entregar 2 fernets descuenta exactamente lo mismo que
 * canjear 2 QRs individuales. Corre DENTRO de la transacción del caller: ante `wrong_event` o
 * `race_used` el caller debe descartarla. Lanza `InsufficientStockError` si no alcanza el stock.
 */
async function redeemConsumptionSet(
  tx: Tx,
  params: { tenantId: string; eventId: string; barId: string; staffId: string },
  consRows: ConsumptionRow[]
): Promise<RedeemSetResult> {
  if (consRows.some((r) => r.eventId !== params.eventId)) {
    return { kind: "wrong_event" }
  }
  if (consRows.some((r) => r.status !== "PENDING")) {
    return { kind: "race_used" }
  }

  const consumptionIds = consRows.map((r) => r.id)

  // Marcar todas REDEEMED (update condicional: si otra entrega concurrente del mismo pedido se
  // adelantó, las filas que ya no están PENDING quedan sin tocar y la verificación de abajo lo
  // detecta → rollback).
  for (const r of consRows) {
    await tx
      .update(digitalConsumptions)
      .set({
        status: "REDEEMED",
        redeemedAt: new Date(),
        redeemedBy: params.staffId,
      })
      .where(
        and(
          eq(digitalConsumptions.id, r.id),
          eq(digitalConsumptions.status, "PENDING")
        )
      )
  }

  const [verify] = await tx
    .select({ n: sql<string>`count(*)` })
    .from(digitalConsumptions)
    .where(
      and(
        inArray(digitalConsumptions.id, consumptionIds),
        ne(digitalConsumptions.status, "REDEEMED")
      )
    )
  if (Number(verify?.n ?? 0) > 0) {
    return { kind: "race_used" }
  }

  // Descuento de stock por receta, UNA vez por producto con la cantidad agregada. Cada fila de
  // `digital_consumptions` es una unidad, así que la cantidad sale de contar filas.
  const qtyByProduct = new Map<string, number>()
  for (const r of consRows) {
    qtyByProduct.set(r.productId, (qtyByProduct.get(r.productId) ?? 0) + 1)
  }
  const prodIds = [...qtyByProduct.keys()]
  const prodRows = await tx
    .select({
      id: products.id,
      name: products.name,
      price: products.price,
      saleType: products.saleType,
    })
    .from(products)
    .where(inArray(products.id, prodIds))
  const prodById = new Map(prodRows.map((p) => [p.id, p]))
  const sourceSales = await tx.select({ id: sales.id, source: sales.source }).from(sales).where(and(
    inArray(sales.id, [...new Set(consRows.map((row) => row.saleId))]),
    eq(sales.tenantId, params.tenantId), eq(sales.eventId, params.eventId)
  ))
  const posSaleIds = new Set(sourceSales.filter((sale) => sale.source === "POS").map((sale) => sale.id))
  const needsStock = new Map<string, number>()
  for (const row of consRows) if (!posSaleIds.has(row.saleId)) {
    needsStock.set(row.productId, (needsStock.get(row.productId) ?? 0) + 1)
  }
  const inventoryItemIds = await deductRecipeStock(
    tx,
    { tenantId: params.tenantId, eventId: params.eventId, barId: params.barId },
    [...needsStock].map(([pid, quantity]) => ({
      productId: pid,
      quantity,
      saleType: prodById.get(pid)?.saleType ?? "GLASS",
    }))
  )

  // Total = precio cobrado al momento de la compra (`sale_items.price_at_time`), con fallback
  // al precio actual del producto — mismo criterio que el comprobante.
  const saleIds = [...new Set(consRows.map((r) => r.saleId))]
  const priceRows = await tx
    .select({
      saleId: saleItems.saleId,
      productId: saleItems.productId,
      priceAtTime: saleItems.priceAtTime,
    })
    .from(saleItems)
    .where(
      and(
        inArray(saleItems.saleId, saleIds),
        inArray(saleItems.productId, prodIds)
      )
    )
  const priceByKey = new Map(
    priceRows.map((p) => [`${p.saleId}:${p.productId}`, String(p.priceAtTime)])
  )

  let total = dec(0)
  for (const r of consRows) {
    const charged = priceByKey.get(`${r.saleId}:${r.productId}`)
    const unit =
      charged != null
        ? decFromDb(charged)
        : decFromDb(prodById.get(r.productId)?.price ?? "0")
    total = total.plus(unit)
  }

  return {
    kind: "ok",
    items: prodIds.map((productId) => ({
      productId,
      productName: prodById.get(productId)?.name ?? "Producto",
      quantity: qtyByProduct.get(productId) ?? 1,
    })),
    totalAmount: decToDb(total),
    inventoryItemIds,
  }
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
    const tracksStock = eventTracksStock(ev.operationMode ?? "FULL_OPERATION")

    const rows = await db
      .select({
        id: products.id,
        name: products.name,
        price: sql<string>`coalesce(${eventProducts.priceOverride}, ${products.price})`,
        saleType: products.saleType,
        directStock: barProducts.directStock,
        barProductId: barProducts.id,
        barIsActive: barProducts.isActive,
        categoryId: products.categoryId,
        categoryName: productCategories.name,
        categorySortOrder: productCategories.sortOrder,
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
      .leftJoin(
        productCategories,
        and(
          eq(productCategories.id, products.categoryId),
          eq(productCategories.tenantId, tenantId),
          eq(productCategories.isActive, true)
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
      !tracksStock || productIds.length === 0
        ? []
        : await db
            .select({
              productId: productRecipes.productId,
              inventoryItemId: productRecipes.inventoryItemId,
              quantityUsed: productRecipes.quantityUsed,
              baseUnit: inventoryItems.baseUnit,
              packageSize: inventoryItems.packageSize,
            })
            .from(productRecipes)
            .innerJoin(inventoryItems, eq(inventoryItems.id, productRecipes.inventoryItemId))
            .where(and(inArray(productRecipes.productId, productIds), eq(inventoryItems.tenantId, tenantId)))

    const recipesByProduct = new Map<
      string,
      { inventoryItemId: string; quantityUsed: string }[]
    >()
    for (const rr of recipeRows) {
      const list = recipesByProduct.get(rr.productId) ?? []
      list.push({
        inventoryItemId: rr.inventoryItemId,
        quantityUsed: recipeStockDeduction(String(rr.quantityUsed), 1, rows.find((row) => row.id === rr.productId)?.saleType ?? "GLASS", rr).toString(),
      })
      recipesByProduct.set(rr.productId, list)
    }

    return c.json({
      tracksStock,
      products: rows.map((r) => ({
        id: r.id,
        name: r.name,
        price: String(r.price),
        directStock:
          !tracksStock || r.directStock == null ? null : String(r.directStock),
        isActiveForBar:
          r.barProductId != null && r.barIsActive === true,
        categoryId: r.categoryId ?? null,
        categoryName: r.categoryName ?? null,
        categorySortOrder: r.categorySortOrder ?? null,
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

      if (ctx.staff.role !== "ADMIN" && ctx.staff.role !== "MANAGER") {
        return c.json({ error: "No tenés permiso para modificar el menú" }, 403)
      }
      const result = await db.transaction(async (tx) => {
        const [event] = await tx.select().from(events).where(and(
          eq(events.id, bar.eventId), eq(events.tenantId, tenantId)
        )).limit(1).for("update")
        if (!event || !eventSupportsConsumptions(event.operationMode ?? "FULL_OPERATION")) return "disabled"
        const [prod] = await tx.select().from(products).where(and(
          eq(products.id, body.productId), eq(products.tenantId, tenantId)
        )).limit(1)
        if (!prod || prod.isActive === false) return "no_product"
        // El menú de barra es la única acción del operador. La capa de compatibilidad
        // del evento se habilita aquí, dentro de la misma transacción.
        if (body.isActive) {
          const [ep] = await tx.select().from(eventProducts).where(and(
            eq(eventProducts.eventId, bar.eventId), eq(eventProducts.productId, body.productId),
            eq(eventProducts.tenantId, tenantId)
          )).limit(1)
          if (ep) await tx.update(eventProducts).set({ isActive: true }).where(eq(eventProducts.id, ep.id))
          else await tx.insert(eventProducts).values({ id: uuidv4(), eventId: bar.eventId,
            productId: body.productId, tenantId, isActive: true })
        }
        const [existing] = await tx.select().from(barProducts).where(and(
          eq(barProducts.barId, barId), eq(barProducts.productId, body.productId),
          eq(barProducts.tenantId, tenantId)
        )).limit(1)
        if (existing) await tx.update(barProducts).set({ isActive: body.isActive }).where(eq(barProducts.id, existing.id))
        else if (body.isActive) await tx.insert(barProducts).values({
          id: uuidv4(), barId, productId: body.productId, tenantId, isActive: true,
        })
        return "ok"
      })
      if (result === "no_product") return c.json({ error: "Producto no encontrado o desactivado" }, 404)
      if (result === "disabled") return c.json({ error: "Este evento no admite consumiciones" }, 400)
      return c.json({ ok: true })
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
        countingUnit: inventoryItems.countingUnit,
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
          countingUnit: r.countingUnit,
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
  .put("/:barId/product-stock", zValidator("json", setBarProductStockSchema), async (c) => {
    const ctx = c as unknown as AuthenticatedContext
    if (!["ADMIN", "MANAGER"].includes(ctx.staff.role)) return c.json({ error: "No tenés permiso para modificar el stock" }, 403)
    const tenantId = requireTenantId(ctx)
    if (!tenantId) return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    const body = c.req.valid("json")
    const barId = c.req.param("barId")
    const db = drizzle(pool)
    const bar = await requireBarForTenant(db, barId, tenantId)
    if (!bar) return c.json({ error: "Barra no encontrada" }, 404)
    const result = await db.transaction(async (tx) => {
      const [event] = await tx.select().from(events).where(and(eq(events.id, bar.eventId), eq(events.tenantId, tenantId))).limit(1).for("update")
      if (!event || !eventTracksStock(event.operationMode ?? "FULL_OPERATION")) return "disabled"
      const [product] = await tx.select().from(products).where(and(eq(products.id, body.productId), eq(products.tenantId, tenantId))).limit(1)
      const [menu] = await tx.select().from(barProducts).where(and(eq(barProducts.barId, barId), eq(barProducts.productId, body.productId), eq(barProducts.tenantId, tenantId))).limit(1).for("update")
      if (!product || !menu) return "missing"
      const recipe = await tx.select({ id: productRecipes.id }).from(productRecipes).where(eq(productRecipes.productId, product.id)).limit(1)
      if (recipe.length && body.quantity != null) return "recipe"
      const current = menu.directStock == null ? null : decFromDb(menu.directStock)
      const next = body.quantity == null ? null : dec(body.quantity)
      if (current === null ? next === null : next !== null && current.eq(next)) return "ok"
      const expected = body.expectedCurrentStock == null ? null : dec(body.expectedCurrentStock)
      if (current === null ? expected !== null : expected === null || !current.eq(expected)) return "conflict"
      if (body.totalCost && dec(body.totalCost).gt(0)) {
        if (next === null || next.lte(current ?? dec(0))) return "invalid_cost"
        await tx.insert(eventExpenses).values({ id: uuidv4(), tenantId, eventId: bar.eventId,
          amount: decToDb(dec(body.totalCost)), category: "FOOD",
          description: `Compra para ${bar.name}: ${product.name}`.slice(0, 255),
        })
      }
      await tx.update(barProducts).set({ directStock: next === null ? null : decToDb(next) }).where(eq(barProducts.id, menu.id))
      return "ok"
    })
    if (result === "disabled") return c.json({ error: "Este evento no usa control de stock" }, 400)
    if (result === "missing") return c.json({ error: "Producto no encontrado en esta barra" }, 404)
    if (result === "recipe") return c.json({ error: "Este producto usa insumos: actualizá sus existencias" }, 400)
    if (result === "conflict") return c.json({ error: "El stock cambió mientras lo editabas. Revisá el conteo actual." }, 409)
    if (result === "invalid_cost") return c.json({ error: "El costo sólo se registra al ingresar mercadería" }, 400)
    return c.json({ ok: true, directStock: body.quantity })
  })
  .put("/:barId/stock", zValidator("json", setBarStockSchema), async (c) => {
    const ctx = c as unknown as AuthenticatedContext
    if (ctx.staff.role !== "ADMIN" && ctx.staff.role !== "MANAGER") {
      return c.json({ error: "No tenés permiso para modificar el stock" }, 403)
    }
    const tenantId = requireTenantId(ctx)
    if (!tenantId) return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    const db = drizzle(pool)
    const barId = c.req.param("barId")
    const body = c.req.valid("json")
    const bar = await requireBarForTenant(db, barId, tenantId)
    if (!bar) return c.json({ error: "Barra no encontrada" }, 404)
    const result = await db.transaction(async (tx) => {
      // Serializa altas simultáneas, incluso cuando todavía no existe stock.
      const [event] = await tx.select().from(events).where(and(
        eq(events.id, bar.eventId), eq(events.tenantId, tenantId)
      )).limit(1).for("update")
      if (!event || !eventTracksStock(event.operationMode ?? "FULL_OPERATION")) return { kind: "disabled" as const }
      const [item] = await tx.select().from(inventoryItems).where(and(
        eq(inventoryItems.id, body.inventoryItemId), eq(inventoryItems.tenantId, tenantId),
        eq(inventoryItems.isActive, true)
      )).limit(1)
      if (!item) return { kind: "no_item" as const }
      const conversion = stockAllocatedToBaseUnits(item, body.quantity, body.stockInputAs)
      if (conversion.error) return { kind: "invalid" as const, error: conversion.error }
      const [aggregate] = await tx.select().from(eventInventory).where(and(
        eq(eventInventory.eventId, bar.eventId), eq(eventInventory.tenantId, tenantId),
        eq(eventInventory.inventoryItemId, item.id)
      )).limit(1).for("update")
      const [existing] = await tx.select().from(barInventory).where(and(
        eq(barInventory.barId, barId), eq(barInventory.tenantId, tenantId),
        eq(barInventory.inventoryItemId, item.id)
      )).limit(1).for("update")
      const current = decFromDb(existing?.currentStock ?? "0")
      const next = dec(decToDb(conversion.value))
      const stock = decToDb(next)
      if (body.totalCost != null && dec(body.totalCost).gt(0) && next.lt(current)) return { kind: "invalid" as const, error: "El costo sólo se registra al ingresar mercadería" }
      // Un reintento del mismo conteo es idempotente. Un conteo desactualizado no
      // pisa ventas ni cambios de otro operador.
      if (current.eq(next)) return { kind: "ok" as const, stock }
      if (!current.eq(dec(body.expectedCurrentStock))) return { kind: "conflict" as const }
      const siblingStocks = await tx.select({ stock: barInventory.currentStock })
        .from(barInventory).innerJoin(bars, eq(bars.id, barInventory.barId)).where(and(
          eq(bars.eventId, bar.eventId), eq(bars.tenantId, tenantId),
          eq(barInventory.tenantId, tenantId), eq(barInventory.inventoryItemId, item.id), ne(barInventory.barId, barId)
        ))
      const total = siblingStocks.reduce((sum, row) => sum.plus(decFromDb(row.stock)), next)
      if (aggregate) {
        const updated = decFromDb(aggregate.stockAllocated).plus(next.minus(current))
        await tx.update(eventInventory).set({ stockAllocated: decToDb(updated.lt(total) ? total : updated) })
          .where(eq(eventInventory.id, aggregate.id))
      } else {
        await tx.insert(eventInventory).values({ id: uuidv4(), tenantId, eventId: bar.eventId,
          inventoryItemId: item.id, stockAllocated: decToDb(total) })
      }
      if (body.totalCost != null && dec(body.totalCost).gt(0)) {
        const added = next.minus(current)
        const purchaseId = uuidv4()
        const factor = item.baseUnit === "UNIT" ? dec(1) : decFromDb(item.packageSize)
        await tx.insert(purchases).values({ id: purchaseId, tenantId, eventId: bar.eventId,
          inventoryItemId: item.id, quantity: decToDb(added.div(factor.gt(0) ? factor : dec(1))),
          countingUnit: item.countingUnit, totalCost: decToDb(dec(body.totalCost)),
          createdBy: ctx.staff.id, note: `Ingreso en ${bar.name}`.slice(0, 255),
        })
        await tx.insert(eventExpenses).values({ id: uuidv4(), tenantId, eventId: bar.eventId,
          purchaseId, category: "FOOD", amount: decToDb(dec(body.totalCost)),
          description: `Compra para ${bar.name}: ${item.name}`.slice(0, 255),
        })
      }
      if (existing) await tx.update(barInventory).set({ currentStock: stock }).where(eq(barInventory.id, existing.id))
      else await tx.insert(barInventory).values({ id: uuidv4(), tenantId, barId, inventoryItemId: item.id, currentStock: stock })
      return { kind: "ok" as const, stock }
    })
    if (result.kind === "disabled") return c.json({ error: "Este evento no usa control de stock" }, 400)
    if (result.kind === "no_item") return c.json({ error: "Insumo no encontrado" }, 404)
    if (result.kind === "invalid") return c.json({ error: result.error }, 400)
    if (result.kind === "conflict") return c.json({ error: "El stock cambió mientras lo editabas. Revisá la cantidad actual y volvé a guardar." }, 409)
    await emitCommittedStockDeltas(tenantId, bar.eventId, {
      eventItemIds: [body.inventoryItemId], barDeltas: { barId, itemIds: [body.inventoryItemId] },
    })
    return c.json({ ok: true, currentStock: result.stock })
  })
  .patch(
    "/:barId/inventory",
    zValidator("json", patchBarInventorySchema),
    async (c) => {
      const ctx = c as AuthenticatedContext
      if (!["ADMIN", "MANAGER"].includes(ctx.staff.role)) return c.json({ error: "No tenés permiso para modificar el stock" }, 403)
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
    if (!["ADMIN", "MANAGER"].includes(ctx.staff.role)) return c.json({ error: "No tenés permiso para modificar el stock" }, 403)
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
        receiptToken?: string
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
          .limit(1).for("update")

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

        // Descuento de stock por receta (cantidad 1: es UN QR individual). El mismo
        // helper hace la entrega en lote de pedidos con la cantidad agregada por producto.
        const inventoryItemIds = row.sale.source === "POS" ? [] : await deductRecipeStock(
          tx,
          { tenantId, eventId: bar.eventId, barId },
          [
            {
              productId: row.consumption.productId,
              quantity: 1,
              saleType: row.productSaleType,
            },
          ]
        )

        return {
          kind: "ok" as const,
          productName: row.productName,
          eventId: bar.eventId,
          receiptToken: row.sale.receiptToken,
          inventoryItemIds,
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
      if (result.kind === "ok" && result.receiptToken) {
        broadcastReceiptUpdate(result.receiptToken)
      }

      return c.json({
        ok: true,
        productName: result.productName,
        message: `Servir: 1× ${result.productName}`,
      })
    }
  )
  // Pedido de retiro (tarea 4.2): la tablet del barman ve la lista antes de entregar.
  // El QR del pedido codifica el token; sin auth el client puede verlo (GET público en
  // public.ts), acá está scoped a la barra del evento del pedido.
  .get("/:barId/pickups/:token", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const barId = c.req.param("barId")
    const token = c.req.param("token")
    const db = drizzle(pool)

    const [bar] = await db
      .select()
      .from(bars)
      .where(and(eq(bars.id, barId), eq(bars.tenantId, tenantId)))
      .limit(1)
    if (!bar) {
      return c.json({ error: "Barra no encontrada" }, 404)
    }

    const [order] = await db
      .select()
      .from(pickupOrders)
      .where(eq(pickupOrders.token, token))
      .limit(1)
    if (!order) {
      return c.json({ error: "Pedido no encontrado" }, 404)
    }
    if (order.eventId !== bar.eventId) {
      return c.json({ error: "Este pedido no pertenece a este evento" }, 400)
    }

    const [items, stockShortages] = await Promise.all([
      pickupItemsWithNames(db, order.itemsJson),
      findPickupStockShortages(db, { tenantId, eventId: bar.eventId, barId }, order.itemsJson ?? []),
    ])
    return c.json({
      token: order.token,
      status: order.status,
      createdAt: order.createdAt ?? null,
      deliveredAt: order.deliveredAt ?? null,
      items,
      stockShortages,
    })
  })
  // Entrega de pedido de retiro (tarea 4.2): el barman escanea el QR del pedido, ve la
  // lista en pantalla y toca "Entregado". Transaccional: valida que el pedido esté PENDING
  // y que TODAS sus consumiciones sigan PENDING y pertenezcan al evento de la barra, marca
  // todas REDEEMED, descuenta stock por receta UNA vez por producto (cantidad agregada) y
  // responde el detalle para el overlay "SERVIR 2× Fernet, 1× Gancia". El pedido queda
  // DELIVERED con `deliveredBy` (lo ve el client en GET /pickups/:token). El canje 1×1
  // (`redeem`) sigue igual para QRs individuales.
  .post("/:barId/pickups/:token/deliver", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const barId = c.req.param("barId")
    const token = c.req.param("token")
    const db = drizzle(pool)

    let result: {
      kind:
        | "no_bar"
        | "no_order"
        | "already_delivered"
        | "wrong_event"
        | "race_used"
        | "ok"
      items?: { productId: string; productName: string; quantity: number }[]
      totalAmount?: string
      eventId?: string
      customerId?: string
      pickupToken?: string
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

        const [order] = await tx
          .select()
          .from(pickupOrders)
          .where(eq(pickupOrders.token, token))
          .limit(1)
        if (!order) {
          return { kind: "no_order" as const }
        }
        if (order.status !== "PENDING") {
          return { kind: "already_delivered" as const }
        }
        if (order.eventId !== bar.eventId) {
          return { kind: "wrong_event" as const }
        }

        const items = order.itemsJson ?? []
        if (items.length === 0) {
          return { kind: "no_order" as const }
        }

        const consumptionIds = items.map((i) => i.consumptionId)
        const consRows = await tx
          .select()
          .from(digitalConsumptions)
          .where(
            and(
              inArray(digitalConsumptions.id, consumptionIds),
              eq(digitalConsumptions.tenantId, tenantId)
            )
          ).for("update")

        if (consRows.length !== consumptionIds.length) {
          return { kind: "race_used" as const }
        }

        const redeemed = await redeemConsumptionSet(
          tx,
          { tenantId, eventId: bar.eventId, barId, staffId: ctx.staff.id },
          consRows
        )
        if (redeemed.kind !== "ok") {
          return { kind: redeemed.kind }
        }

        // Pedido entregado: queda DELIVERED con quién/cuándo (lo muestra el client).
        await tx
          .update(pickupOrders)
          .set({
            status: "DELIVERED",
            deliveredAt: new Date(),
            deliveredBy: ctx.staff.id,
          })
          .where(eq(pickupOrders.id, order.id))

        return {
          kind: "ok" as const,
          items: redeemed.items,
          totalAmount: redeemed.totalAmount,
          eventId: bar.eventId,
          customerId: order.customerId,
          pickupToken: order.token,
          inventoryItemIds: redeemed.inventoryItemIds,
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
    if (result.kind === "no_order") {
      return c.json({ error: "Pedido no encontrado" }, 404)
    }
    if (result.kind === "already_delivered") {
      return c.json({ error: "Este pedido ya fue entregado" }, 409)
    }
    if (result.kind === "wrong_event") {
      return c.json({ error: "Este pedido no pertenece a este evento" }, 400)
    }
    if (result.kind === "race_used") {
      return c.json({ error: "Algunas consumiciones ya fueron canjeadas" }, 409)
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
    if (result.kind === "ok") {
      broadcastPickupUpdate(result.pickupToken!)
      const customerReceipts = await db
        .select({ receiptToken: sales.receiptToken })
        .from(sales)
        .where(
          and(
            eq(sales.customerId, result.customerId!),
            eq(sales.eventId, result.eventId!)
          )
        )
      for (const receipt of customerReceipts) {
        broadcastReceiptUpdate(receipt.receiptToken)
      }
    }

    return c.json({
      ok: true,
      items: result.items,
      totalAmount: result.totalAmount,
      message: `Servir: ${(result.items ?? [])
        .map((i) => `${i.quantity}× ${i.productName}`)
        .join(", ")}`,
    })
  })
  // Entrega por comprobante de venta: el QR del recibo impreso en caja codifica
  // `sales.receiptToken`, así que la venta ES el pedido. Es el único camino escaneable de una
  // venta anónima (sin DNI), que hasta ahora no imprimía ningún QR. Mismo contrato que los
  // pedidos de retiro: preview idempotente por GET y entrega transaccional por POST.
  .get("/:barId/sales/:receiptToken", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const barId = c.req.param("barId")
    const receiptToken = c.req.param("receiptToken")
    const db = drizzle(pool)

    const [bar] = await db
      .select()
      .from(bars)
      .where(and(eq(bars.id, barId), eq(bars.tenantId, tenantId)))
      .limit(1)
    if (!bar) {
      return c.json({ error: "Barra no encontrada" }, 404)
    }

    const [sale] = await db
      .select()
      .from(sales)
      .where(
        and(eq(sales.receiptToken, receiptToken), eq(sales.tenantId, tenantId))
      )
      .limit(1)
    if (!sale) {
      return c.json({ error: "Venta no encontrada" }, 404)
    }
    if (sale.eventId !== bar.eventId) {
      return c.json({ error: "Esta venta no pertenece a este evento" }, 400)
    }
    // Una venta de caja se sirve en la barra que la cobró: el descuento de stock sale del
    // `barInventory` de la barra que entrega. Las ventas de app (`barId` null) siguen siendo
    // servibles en cualquier barra del evento, igual que el canje 1×1.
    if (sale.barId != null && sale.barId !== barId) {
      return c.json({ error: "Esta venta no es válida en esta barra" }, 400)
    }

    const consRows = await db
      .select({
        id: digitalConsumptions.id,
        productId: digitalConsumptions.productId,
        status: digitalConsumptions.status,
      })
      .from(digitalConsumptions)
      .where(
        and(
          eq(digitalConsumptions.saleId, sale.id),
          eq(digitalConsumptions.tenantId, tenantId)
        )
      )
    if (consRows.length === 0) {
      return c.json(
        { error: "Esta venta no tiene consumiciones para servir" },
        400
      )
    }

    const pending = consRows.filter((r) => r.status === "PENDING")
    const deliveredQuantity = consRows.filter(
      (r) => r.status === "REDEEMED"
    ).length
    // Cada consumición es una unidad: mismo shape que el itemsJson de un pedido de retiro.
    const items = await pickupItemsWithNames(
      db,
      pending.map((r) => ({
        consumptionId: r.id,
        productId: r.productId,
        quantity: 1,
      }))
    )
    const stockShortages = sale.source === "POS" ? [] : await findPickupStockShortages(
      db,
      { tenantId, eventId: bar.eventId, barId },
      items
    )
    return c.json({
      token: sale.receiptToken,
      status:
        pending.length > 0
          ? "PENDING"
          : deliveredQuantity > 0
            ? "DELIVERED"
            : "CANCELLED",
      items,
      pendingQuantity: pending.length,
      deliveredQuantity,
      totalQuantity: consRows.length,
      stockShortages,
    })
  })
  // Entrega de la venta completa: el barman escanea el QR del recibo y sirve todo lo que quede
  // PENDING de esa venta. Idempotente: el segundo intento no escribe nada.
  .post("/:barId/sales/:receiptToken/deliver", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const barId = c.req.param("barId")
    const receiptToken = c.req.param("receiptToken")
    const db = drizzle(pool)

    let result: {
      kind:
        | "no_bar"
        | "no_sale"
        | "wrong_event"
        | "wrong_bar"
        | "no_consumptions"
        | "already_delivered"
        | "race_used"
        | "ok"
      items?: { productId: string; productName: string; quantity: number }[]
      totalAmount?: string
      eventId?: string
      receiptToken?: string
      inventoryItemIds?: string[]
      closedPickupTokens?: string[]
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

        const [sale] = await tx
          .select()
          .from(sales)
          .where(
            and(
              eq(sales.receiptToken, receiptToken),
              eq(sales.tenantId, tenantId)
            )
          )
          .limit(1)
        if (!sale) {
          return { kind: "no_sale" as const }
        }
        if (sale.eventId !== bar.eventId) {
          return { kind: "wrong_event" as const }
        }
        if (sale.barId != null && sale.barId !== barId) {
          return { kind: "wrong_bar" as const }
        }

        const consRows = await tx
          .select()
          .from(digitalConsumptions)
          .where(
            and(
              eq(digitalConsumptions.saleId, sale.id),
              eq(digitalConsumptions.tenantId, tenantId)
            )
          ).for("update")

      if (consRows.length === 0) {
          return { kind: "no_consumptions" as const }
        }

        const pending = consRows.filter((r) => r.status === "PENDING")
        if (pending.length === 0) {
          // Nada que servir: ya se entregó por este recibo o canjeando los QRs individuales.
          return consRows.some((r) => r.status === "REDEEMED")
            ? { kind: "already_delivered" as const }
            : { kind: "no_consumptions" as const }
        }

        const redeemed = await redeemConsumptionSet(
          tx,
          { tenantId, eventId: bar.eventId, barId, staffId: ctx.staff.id },
          pending
        )
        if (redeemed.kind !== "ok") {
          return { kind: redeemed.kind }
        }

        // Cierre de los pedidos de retiro que esta entrega dejó completos. `pickupOrders` no
        // guarda `saleId`: el vínculo son los `consumptionId` del itemsJson. Sólo se cierran los
        // pedidos cubiertos ENTEROS por lo entregado; uno que mezcle consumiciones de otra venta
        // sigue PENDING y es retirable por el resto.
        const closedPickupTokens: string[] = []
        if (sale.customerId != null) {
          const openPickups = await tx
            .select()
            .from(pickupOrders)
            .where(
              and(
                eq(pickupOrders.tenantId, tenantId),
                eq(pickupOrders.eventId, bar.eventId),
                eq(pickupOrders.customerId, sale.customerId),
                eq(pickupOrders.status, "PENDING")
              )
            )
          const deliveredIds = new Set(pending.map((r) => r.id))
          const covered = openPickups.filter((o) => {
            const its = o.itemsJson ?? []
            return (
              its.length > 0 &&
              its.every((i) => deliveredIds.has(i.consumptionId))
            )
          })
          for (const o of covered) {
            await tx
              .update(pickupOrders)
              .set({
                status: "DELIVERED",
                deliveredAt: new Date(),
                deliveredBy: ctx.staff.id,
              })
              .where(
                and(eq(pickupOrders.id, o.id), eq(pickupOrders.status, "PENDING"))
              )
            closedPickupTokens.push(o.token)
          }
        }

        return {
          kind: "ok" as const,
          items: redeemed.items,
          totalAmount: redeemed.totalAmount,
          eventId: bar.eventId,
          receiptToken: sale.receiptToken,
          inventoryItemIds: redeemed.inventoryItemIds,
          closedPickupTokens,
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
    if (result.kind === "no_sale") {
      return c.json({ error: "Venta no encontrada" }, 404)
    }
    if (result.kind === "wrong_event") {
      return c.json({ error: "Esta venta no pertenece a este evento" }, 400)
    }
    if (result.kind === "wrong_bar") {
      return c.json({ error: "Esta venta no es válida en esta barra" }, 400)
    }
    if (result.kind === "no_consumptions") {
      return c.json(
        { error: "Esta venta no tiene consumiciones para servir" },
        400
      )
    }
    if (result.kind === "already_delivered") {
      return c.json({ error: "Esta venta ya fue entregada" }, 409)
    }
    if (result.kind === "race_used") {
      return c.json({ error: "Algunas consumiciones ya fueron canjeadas" }, 409)
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
    if (result.kind === "ok") {
      broadcastReceiptUpdate(result.receiptToken!)
      for (const t of result.closedPickupTokens ?? []) {
        broadcastPickupUpdate(t)
      }
    }

    return c.json({
      ok: true,
      items: result.items,
      totalAmount: result.totalAmount,
      message: `Servir: ${(result.items ?? [])
        .map((i) => `${i.quantity}× ${i.productName}`)
        .join(", ")}`,
    })
  })
