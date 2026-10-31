import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import type { MySql2Database } from "drizzle-orm/mysql2"
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { pool } from "../db"
import {
  barInventory,
  bars,
  eventExpenses,
  eventInventory,
  eventStaff,
  eventStockMovements,
  events,
  inventoryItems,
  purchases,
  staff,
} from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { dec, decFromDb, decToDb, stockToDb } from "../lib/decimal-money"
import { stockAllocatedToBaseUnits } from "../lib/inventory-deduction"
import { eventTracksStock } from "../lib/event-operation-mode"
import { emitCommittedStockDeltas } from "../lib/event-stock-broadcast"

function requireTenantId(ctx: AuthenticatedContext): string | null {
  const id = ctx.staff.tenantId
  return id == null || id === "" ? null : id
}

type EventRow = typeof events.$inferSelect

type AccessResult =
  | { ok: true; event: EventRow; tenantId: string }
  | { ok: false; status: 400 | 403 | 404; error: string }

async function requireDepositEvent(
  db: MySql2Database<Record<string, never>>,
  ctx: AuthenticatedContext,
  eventId: string
): Promise<AccessResult> {
  if (!["ADMIN", "MANAGER", "DEPOSIT"].includes(ctx.staff.role)) {
    return { ok: false, status: 403, error: "No tenés permiso para operar el depósito." }
  }
  const tenantId = requireTenantId(ctx)
  if (!tenantId) {
    return { ok: false, status: 400, error: "Tu cuenta no tiene tenant asignado." }
  }
  const [event] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
    .limit(1)
  if (!event) return { ok: false, status: 404, error: "Evento no encontrado" }

  if (ctx.staff.role === "DEPOSIT") {
    const [assignment] = await db
      .select({ id: eventStaff.id })
      .from(eventStaff)
      .where(
        and(
          eq(eventStaff.eventId, eventId),
          eq(eventStaff.staffId, ctx.staff.id),
          eq(eventStaff.tenantId, tenantId)
        )
      )
      .limit(1)
    if (!assignment) {
      return { ok: false, status: 403, error: "No estás asignado a este evento." }
    }
  }
  return { ok: true, event, tenantId }
}

const depositStockSchema = z.object({
  inventoryItemId: z.string().min(1).max(36),
  mode: z.enum(["add", "count"]),
  quantity: z.string().regex(/^\d+(\.\d{1,6})?$/).max(18),
  expectedDepositStock: z.string().regex(/^\d+(\.\d{1,6})?$/).max(18).optional(),
  totalCost: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/).optional(),
  note: z.string().trim().max(255).optional(),
})

const transferSchema = z.object({
  inventoryItemId: z.string().min(1).max(36),
  barId: z.string().min(1).max(36),
  quantity: z.string().regex(/^\d+(\.\d{1,6})?$/).max(18),
  expectedDepositStock: z.string().regex(/^\d+(\.\d{1,6})?$/).max(18).optional(),
  expectedBarStock: z.string().regex(/^\d+(\.\d{1,6})?$/).max(18).optional(),
  note: z.string().trim().max(255).optional(),
})

function stockSum(rows: { stock: string | null }[]): ReturnType<typeof dec> {
  return rows.reduce((sum, row) => sum.plus(decFromDb(row.stock)), dec(0))
}

function depositFrom(total: ReturnType<typeof dec>, inBars: ReturnType<typeof dec>) {
  const available = total.minus(inBars)
  return available.lt(dec(0)) ? dec(0) : available
}

export const depositRoute = new Hono()
  .use("*", authMiddleware)
  .get("/:id/deposit", async (c) => {
    const ctx = c as unknown as AuthenticatedContext
    const db = drizzle(pool)
    const access = await requireDepositEvent(db, ctx, c.req.param("id"))
    if (!access.ok) return c.json({ error: access.error }, access.status)
    const { event, tenantId } = access

    const [eventBars, itemRows, evRows, movementRows, lastMovementRows] =
      await Promise.all([
        db
          .select({ id: bars.id, name: bars.name, isActive: bars.isActive })
          .from(bars)
          .where(and(eq(bars.eventId, event.id), eq(bars.tenantId, tenantId)))
          .orderBy(asc(bars.name)),
        db
          .select({
            id: inventoryItems.id,
            name: inventoryItems.name,
            createdAt: inventoryItems.createdAt,
          })
          .from(inventoryItems)
          .where(
            and(
              eq(inventoryItems.tenantId, tenantId),
              eq(inventoryItems.isActive, true)
            )
          )
          .orderBy(desc(inventoryItems.createdAt), asc(inventoryItems.name)),
        db
          .select({
            inventoryItemId: eventInventory.inventoryItemId,
            stockAllocated: eventInventory.stockAllocated,
          })
          .from(eventInventory)
          .where(
            and(
              eq(eventInventory.eventId, event.id),
              eq(eventInventory.tenantId, tenantId)
            )
          ),
        db
          .select({
            id: eventStockMovements.id,
            type: eventStockMovements.type,
            createdAt: eventStockMovements.createdAt,
            inventoryItemId: eventStockMovements.inventoryItemId,
            itemName: inventoryItems.name,
            barId: eventStockMovements.barId,
            barName: bars.name,
            quantity: eventStockMovements.quantity,
            depositAfter: eventStockMovements.depositAfter,
            barAfter: eventStockMovements.barAfter,
            note: eventStockMovements.note,
            createdByName: staff.name,
          })
          .from(eventStockMovements)
          .innerJoin(
            inventoryItems,
            eq(eventStockMovements.inventoryItemId, inventoryItems.id)
          )
          .leftJoin(bars, eq(eventStockMovements.barId, bars.id))
          .leftJoin(staff, eq(eventStockMovements.createdBy, staff.id))
          .where(
            and(
              eq(eventStockMovements.eventId, event.id),
              eq(eventStockMovements.tenantId, tenantId)
            )
          )
          .orderBy(desc(eventStockMovements.createdAt))
          .limit(150),
        db
          .select({
            barId: eventStockMovements.barId,
            last: sql<Date | string | null>`max(${eventStockMovements.createdAt})`,
          })
          .from(eventStockMovements)
          .where(
            and(
              eq(eventStockMovements.eventId, event.id),
              eq(eventStockMovements.tenantId, tenantId)
            )
          )
          .groupBy(eventStockMovements.barId),
      ])

    const barIds = eventBars.map((bar) => bar.id)
    const barRows =
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
                eq(bars.eventId, event.id),
                eq(bars.tenantId, tenantId),
                inArray(barInventory.barId, barIds)
              )
            )

    const totalByItem = new Map(
      evRows.map((row) => [row.inventoryItemId, decFromDb(row.stockAllocated)])
    )
    const inBarsByItem = new Map<string, ReturnType<typeof dec>>()
    for (const row of barRows) {
      const current = inBarsByItem.get(row.inventoryItemId) ?? dec(0)
      inBarsByItem.set(row.inventoryItemId, current.plus(decFromDb(row.currentStock)))
    }

    const lastMovementByBar = new Map(
      lastMovementRows
        .filter((row) => row.barId != null)
        .map((row) => [
          row.barId!,
          row.last == null
            ? null
            : row.last instanceof Date
              ? row.last.toISOString()
              : String(row.last),
        ])
    )

    return c.json({
      tracksStock: eventTracksStock(event.operationMode ?? "FULL_OPERATION"),
      items: itemRows.map((item) => {
        const total = totalByItem.get(item.id) ?? dec(0)
        const inBars = inBarsByItem.get(item.id) ?? dec(0)
        return {
          inventoryItemId: item.id,
          name: item.name,
          createdAt: item.createdAt?.toISOString() ?? null,
          eventStock: stockToDb(total),
          inBars: stockToDb(inBars),
          depositStock: stockToDb(depositFrom(total, inBars)),
        }
      }),
      bars: eventBars.map((bar) => {
        const rows = barRows.filter((row) => row.barId === bar.id)
        const units = stockSum(rows.map((row) => ({ stock: row.currentStock })))
        return {
          id: bar.id,
          name: bar.name,
          isActive: bar.isActive !== false,
          itemCount: rows.filter((row) => decFromDb(row.currentStock).gt(0)).length,
          totalUnits: stockToDb(units),
          lastMovementAt: lastMovementByBar.get(bar.id) ?? null,
        }
      }),
      barInventory: barRows.map((row) => ({
        barId: row.barId,
        inventoryItemId: row.inventoryItemId,
        currentStock: String(row.currentStock),
      })),
      movements: movementRows.map((row) => ({
        id: row.id,
        type: row.type,
        createdAt: row.createdAt?.toISOString() ?? null,
        inventoryItemId: row.inventoryItemId,
        itemName: row.itemName,
        barId: row.barId ?? null,
        barName: row.barName ?? null,
        quantity: String(row.quantity),
        depositAfter: String(row.depositAfter),
        barAfter: row.barAfter == null ? null : String(row.barAfter),
        note: row.note ?? null,
        createdByName: row.createdByName ?? null,
      })),
    })
  })
  .post(
    "/:id/deposit/stock",
    zValidator("json", depositStockSchema),
    async (c) => {
      const ctx = c as unknown as AuthenticatedContext
      const db = drizzle(pool)
      const access = await requireDepositEvent(db, ctx, c.req.param("id"))
      if (!access.ok) return c.json({ error: access.error }, access.status)
      const { event, tenantId } = access
      const body = c.req.valid("json")

      if (!eventTracksStock(event.operationMode ?? "FULL_OPERATION")) {
        return c.json({ error: "Este evento no usa control de stock" }, 400)
      }
      if (
        body.mode === "add" &&
        dec(body.quantity).lte(0)
      ) {
        return c.json({ error: "Ingresá una cantidad mayor a cero." }, 400)
      }
      if (body.mode === "count" && body.totalCost != null && dec(body.totalCost).gt(0)) {
        return c.json(
          { error: "El costo sólo se registra al ingresar mercadería." },
          400
        )
      }

      const result = await db.transaction(async (tx) => {
        const [lockedEvent] = await tx
          .select()
          .from(events)
          .where(and(eq(events.id, event.id), eq(events.tenantId, tenantId)))
          .limit(1)
          .for("update")
        if (
          !lockedEvent ||
          !eventTracksStock(lockedEvent.operationMode ?? "FULL_OPERATION")
        ) {
          return { kind: "disabled" as const }
        }
        const [item] = await tx
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
        if (!item) return { kind: "no_item" as const }

        const [aggregate] = await tx
          .select()
          .from(eventInventory)
          .where(
            and(
              eq(eventInventory.eventId, event.id),
              eq(eventInventory.tenantId, tenantId),
              eq(eventInventory.inventoryItemId, item.id)
            )
          )
          .limit(1)
          .for("update")

        const barRows = await tx
          .select({
            id: barInventory.id,
            barId: barInventory.barId,
            stock: barInventory.currentStock,
          })
          .from(barInventory)
          .innerJoin(bars, eq(barInventory.barId, bars.id))
          .where(
            and(
              eq(bars.eventId, event.id),
              eq(bars.tenantId, tenantId),
              eq(barInventory.tenantId, tenantId),
              eq(barInventory.inventoryItemId, item.id)
            )
          )
          .for("update")

        const inBars = stockSum(barRows)
        const total = decFromDb(aggregate?.stockAllocated ?? "0")
        const currentDeposit = depositFrom(total, inBars)
        const quantity = dec(stockToDb(
          stockAllocatedToBaseUnits(item, body.quantity, "BASE_UNITS").value
        ))
        // El cliente manda el saldo que vio al abrir el editor. Con un destino absoluto, un
        // reintento después de una respuesta perdida no vuelve a sumar mercadería.
        const expectedDeposit =
          body.expectedDepositStock != null
            ? dec(body.expectedDepositStock)
            : currentDeposit
        const targetDeposit =
          body.mode === "add"
            ? expectedDeposit.plus(quantity)
            : quantity
        if (currentDeposit.eq(targetDeposit)) {
          return {
            kind: "ok" as const,
            itemId: item.id,
            depositStock: stockToDb(currentDeposit),
            eventStock: stockToDb(total),
            inBars: stockToDb(inBars),
            idempotent: true,
          }
        }
        if (!currentDeposit.eq(expectedDeposit)) {
          return { kind: "conflict" as const }
        }

        const newTotal = inBars.plus(targetDeposit)
        const totalCost =
          body.totalCost != null && dec(body.totalCost).gt(0)
            ? dec(body.totalCost)
            : null

        if (aggregate) {
          await tx
            .update(eventInventory)
            .set({ stockAllocated: stockToDb(newTotal) })
            .where(eq(eventInventory.id, aggregate.id))
        } else {
          await tx.insert(eventInventory).values({
            id: uuidv4(),
            tenantId,
            eventId: event.id,
            inventoryItemId: item.id,
            stockAllocated: stockToDb(newTotal),
          })
        }

        if (totalCost && body.mode === "add") {
          const purchaseId = uuidv4()
          await tx.insert(purchases).values({
            id: purchaseId,
            tenantId,
            eventId: event.id,
            inventoryItemId: item.id,
            quantity: decToDb(quantity),
            countingUnit: item.countingUnit,
            totalCost: decToDb(totalCost),
            createdBy: ctx.staff.id,
            note: (body.note || `Ingreso en depósito`).slice(0, 255),
          })
          await tx.insert(eventExpenses).values({
            id: uuidv4(),
            tenantId,
            eventId: event.id,
            purchaseId,
            category: "FOOD",
            amount: decToDb(totalCost),
            description: `Compra de depósito: ${item.name}`.slice(0, 255),
          })
        }

        await tx.insert(eventStockMovements).values({
          id: uuidv4(),
          tenantId,
          eventId: event.id,
          inventoryItemId: item.id,
          barId: null,
          type: body.mode === "add" ? "DEPOSIT_IN" : "DEPOSIT_COUNT",
          quantity:
            body.mode === "add"
              ? stockToDb(quantity)
              : stockToDb(targetDeposit),
          depositAfter: stockToDb(targetDeposit),
          barAfter: null,
          note: body.note?.trim() || null,
          createdBy: ctx.staff.id,
        })

        return {
          kind: "ok" as const,
          itemId: item.id,
          depositStock: stockToDb(targetDeposit),
          eventStock: stockToDb(newTotal),
          inBars: stockToDb(inBars),
        }
      })

      if (result.kind === "disabled") {
        return c.json({ error: "Este evento no usa control de stock" }, 400)
      }
      if (result.kind === "no_item") {
        return c.json({ error: "Insumo no encontrado" }, 404)
      }
      if (result.kind === "conflict") {
        return c.json(
          { error: "El depósito cambió mientras lo editabas. Revisá el saldo actual." },
          409
        )
      }

      await emitCommittedStockDeltas(tenantId, event.id, {
        eventItemIds: [result.itemId],
      })
      return c.json({
        ok: true,
        depositStock: result.depositStock,
        eventStock: result.eventStock,
        inBars: result.inBars,
      })
    }
  )
  .post(
    "/:id/deposit/transfers",
    zValidator("json", transferSchema),
    async (c) => {
      const ctx = c as unknown as AuthenticatedContext
      const db = drizzle(pool)
      const access = await requireDepositEvent(db, ctx, c.req.param("id"))
      if (!access.ok) return c.json({ error: access.error }, access.status)
      const { event, tenantId } = access
      const body = c.req.valid("json")

      if (!eventTracksStock(event.operationMode ?? "FULL_OPERATION")) {
        return c.json({ error: "Este evento no usa control de stock" }, 400)
      }
      if (dec(body.quantity).lte(0)) {
        return c.json({ error: "Ingresá una cantidad mayor a cero." }, 400)
      }

      const result = await db.transaction(async (tx) => {
        const [lockedEvent] = await tx
          .select()
          .from(events)
          .where(and(eq(events.id, event.id), eq(events.tenantId, tenantId)))
          .limit(1)
          .for("update")
        if (
          !lockedEvent ||
          !eventTracksStock(lockedEvent.operationMode ?? "FULL_OPERATION")
        ) {
          return { kind: "disabled" as const }
        }
        const [bar] = await tx
          .select()
          .from(bars)
          .where(
            and(
              eq(bars.id, body.barId),
              eq(bars.eventId, event.id),
              eq(bars.tenantId, tenantId)
            )
          )
          .limit(1)
          .for("update")
        if (!bar) return { kind: "no_bar" as const }

        const [item] = await tx
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
        if (!item) return { kind: "no_item" as const }

        const [aggregate] = await tx
          .select()
          .from(eventInventory)
          .where(
            and(
              eq(eventInventory.eventId, event.id),
              eq(eventInventory.tenantId, tenantId),
              eq(eventInventory.inventoryItemId, item.id)
            )
          )
          .limit(1)
          .for("update")

        const stockRows = await tx
          .select({
            id: barInventory.id,
            barId: barInventory.barId,
            stock: barInventory.currentStock,
          })
          .from(barInventory)
          .innerJoin(bars, eq(barInventory.barId, bars.id))
          .where(
            and(
              eq(bars.eventId, event.id),
              eq(bars.tenantId, tenantId),
              eq(barInventory.tenantId, tenantId),
              eq(barInventory.inventoryItemId, item.id)
            )
          )
          .for("update")

        const inBars = stockSum(stockRows)
        const total = decFromDb(aggregate?.stockAllocated ?? "0")
        const currentDeposit = depositFrom(total, inBars)
        const quantity = dec(
          stockToDb(stockAllocatedToBaseUnits(item, body.quantity, "BASE_UNITS").value)
        )
        if (quantity.lte(0)) {
          return { kind: "invalid" as const, error: "Ingresá una cantidad mayor a cero." }
        }

        const targetRow = stockRows.find((row) => row.barId === bar.id)
        const currentBar = targetRow ? decFromDb(targetRow.stock) : dec(0)
        // Saldos que el cliente vio al confirmar. El destino absoluto hace que un reintento
        // después de una respuesta perdida no envíe la mercadería dos veces.
        const expectedDeposit =
          body.expectedDepositStock != null
            ? dec(body.expectedDepositStock)
            : currentDeposit
        const expectedBar =
          body.expectedBarStock != null ? dec(body.expectedBarStock) : currentBar
        const nextBar = expectedBar.plus(quantity)
        const nextDeposit = expectedDeposit.minus(quantity)
        if (currentBar.eq(nextBar) && currentDeposit.eq(nextDeposit)) {
          return {
            kind: "ok" as const,
            itemId: item.id,
            barId: bar.id,
            barName: bar.name,
            itemName: item.name,
            quantity: stockToDb(quantity),
            depositStock: stockToDb(currentDeposit),
            barStock: stockToDb(currentBar),
            idempotent: true,
          }
        }
        if (
          !currentDeposit.eq(expectedDeposit) ||
          !currentBar.eq(expectedBar)
        ) {
          return { kind: "conflict" as const }
        }
        if (quantity.gt(currentDeposit)) {
          return {
            kind: "insufficient" as const,
            depositStock: currentDeposit.toString(),
            itemName: item.name,
          }
        }

        if (targetRow) {
          await tx
            .update(barInventory)
            .set({ currentStock: stockToDb(nextBar) })
            .where(eq(barInventory.id, targetRow.id))
        } else {
          await tx.insert(barInventory).values({
            id: uuidv4(),
            tenantId,
            barId: bar.id,
            inventoryItemId: item.id,
            currentStock: stockToDb(nextBar),
          })
        }

        await tx.insert(eventStockMovements).values({
          id: uuidv4(),
          tenantId,
          eventId: event.id,
          inventoryItemId: item.id,
          barId: bar.id,
          type: "SEND_TO_BAR",
          quantity: stockToDb(quantity),
          depositAfter: stockToDb(nextDeposit),
          barAfter: stockToDb(nextBar),
          note: body.note?.trim() || null,
          createdBy: ctx.staff.id,
        })

        return {
          kind: "ok" as const,
          itemId: item.id,
          barId: bar.id,
          barName: bar.name,
          itemName: item.name,
          quantity: stockToDb(quantity),
          depositStock: stockToDb(nextDeposit),
          barStock: stockToDb(nextBar),
        }
      })

      if (result.kind === "disabled") {
        return c.json({ error: "Este evento no usa control de stock" }, 400)
      }
      if (result.kind === "no_bar") {
        return c.json({ error: "Barra no encontrada" }, 404)
      }
      if (result.kind === "no_item") {
        return c.json({ error: "Insumo no encontrado" }, 404)
      }
      if (result.kind === "invalid") {
        return c.json({ error: result.error }, 400)
      }
      if (result.kind === "conflict") {
        return c.json(
          { error: "El depósito cambió mientras enviabas. Revisá el saldo actual." },
          409
        )
      }
      if (result.kind === "insufficient") {
        return c.json(
          {
            error: `El depósito no tiene suficiente ${result.itemName}. Disponible: ${result.depositStock}.`,
          },
          409
        )
      }

      await emitCommittedStockDeltas(tenantId, event.id, {
        eventItemIds: [result.itemId],
        barDeltas: { barId: result.barId, itemIds: [result.itemId] },
      })
      return c.json({
        ok: true,
        depositStock: result.depositStock,
        barStock: result.barStock,
        quantity: result.quantity,
      })
    }
  )
