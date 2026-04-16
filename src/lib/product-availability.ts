import { decFromDb } from "./decimal-money"

export type RecipeLineInput = {
  inventoryItemId: string
  quantityUsed: string | number
}

/**
 * How many full units of the product can be fulfilled (bottleneck across recipe lines).
 * Per line: min(floor(eventStock/q), floor(barStock/q)); overall: min of lines.
 * Missing event or bar row counts as 0.
 */
export function computeProductAvailabilityUnits(
  recipes: RecipeLineInput[],
  eventStockByItem: Map<string, string>,
  barStockByItem: Map<string, string>
): number {
  if (recipes.length === 0) {
    return Number.POSITIVE_INFINITY
  }

  let minUnits = Number.POSITIVE_INFINITY

  for (const r of recipes) {
    const q = decFromDb(
      typeof r.quantityUsed === "number"
        ? String(r.quantityUsed)
        : r.quantityUsed
    )
    if (q.lte(0)) continue

    const evRaw = eventStockByItem.get(r.inventoryItemId)
    const barRaw = barStockByItem.get(r.inventoryItemId)
    const ev = decFromDb(evRaw)
    const bar = decFromDb(barRaw)

    const fromEvent = Math.floor(ev.div(q).toNumber())
    const fromBar = Math.floor(bar.div(q).toNumber())
    const lineUnits = Math.min(fromEvent, fromBar)
    minUnits = Math.min(minUnits, lineUnits)
  }

  if (!Number.isFinite(minUnits)) return 0
  return Math.max(0, Math.floor(minUnits))
}
