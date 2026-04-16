import { drizzle } from "drizzle-orm/mysql2"
import { and, eq, inArray } from "drizzle-orm"
import { pool } from "../db"
import { barInventory, eventInventory } from "../db/schema"

type SendFn = (message: string) => void

const rooms = new Map<string, Set<SendFn>>()

export function stockRoomSubscribe(roomKey: string, send: SendFn): () => void {
  let set = rooms.get(roomKey)
  if (!set) {
    set = new Set()
    rooms.set(roomKey, set)
  }
  set.add(send)
  return () => {
    set!.delete(send)
    if (set!.size === 0) rooms.delete(roomKey)
  }
}

function stockRoomBroadcast(roomKey: string, message: string) {
  const set = rooms.get(roomKey)
  if (!set) return
  for (const s of set) {
    try {
      s(message)
    } catch {
      /* client gone */
    }
  }
}

export type StockUpdatePayload = {
  type: "stock-update"
  eventInventory: { inventoryItemId: string; stockAllocated: string }[]
  barInventory: {
    barId: string
    inventoryItemId: string
    currentStock: string
  }[]
}

/**
 * After a committed transaction, read fresh quantities for affected rows only and broadcast.
 */
export async function emitCommittedStockDeltas(
  tenantId: string,
  eventId: string,
  spec: {
    eventItemIds?: string[]
    barDeltas?: { barId: string; itemIds: string[] }
  }
): Promise<void> {
  const roomKey = `${tenantId}:${eventId}`
  const db = drizzle(pool)

  const eventRows: StockUpdatePayload["eventInventory"] = []
  if (spec.eventItemIds && spec.eventItemIds.length > 0) {
    const rows = await db
      .select({
        inventoryItemId: eventInventory.inventoryItemId,
        stockAllocated: eventInventory.stockAllocated,
      })
      .from(eventInventory)
      .where(
        and(
          eq(eventInventory.eventId, eventId),
          eq(eventInventory.tenantId, tenantId),
          inArray(eventInventory.inventoryItemId, spec.eventItemIds)
        )
      )
    eventRows.push(
      ...rows.map((r) => ({
        inventoryItemId: r.inventoryItemId,
        stockAllocated: String(r.stockAllocated),
      }))
    )
  }

  const barRows: StockUpdatePayload["barInventory"] = []
  if (
    spec.barDeltas &&
    spec.barDeltas.itemIds.length > 0 &&
    spec.barDeltas.barId
  ) {
    const { barId, itemIds } = spec.barDeltas
    const rows = await db
      .select({
        barId: barInventory.barId,
        inventoryItemId: barInventory.inventoryItemId,
        currentStock: barInventory.currentStock,
      })
      .from(barInventory)
      .where(
        and(
          eq(barInventory.barId, barId),
          eq(barInventory.tenantId, tenantId),
          inArray(barInventory.inventoryItemId, itemIds)
        )
      )
    barRows.push(
      ...rows.map((r) => ({
        barId: r.barId,
        inventoryItemId: r.inventoryItemId,
        currentStock: String(r.currentStock),
      }))
    )
  }

  if (eventRows.length === 0 && barRows.length === 0) return

  const payload: StockUpdatePayload = {
    type: "stock-update",
    eventInventory: eventRows,
    barInventory: barRows,
  }
  stockRoomBroadcast(roomKey, JSON.stringify(payload))
}

export function makeStockRoomKey(tenantId: string, eventId: string): string {
  return `${tenantId}:${eventId}`
}
