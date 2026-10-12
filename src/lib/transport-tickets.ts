import { and, asc, eq, ne, sql } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import { randomUUID } from "node:crypto"
import { customers, saleTransports, sales, tickets, transportTickets } from "../db/schema"

type Db<TSchema extends Record<string, unknown>> = MySql2Database<TSchema>

/** Called under the sale lock. A unit is issued once, only for a completed payment. */
export async function issueTransportTickets(tx: Pick<MySql2Database, "select" | "insert">, saleId: string) {
  const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).limit(1)
  if (!sale || sale.status !== "COMPLETED" || !sale.customerId) return
  const bookings = await tx.select().from(saleTransports).where(and(eq(saleTransports.saleId, saleId), eq(saleTransports.tenantId, sale.tenantId), eq(saleTransports.eventId, sale.eventId))).orderBy(saleTransports.id)
  if (!bookings.length) return
  const [customer] = await tx.select().from(customers).where(eq(customers.id, sale.customerId)).limit(1)
  if (!customer) return
  const entrances = await tx.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.saleId, saleId), eq(tickets.customerId, sale.customerId), eq(tickets.tenantId, sale.tenantId), eq(tickets.eventId, sale.eventId), ne(tickets.status, "CANCELLED"))).orderBy(asc(tickets.createdAt), asc(tickets.id))
  let entryIndex = 0
  for (const booking of bookings) {
    const existing = await tx.select({ unitIndex: transportTickets.unitIndex }).from(transportTickets).where(eq(transportTickets.bookingId, booking.id))
    const issued = new Set(existing.map((p) => p.unitIndex))
    for (let unitIndex = 0; unitIndex < booking.quantity; unitIndex++) {
      const ticketId = entrances[entryIndex++]?.id ?? null
      if (issued.has(unitIndex)) continue
      await tx.insert(transportTickets).values({
        id: randomUUID(), bookingId: booking.id, unitIndex, tenantId: sale.tenantId, eventId: sale.eventId,
        customerId: sale.customerId, ticketId,
        buyerName: sale.guestCheckoutSnapshot?.contact.name || customer.name,
        buyerDni: sale.guestCheckoutSnapshot?.contact.dni || customer.dni,
        buyerPhone: sale.guestCheckoutSnapshot?.contact.phone || customer.phone,
        qrHash: randomUUID(), status: "PENDING"
      })
    }
  }
}

/** Existing paid bookings get the same QR entitlements, without inventing another sale. */
export async function ensureEventTransportTickets<TSchema extends Record<string, unknown>>(db: Db<TSchema>, scope: { eventId: string; tenantId: string }) {
  const missing = await db.selectDistinct({ saleId: saleTransports.saleId }).from(saleTransports)
    .innerJoin(sales, eq(sales.id, saleTransports.saleId)).where(and(
      eq(saleTransports.eventId, scope.eventId), eq(saleTransports.tenantId, scope.tenantId),
      eq(sales.eventId, scope.eventId), eq(sales.tenantId, scope.tenantId), eq(sales.status, "COMPLETED"),
      sql`not exists (select 1 from ${transportTickets} where ${transportTickets.bookingId} = ${saleTransports.id})`
    ))
  for (const row of missing) await db.transaction(async (tx) => {
    await tx.select({ id: sales.id }).from(sales).where(and(eq(sales.id, row.saleId), eq(sales.tenantId, scope.tenantId), eq(sales.eventId, scope.eventId))).limit(1).for("update")
    await issueTransportTickets(tx, row.saleId)
  })
}
