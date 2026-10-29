import { and, eq, isNull } from "drizzle-orm"
import type { MySql2Transaction } from "drizzle-orm/mysql2"
import type { TablesRelationalConfig } from "drizzle-orm"
import { barProducts } from "../db/schema"
import type { ProductSaleType } from "./inventory-deduction"

type Tx = MySql2Transaction<Record<string, never>, TablesRelationalConfig>

/**
 * Mantiene `barProducts.directStock` coherente con el modo de venta del producto, que es lo
 * que leen todos los caminos de descuento: UNIT lleva conteo en cada barra (0 si no había);
 * los demás modos no tienen conteo por unidad (NULL).
 */
export async function syncDirectStockForSaleType(
  tx: Tx,
  tenantId: string,
  productId: string,
  saleType: ProductSaleType
): Promise<void> {
  const scope = and(eq(barProducts.productId, productId), eq(barProducts.tenantId, tenantId))
  if (saleType === "UNIT") {
    await tx.update(barProducts).set({ directStock: "0.00" }).where(and(scope, isNull(barProducts.directStock)))
    return
  }
  await tx.update(barProducts).set({ directStock: null }).where(scope)
}
