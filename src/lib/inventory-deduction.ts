import type { inventoryItems } from "../db/schema"
import type Decimal from "decimal.js"
import { dec, decFromDb } from "./decimal-money"

export type ProductSaleType = "BOTTLE" | "GLASS"

type ItemDeductionFields = Pick<
  typeof inventoryItems.$inferSelect,
  "baseUnit" | "packageSize"
>

/**
 * Stock deducted per sale line: GLASS uses recipe qty in base units (ml/g/UNIT);
 * BOTTLE treats recipe qty as package count and multiplies by packageSize when applicable.
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
  if (item.baseUnit === "UNIT") {
    return recipeQty
  }
  const pkg = decFromDb(item.packageSize)
  if ((item.baseUnit === "ML" || item.baseUnit === "GRAMS") && pkg.gt(0)) {
    return recipeQty.times(pkg)
  }
  return recipeQty
}

/**
 * Model 1.5 "rinde N por envase". A recipe line declares how many servings come out of one
 * counting unit (envase) of the insumo: "10 tragos por botella". These two helpers translate
 * between that human value and the legacy base-unit `quantityUsed`, so both stay in sync while
 * the stock model migrates (3.2). They are pure and dependency-light on purpose.
 */

/** Legacy base units (ml/g/UNIT) consumed per one serving, given "N servings per package". */
export function baseUnitsPerServingFromYield(
  item: ItemDeductionFields,
  yieldPerPackage: Decimal
): Decimal {
  if (yieldPerPackage.lte(0)) return dec(0)
  if (item.baseUnit === "UNIT") return dec(1).div(yieldPerPackage)
  const pkg = decFromDb(item.packageSize)
  if (pkg.gt(0)) return pkg.div(yieldPerPackage)
  return dec(1).div(yieldPerPackage)
}

/** Inverse: derive the human "N per package" yield from legacy base-unit `quantityUsed`. */
export function yieldPerPackageFromQuantityUsed(
  item: ItemDeductionFields,
  quantityUsed: Decimal
): Decimal {
  if (quantityUsed.lte(0)) return dec(0)
  if (item.baseUnit === "UNIT") return dec(1).div(quantityUsed)
  const pkg = decFromDb(item.packageSize)
  if (pkg.gt(0)) return pkg.div(quantityUsed)
  return dec(1).div(quantityUsed)
}

export function bottleLoadStockDelta(
  item: ItemDeductionFields,
  quantityOfBottles: number,
  customPackageSize?: string | null
): { delta: Decimal; error?: string } {
  const bottles = dec(quantityOfBottles)
  if (item.baseUnit === "UNIT") {
    return { delta: bottles }
  }
  const per =
    customPackageSize != null && String(customPackageSize).trim() !== ""
      ? dec(String(customPackageSize).replace(",", "."))
      : decFromDb(item.packageSize)
  if (!per.gt(0)) {
    return {
      delta: dec(0),
      error:
        "Configurá el formato de envase del insumo en el catálogo (Inventario PRO).",
    }
  }
  return { delta: bottles.times(per) }
}

/** Convert user-entered stock into base units for persistence. */
export function stockAllocatedToBaseUnits(
  item: ItemDeductionFields,
  rawAmount: string | number,
  inputAs: "BASE_UNITS" | "PACKAGES"
): { value: Decimal; error?: string } {
  const amount = typeof rawAmount === "number" ? dec(rawAmount) : decFromDb(rawAmount)
  if (amount.lt(0)) {
    return { value: dec(0), error: "La cantidad no puede ser negativa." }
  }
  if (inputAs !== "PACKAGES") {
    return { value: amount }
  }
  if (item.baseUnit === "UNIT") {
    return { value: amount }
  }
  const pkg = decFromDb(item.packageSize)
  if (!pkg.gt(0)) {
    return {
      value: dec(0),
      error: "Definí el tamaño de envase para cargar por botellas/paquetes.",
    }
  }
  return { value: amount.times(pkg) }
}
