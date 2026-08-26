import { inArray } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import type { Pool } from "mysql2/promise"
import { products } from "../db/schema"
import type { PickupItemsJson } from "../db/schema"

/**
 * Items de un pedido con nombre de producto, agrupados por producto para mostrar
 * ("2× Fernet") y para que la barra sepa qué entregar. Orden de aparición del itemsJson.
 * Lo usan el client (GET /public/pickups/:token), la tablet del barman
 * (GET /bars/:barId/pickups/:token) y la entrega (POST .../deliver).
 */
export async function pickupItemsWithNames(
  db: MySql2Database<Record<string, never>> & { $client: Pool },
  itemsJson: PickupItemsJson | null
): Promise<{ productId: string; productName: string; quantity: number }[]> {
  if (!itemsJson || itemsJson.length === 0) return []
  const productIds = [...new Set(itemsJson.map((i) => i.productId))]
  const prodRows = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(inArray(products.id, productIds))
  const nameById = new Map(prodRows.map((p) => [p.id, p.name]))
  const byProduct = new Map<string, number>()
  for (const i of itemsJson) {
    byProduct.set(i.productId, (byProduct.get(i.productId) ?? 0) + i.quantity)
  }
  return [...byProduct.entries()].map(([productId, quantity]) => ({
    productId,
    productName: nameById.get(productId) ?? "Producto",
    quantity,
  }))
}
