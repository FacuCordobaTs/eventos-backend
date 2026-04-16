import { Hono } from "hono"
import { drizzle } from "drizzle-orm/mysql2"
import { and, asc, eq } from "drizzle-orm"
import { pool } from "../db"
import { customers, products, saleItems, sales, staff } from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { decFromDb, decToDb } from "../lib/decimal-money"

function requireTenantId(ctx: AuthenticatedContext): string | null {
  const id = ctx.staff.tenantId
  if (id == null || id === "") return null
  return id
}

export const salesRoute = new Hono()
  .use("*", authMiddleware)
  .get("/:id", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const saleId = c.req.param("id")
    const db = drizzle(pool)

    const [row] = await db
      .select({
        id: sales.id,
        totalAmount: sales.totalAmount,
        paymentMethod: sales.paymentMethod,
        createdAt: sales.createdAt,
        source: sales.source,
        status: sales.status,
        staffName: staff.name,
        customerName: customers.name,
      })
      .from(sales)
      .leftJoin(
        staff,
        and(eq(sales.staffId, staff.id), eq(staff.tenantId, tenantId))
      )
      .leftJoin(customers, eq(sales.customerId, customers.id))
      .where(and(eq(sales.id, saleId), eq(sales.tenantId, tenantId)))
      .limit(1)

    if (!row) {
      return c.json({ error: "Venta no encontrada" }, 404)
    }

    const itemRows = await db
      .select({
        productName: products.name,
        quantity: saleItems.quantity,
        priceAtTime: saleItems.priceAtTime,
      })
      .from(saleItems)
      .innerJoin(products, eq(saleItems.productId, products.id))
      .where(and(eq(saleItems.saleId, saleId), eq(products.tenantId, tenantId)))
      .orderBy(products.name)

    return c.json({
      sale: {
        id: row.id,
        totalAmount: String(row.totalAmount),
        paymentMethod: row.paymentMethod,
        createdAt: row.createdAt,
        source: row.source,
        status: row.status,
        staffName: row.staffName,
        customerName: row.customerName,
      },
      items: itemRows.map((it) => {
        const lineSubtotal = decFromDb(it.priceAtTime).times(it.quantity)
        return {
          productName: it.productName,
          quantity: it.quantity,
          priceAtTime: String(it.priceAtTime),
          lineSubtotal: decToDb(lineSubtotal),
        }
      }),
    })
  })
