import type { inventoryItems } from "../db/schema"
import type Decimal from "decimal.js"
import { dec, decFromDb } from "./decimal-money"

export type ProductSaleType = "BOTTLE" | "GLASS"

type ItemDeductionFields = Pick<
  typeof inventoryItems.$inferSelect,
  "unit" | "defaultContentValue" | "defaultContentUnit"
>

/**
 * Stock deducted per sale line: GLASS uses recipe qty in inventory unit;
 * BOTTLE treats recipe qty as bottle count and expands via defaultContentValue when units align.
 */
export function recipeStockDeduction(
  quantityUsedRaw: string,
  lineQuantity: number,
  saleType: ProductSaleType,
  item: ItemDeductionFields
): Decimal {
  const recipeQty = decFromDb(quantityUsedRaw).times(lineQuantity)
  if (saleType !== "BOTTLE") {
    return recipeQty
  }
  if (item.unit === "UNIDAD") {
    return recipeQty
  }
  const defVal = decFromDb(item.defaultContentValue)
  const defUnit = item.defaultContentUnit
  if (
    (item.unit === "ML" && defUnit === "ML") ||
    (item.unit === "GRAMOS" && defUnit === "GRAMOS")
  ) {
    if (defVal.gt(0)) {
      return recipeQty.times(defVal)
    }
  }
  return recipeQty
}

export function bottleLoadStockDelta(
  item: ItemDeductionFields,
  quantityOfBottles: number,
  customContentValue?: string | null
): { delta: Decimal; error?: string } {
  const bottles = dec(quantityOfBottles)
  if (item.unit === "UNIDAD") {
    return { delta: bottles }
  }
  const per =
    customContentValue != null && String(customContentValue).trim() !== ""
      ? dec(String(customContentValue).replace(",", "."))
      : decFromDb(item.defaultContentValue)
  if (!per.gt(0)) {
    return {
      delta: dec(0),
      error:
        "Indicá ml (o g) por botella o configurá el tamaño estándar del insumo.",
    }
  }
  return { delta: bottles.times(per) }
}
