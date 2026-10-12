import { z } from "zod"
import { and, eq, sql } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import { saleTransports, sales } from "../db/schema"
import { dec } from "./decimal-money"

export async function transportRevenue<TSchema extends Record<string, unknown>>(
  db: MySql2Database<TSchema>,
  scope: { tenantId: string; eventId: string }
) {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${saleTransports.quantity} * ${saleTransports.priceAtTime}), 0)`
    })
    .from(saleTransports)
    .innerJoin(sales, eq(sales.id, saleTransports.saleId))
    .where(
      and(
        eq(saleTransports.tenantId, scope.tenantId),
        eq(saleTransports.eventId, scope.eventId),
        eq(sales.tenantId, scope.tenantId),
        eq(sales.eventId, scope.eventId),
        eq(sales.status, "COMPLETED")
      )
    )
  return dec(row?.total ?? "0").toFixed(2)
}

export const transportSchema = z.object({
  name: z.string().trim().min(1).max(255),
  address: z.string().trim().min(1).max(500),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  price: z
    .string()
    .regex(/^\d{1,8}(\.\d{1,2})?$/)
    .refine((v) => dec(v).gt(0), "Ingresá un precio mayor a cero"),
  isActive: z.boolean().default(true)
})

export async function purchasedTransports(
  db: MySql2Database,
  scope: {
    tenantId: string
    eventId: string
    customerId?: string
    saleId?: string
  }
) {
  return db
    .select({
      id: saleTransports.id,
      transportId: saleTransports.transportId,
      name: saleTransports.name,
      address: saleTransports.address,
      latitude: saleTransports.latitude,
      longitude: saleTransports.longitude,
      quantity: saleTransports.quantity,
      price: saleTransports.priceAtTime
    })
    .from(saleTransports)
    .innerJoin(sales, eq(sales.id, saleTransports.saleId))
    .where(
      and(
        eq(saleTransports.tenantId, scope.tenantId),
        eq(saleTransports.eventId, scope.eventId),
        eq(sales.tenantId, scope.tenantId),
        eq(sales.eventId, scope.eventId),
        eq(sales.status, "COMPLETED"),
        scope.customerId
          ? eq(sales.customerId, scope.customerId)
          : eq(sales.id, scope.saleId ?? "")
      )
    )
}
