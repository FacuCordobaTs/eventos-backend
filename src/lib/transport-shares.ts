import { and, asc, eq, sql } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import { randomUUID } from "node:crypto"
import { customers, events, eventTransports, saleTransports, sales, tenants, tickets, ticketTransfers, transportShares, transportTickets, transportTransfers } from "../db/schema"
import { ensureEventTransportTickets } from "./transport-tickets"
import { firstNameOf, generateShareToken, insertClaimantCustomer, isDuplicateEntryError, joinFullName, loadOwnerShares, summarizeShare, type ClaimInput, type ClaimResult, type CreateShareResult, type ShareErrorCode, type SharePreview } from "./ticket-shares"

type Db = MySql2Database<Record<string, never>>
type Scope = { customerId: string; eventId: string; tenantId: string }
const freePass = (owner: string) => and(eq(transportTickets.customerId, owner), eq(transportTickets.status, "PENDING"),
  sql`not exists (select 1 from ${transportTransfers} where ${transportTransfers.transportTicketId} = ${transportTickets.id} and ${transportTransfers.status} = 'PENDING')`,
  sql`not exists (select 1 from ${ticketTransfers} where ${ticketTransfers.transportTicketId} = ${transportTickets.id} and ${ticketTransfers.status} = 'PENDING')`)

export async function loadAllOwnerShares(db: Db, scope: Scope) {
  await ensureEventTransportTickets(db, scope)
  const original = await loadOwnerShares(db, scope)
  const [event] = await db.select({ id: events.id }).from(events).where(and(eq(events.id, scope.eventId), eq(events.tenantId, scope.tenantId))).limit(1)
  const passes = await db.select({ id: transportTickets.id, ticketId: transportTickets.ticketId, ticketTypeId: tickets.ticketTypeId, entryOwner: tickets.customerId, entryStatus: tickets.status, entryUnreserved: sql<number>`not exists (select 1 from ${ticketTransfers} where ${ticketTransfers.ticketId} = ${tickets.id} and ${ticketTransfers.status} = 'PENDING')`, transportId: saleTransports.transportId, name: saleTransports.name }).from(transportTickets).innerJoin(saleTransports, eq(saleTransports.id, transportTickets.bookingId)).innerJoin(sales, eq(sales.id, saleTransports.saleId)).leftJoin(tickets, eq(tickets.id, transportTickets.ticketId)).where(and(eq(transportTickets.tenantId, scope.tenantId), eq(transportTickets.eventId, scope.eventId), eq(sales.status, "COMPLETED"), freePass(scope.customerId)))
  const byRoute = new Map<string, { ticketTypeId: string; transportId: string; ticketTypeName: string; available: number; kind: "transport" }>()
  for (const pass of passes) {
    const route = byRoute.get(pass.transportId) ?? { ticketTypeId: `transport:${pass.transportId}`, transportId: pass.transportId, ticketTypeName: `Colectivo · ${pass.name}`, available: 0, kind: "transport" as const }
    route.available++
    byRoute.set(pass.transportId, route)
  }
  const links = await db.select({ share: transportShares, name: eventTransports.name }).from(transportShares).innerJoin(eventTransports, eq(eventTransports.id, transportShares.transportId)).where(and(eq(transportShares.ownerCustomerId, scope.customerId), eq(transportShares.eventId, scope.eventId), eq(transportShares.tenantId, scope.tenantId)))
  const busLinks = []
  for (const { share, name } of links) {
    const rows = await db.select({ transfer: transportTransfers, pass: transportTickets }).from(transportTransfers).innerJoin(transportTickets, eq(transportTickets.id, transportTransfers.transportTicketId)).where(eq(transportTransfers.shareId, share.id))
    const summary = summarizeShare({ cancelledAt: share.cancelledAt, rows: rows.map(({ transfer, pass }) => ({ status: transfer.status, deliverable: pass.status === "PENDING" && pass.customerId === scope.customerId && event != null, claimantName: transfer.toName, claimedAt: transfer.claimedAt })) })
    if (summary.status === "ACTIVE" || summary.claimed) busLinks.push({ id: share.id, token: share.token, ticketTypeName: `Colectivo · ${name}`, kind: "transport" as const, createdAt: share.createdAt?.toISOString() ?? null, ...summary })
  }
  const eligible = event != null ? [...original.eligible.map((entry) => ({ ...entry, transportAvailable: passes.filter((pass) => pass.ticketTypeId === entry.ticketTypeId && pass.entryOwner === scope.customerId && pass.entryStatus === "PENDING" && !!Number(pass.entryUnreserved)).length })), ...byRoute.values()] : []
  return { canShare: eligible.length > 0, eligible, links: [...original.links, ...busLinks], canIncludeTransport: passes.some((p) => !!p.ticketId && p.entryOwner === scope.customerId && p.entryStatus === "PENDING" && !!Number(p.entryUnreserved)) }
}

export async function createTransportShare(db: Db, input: Scope & { transportId: string; quantity: number }): Promise<CreateShareResult> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 50) return { ok: false, code: "INVALID_QUANTITY" }
  await ensureEventTransportTickets(db, input)
  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1).for("update")
    if (!owner) return { ok: false, code: "HOLDER_NOT_FOUND" }
    const [event] = await tx.select({ id: events.id }).from(events).where(and(eq(events.id, input.eventId), eq(events.tenantId, input.tenantId))).limit(1)
    if (!event) return { ok: false, code: "EVENT_CLOSED" }
    const [route] = await tx.select().from(eventTransports).where(and(eq(eventTransports.id, input.transportId), eq(eventTransports.eventId, input.eventId), eq(eventTransports.tenantId, input.tenantId))).limit(1)
    if (!route) return { ok: false, code: "TICKET_TYPE_NOT_FOUND" }
    const passes = await tx.select({ id: transportTickets.id }).from(transportTickets).innerJoin(saleTransports, eq(saleTransports.id, transportTickets.bookingId)).innerJoin(sales, eq(sales.id, saleTransports.saleId)).where(and(eq(transportTickets.tenantId, input.tenantId), eq(transportTickets.eventId, input.eventId), eq(saleTransports.transportId, input.transportId), eq(sales.status, "COMPLETED"), freePass(input.customerId))).orderBy(asc(transportTickets.createdAt), asc(transportTickets.id)).limit(input.quantity).for("update")
    if (passes.length < input.quantity) return { ok: false, code: "NOT_ENOUGH_TICKETS" }
    const id = randomUUID(), token = generateShareToken(), now = new Date()
    await tx.insert(transportShares).values({ id, token, tenantId: input.tenantId, eventId: input.eventId, transportId: input.transportId, ownerCustomerId: input.customerId, createdAt: now })
    await tx.insert(transportTransfers).values(passes.map((pass, position) => ({ id: randomUUID(), shareId: id, transportTicketId: pass.id, fromCustomerId: input.customerId, position, status: "PENDING" as const })))
    return { ok: true, share: { id, token, ticketTypeName: `Colectivo · ${route.name}`, kind: "transport", total: passes.length, pending: passes.length, claimed: 0, status: "ACTIVE", createdAt: now.toISOString(), claims: [] } }
  })
}

export async function cancelTransportShare(db: Db, input: Scope & { shareId: string }) {
  return db.transaction(async (tx) => {
    const [share] = await tx.select().from(transportShares).where(and(eq(transportShares.id, input.shareId), eq(transportShares.ownerCustomerId, input.customerId), eq(transportShares.eventId, input.eventId), eq(transportShares.tenantId, input.tenantId))).limit(1).for("update")
    if (!share) return { ok: false as const, code: "SHARE_NOT_FOUND" as const }
    await tx.update(transportShares).set({ cancelledAt: new Date() }).where(eq(transportShares.id, share.id))
    await tx.update(transportTransfers).set({ status: "VOID" }).where(and(eq(transportTransfers.shareId, share.id), eq(transportTransfers.status, "PENDING")))
    return { ok: true as const }
  })
}

export async function getTransportSharePreview(db: Db, token: string): Promise<(SharePreview & { kind: "transport"; transport: { name: string; address: string; latitude: string; longitude: string } }) | null> {
  const [row] = await db.select({ share: transportShares, event: events, ownerName: customers.name, productoraName: tenants.name, route: eventTransports }).from(transportShares).innerJoin(events, and(eq(events.id, transportShares.eventId), eq(events.tenantId, transportShares.tenantId))).innerJoin(customers, eq(customers.id, transportShares.ownerCustomerId)).innerJoin(tenants, eq(tenants.id, transportShares.tenantId)).innerJoin(eventTransports, eq(eventTransports.id, transportShares.transportId)).where(eq(transportShares.token, token)).limit(1)
  if (!row) return null
  const rows = await db.select({ transfer: transportTransfers, pass: transportTickets }).from(transportTransfers).innerJoin(transportTickets, eq(transportTickets.id, transportTransfers.transportTicketId)).where(eq(transportTransfers.shareId, row.share.id))
  const summary = summarizeShare({ cancelledAt: row.share.cancelledAt, rows: rows.map(({ transfer, pass }) => ({ status: transfer.status, deliverable: pass.customerId === row.share.ownerCustomerId && pass.status === "PENDING", claimantName: null, claimedAt: null })) })
  const { id, slug, name, date, venue, location, imageUrl } = row.event
  return { kind: "transport", transport: { name: row.route.name, address: row.route.address, latitude: row.route.latitude, longitude: row.route.longitude }, state: row.share.cancelledAt ? "CANCELLED" : summary.pending ? "AVAILABLE" : "SOLD_OUT", hostName: firstNameOf(row.ownerName), productoraName: row.productoraName, event: { id, slug, name, date, venue, location, imageUrl }, ticketType: { name: `Colectivo · ${row.route.name}`, validFrom: null, validUntil: null }, remaining: summary.pending, total: summary.total }
}

class AbortClaim extends Error { constructor(readonly code: ShareErrorCode) { super(code) } }
export async function claimTransportShare(db: Db, token: string, input: ClaimInput): Promise<ClaimResult> {
  try {
    return await db.transaction(async (tx): Promise<ClaimResult> => {
      const [share] = await tx.select().from(transportShares).where(eq(transportShares.token, token)).limit(1).for("update")
      if (!share) return { ok: false, code: "SHARE_NOT_FOUND" }
      if (share.cancelledAt) return { ok: false, code: "SHARE_CANCELLED" }
      const [event] = await tx.select().from(events).where(and(eq(events.id, share.eventId), eq(events.tenantId, share.tenantId))).limit(1)
      if (!event) return { ok: false, code: "EVENT_CLOSED" }
      const [existing] = await tx.select().from(customers).where(eq(customers.dni, input.dni)).limit(1)
      if (existing?.isActive === false) return { ok: false, code: "CUSTOMER_INACTIVE" }
      if (existing?.id === share.ownerCustomerId) return { ok: false, code: "OWN_SHARE" }
      const name = joinFullName(input.firstName, input.lastName)
      const claimant = existing ? { id: existing.id, createdNow: false } : await insertClaimantCustomer(tx, { name, dni: input.dni, phone: input.phone, email: input.email })
      if (claimant.id === share.ownerCustomerId) throw new AbortClaim("OWN_SHARE")
      const [already] = await tx.select({ id: transportTransfers.id }).from(transportTransfers).where(and(eq(transportTransfers.shareId, share.id), eq(transportTransfers.toCustomerId, claimant.id))).limit(1)
      if (already) throw new AbortClaim("ALREADY_CLAIMED")
      const [row] = await tx.select({ transfer: transportTransfers, pass: transportTickets, booking: saleTransports }).from(transportTransfers).innerJoin(transportTickets, eq(transportTickets.id, transportTransfers.transportTicketId)).innerJoin(saleTransports, eq(saleTransports.id, transportTickets.bookingId)).innerJoin(sales, eq(sales.id, saleTransports.saleId)).where(and(eq(transportTransfers.shareId, share.id), eq(transportTransfers.status, "PENDING"), eq(transportTickets.customerId, share.ownerCustomerId), eq(transportTickets.tenantId, share.tenantId), eq(transportTickets.eventId, share.eventId), eq(transportTickets.status, "PENDING"), eq(sales.status, "COMPLETED"))).orderBy(transportTransfers.position).limit(1).for("update")
      if (!row) throw new AbortClaim("SOLD_OUT")
      const qrHash = randomUUID()
      const [changed] = await tx.update(transportTickets).set({ customerId: claimant.id, buyerName: name, buyerDni: input.dni, buyerPhone: input.phone, qrHash }).where(and(eq(transportTickets.id, row.pass.id), eq(transportTickets.customerId, share.ownerCustomerId), eq(transportTickets.status, "PENDING")))
      if (changed.affectedRows !== 1) throw new AbortClaim("SOLD_OUT")
      await tx.update(transportTransfers).set({ status: "CLAIMED", toCustomerId: claimant.id, toName: name, claimedAt: new Date() }).where(eq(transportTransfers.id, row.transfer.id))
      const { id, slug, date, venue, location, imageUrl } = event
      const transport = { buyerName: name, boardedAt: null, id: row.pass.id, qrHash, name: row.booking.name, address: row.booking.address, latitude: row.booking.latitude, longitude: row.booking.longitude, price: row.booking.priceAtTime, transportId: row.booking.transportId, quantity: 1, status: "PENDING" as const }
      return { ok: true, claimed: { kind: "transport", transport, ticketId: row.pass.id, qrHash, ticketType: { name: `Colectivo · ${row.booking.name}`, validFrom: null, validUntil: null }, event: { id, slug, name: event.name, date, venue, location, imageUrl }, tenantId: share.tenantId, ownerCustomerId: share.ownerCustomerId, claimant: { customerId: claimant.id, name, email: input.email, createdNow: claimant.createdNow } } }
    })
  } catch (error) {
    if (error instanceof AbortClaim) return { ok: false, code: error.code }
    if (isDuplicateEntryError(error)) return { ok: false, code: "ALREADY_CLAIMED" }
    throw error
  }
}
