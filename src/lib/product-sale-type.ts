import { and, eq } from "drizzle-orm"
import type { MySql2Transaction } from "drizzle-orm/mysql2"
import type { TablesRelationalConfig } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { barProducts, inventoryItems, productRecipes } from "../db/schema"
import type { ProductSaleType } from "./inventory-deduction"

type Tx = MySql2Transaction<Record<string, never>, TablesRelationalConfig>

const normalizeName = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLocaleLowerCase("es-AR")

/**
 * Un producto que se vende por unidad ES un insumo: su receta es una sola línea con 1 unidad
 * de un insumo propio (mismo nombre). Así su stock vive en `barInventory` como cualquier
 * insumo y otros productos (tragos, botellas) pueden usarlo en sus recetas.
 *
 * Reutiliza el insumo que ya tenía el producto; si no, uno activo con el mismo nombre; si no,
 * lo crea. Si el producto cambió de nombre, renombra su insumo cuando el nombre está libre.
 * Devuelve el id del insumo.
 */
export async function linkUnitProductItem(
  tx: Tx,
  tenantId: string,
  product: { id: string; name: string }
): Promise<string> {
  const items = await tx
    .select({ id: inventoryItems.id, name: inventoryItems.name })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.tenantId, tenantId), eq(inventoryItems.isActive, true)))
  const current = await tx
    .select({ inventoryItemId: productRecipes.inventoryItemId, quantityUsed: productRecipes.quantityUsed })
    .from(productRecipes)
    .where(eq(productRecipes.productId, product.id))
  const wanted = normalizeName(product.name)
  const own =
    current.length === 1 && Number(current[0].quantityUsed) === 1
      ? items.find((item) => item.id === current[0].inventoryItemId)
      : undefined
  let itemId: string
  if (own) {
    itemId = own.id
    const nameTaken = items.some((item) => item.id !== own.id && normalizeName(item.name) === wanted)
    if (normalizeName(own.name) !== wanted && !nameTaken) {
      await tx
        .update(inventoryItems)
        .set({ name: product.name.trim() })
        .where(and(eq(inventoryItems.id, own.id), eq(inventoryItems.tenantId, tenantId)))
    }
  } else {
    const sameName = items.find((item) => normalizeName(item.name) === wanted)
    if (sameName) itemId = sameName.id
    else {
      itemId = uuidv4()
      await tx.insert(inventoryItems).values({
        id: itemId,
        tenantId,
        name: product.name.trim(),
        baseUnit: "UNIT",
        packageSize: "1.00",
        countingUnit: "unidades",
        isActive: true,
      })
    }
  }
  if (!own) {
    await tx.delete(productRecipes).where(eq(productRecipes.productId, product.id))
    await tx.insert(productRecipes).values({
      id: uuidv4(),
      productId: product.id,
      inventoryItemId: itemId,
      quantityUsed: "1.000000",
      yieldPerPackage: null,
    })
  }
  return itemId
}

/**
 * Aplica el modo de venta: ningún modo usa ya `barProducts.directStock` (las existencias por
 * unidad viven en el insumo propio del producto), y UNIT queda enlazado a su insumo.
 * Llamar después de guardar la receta de los modos con insumos.
 */
export async function applySaleType(
  tx: Tx,
  tenantId: string,
  product: { id: string; name: string },
  saleType: ProductSaleType
): Promise<void> {
  await tx
    .update(barProducts)
    .set({ directStock: null })
    .where(and(eq(barProducts.productId, product.id), eq(barProducts.tenantId, tenantId)))
  if (saleType === "UNIT") await linkUnitProductItem(tx, tenantId, product)
}
