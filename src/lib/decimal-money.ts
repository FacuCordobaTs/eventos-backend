import Decimal from "decimal.js"

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP })

export function dec(value: string | number | Decimal): Decimal {
  return new Decimal(value)
}

export function decToDb(value: Decimal): string {
  return value.toFixed(2)
}

/** Cantidades de stock/receta de insumos: 6 decimales (un trago consume 1/N unidades). */
export function stockToDb(value: Decimal): string {
  return value.toFixed(6)
}

export function decFromDb(value: string | null | undefined): Decimal {
  if (value == null || value === "") return new Decimal(0)
  return new Decimal(value)
}
