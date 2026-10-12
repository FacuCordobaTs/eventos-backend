import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { and, desc, eq, ne, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { events, eventStaff, eventTransports, saleTransports, sales, transportTickets } from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { broadcastReceiptUpdate } from "../lib/public-qr-broadcast"
import { ensureEventTransportTickets } from "../lib/transport-tickets"

const scanSchema = z.object({ eventId: z.string().uuid(), transportId: z.string().uuid(), qrHash: z.string().min(1).max(128).optional(), dni: z.string().regex(/^\d{6,9}$/).optional() })
export const transportTicketsRoute = new Hono().use("*", authMiddleware)
  .use("*", async (c, next) => {
    const { staff } = c as unknown as AuthenticatedContext
    if (!staff.tenantId || !["ADMIN", "MANAGER", "TRANSPORTER"].includes(staff.role)) return c.json({ error: "No tenés permiso para controlar transportes" }, 403)
    await next()
  })
  .get("/events", async (c) => {
    const { staff } = c as unknown as AuthenticatedContext
    const db = drizzle(pool)
    const rows = await db.select().from(events).where(and(eq(events.tenantId, staff.tenantId!), ne(events.status, "closed"), staff.role === "TRANSPORTER" ? sql`exists (select 1 from ${eventStaff} where ${eventStaff.eventId} = ${events.id} and ${eventStaff.tenantId} = ${staff.tenantId!} and ${eventStaff.staffId} = ${staff.id})` : undefined))
    const result = []
    for (const event of rows) {
      const transports = await db.select({ id: eventTransports.id, name: eventTransports.name, address: eventTransports.address }).from(eventTransports).where(and(eq(eventTransports.eventId, event.id), eq(eventTransports.tenantId, staff.tenantId!)))
      if (transports.length) result.push({ ...event, transports })
    }
    return c.json({ events: result })
  })
  .use("*", async (c, next) => {
    const { staff } = c as unknown as AuthenticatedContext
    const input = c.req.method === "GET" ? c.req.query() : await c.req.json().catch(() => ({}))
    const eventId = typeof input.eventId === "string" ? input.eventId : ""
    const db = drizzle(pool)
    const [event] = await db.select({ id: events.id }).from(events).where(and(eq(events.id, eventId), eq(events.tenantId, staff.tenantId!), ne(events.status, "closed"), staff.role === "TRANSPORTER" ? sql`exists (select 1 from ${eventStaff} where ${eventStaff.eventId} = ${events.id} and ${eventStaff.tenantId} = ${staff.tenantId!} and ${eventStaff.staffId} = ${staff.id})` : undefined)).limit(1)
    if (!event) return c.json({ error: "No tenés acceso a este evento" }, 403)
    await ensureEventTransportTickets(db, { eventId, tenantId: staff.tenantId! })
    await next()
  })
  .get("/boarded", async (c) => {
    const { staff } = c as unknown as AuthenticatedContext
    const db = drizzle(pool)
    const rows = await db.select({ id: transportTickets.id, buyerName: transportTickets.buyerName, scannedAt: transportTickets.boardedAt, ticketTypeName: saleTransports.name }).from(transportTickets).innerJoin(saleTransports, eq(saleTransports.id, transportTickets.bookingId)).innerJoin(sales, eq(sales.id, saleTransports.saleId)).where(and(eq(transportTickets.tenantId, staff.tenantId!), eq(transportTickets.eventId, c.req.query("eventId")!), eq(saleTransports.transportId, c.req.query("transportId") ?? ""), eq(sales.status, "COMPLETED"), eq(transportTickets.status, "USED"))).orderBy(desc(transportTickets.boardedAt))
    return c.json({ tickets: rows })
  })
  .post("/validate", zValidator("json", scanSchema.refine((v) => !!v.qrHash)), board)
  .post("/validate-by-dni", zValidator("json", scanSchema.refine((v) => !!v.dni)), board)

async function board(c: import("hono").Context) {
  const { staff } = c as unknown as AuthenticatedContext
  const input = scanSchema.parse(await c.req.json())
  const byDni = c.req.path.endsWith("validate-by-dni")
  const db = drizzle(pool)
  const result = await db.transaction(async (tx) => {
    // Lock assignment too: revoking event access cannot race a successful boarding.
    if (staff.role === "TRANSPORTER") {
      const [assignment] = await tx.select({ id: eventStaff.id }).from(eventStaff).where(and(eq(eventStaff.eventId, input.eventId), eq(eventStaff.tenantId, staff.tenantId!), eq(eventStaff.staffId, staff.id))).limit(1).for("update")
      if (!assignment) return { error: "No tenés acceso a este evento", status: 403 as const }
    }
    const [event] = await tx.select({ status: events.status }).from(events).where(and(eq(events.id, input.eventId), eq(events.tenantId, staff.tenantId!))).limit(1).for("update")
    if (!event || event.status === "closed") return { error: "El evento está cerrado", status: 409 as const }
    const [row] = await tx.select({ pass: transportTickets, booking: saleTransports, saleStatus: sales.status, receiptToken: sales.receiptToken }).from(transportTickets).innerJoin(saleTransports, and(eq(saleTransports.id, transportTickets.bookingId), eq(saleTransports.tenantId, transportTickets.tenantId), eq(saleTransports.eventId, transportTickets.eventId))).innerJoin(sales, eq(sales.id, saleTransports.saleId)).where(and(eq(transportTickets.tenantId, staff.tenantId!), eq(transportTickets.eventId, input.eventId), eq(saleTransports.transportId, input.transportId), byDni ? and(eq(transportTickets.buyerDni, input.dni!), eq(transportTickets.status, "PENDING")) : eq(transportTickets.qrHash, input.qrHash!))).orderBy(transportTickets.createdAt, transportTickets.id).limit(1).for("update")
    if (!row) return { error: "No hay un pasaje válido para este transporte", status: 404 as const }
    if (row.saleStatus !== "COMPLETED") return { error: "El pasaje no está pagado", status: 409 as const }
    if (row.pass.status !== "PENDING") return { error: row.pass.status === "USED" ? "Pasaje ya usado" : "Pasaje cancelado", status: 409 as const }
    const [changed] = await tx.update(transportTickets).set({ status: "USED", boardedAt: new Date(), boardedBy: staff.id }).where(and(eq(transportTickets.id, row.pass.id), eq(transportTickets.status, "PENDING")))
    if (changed.affectedRows !== 1) return { error: "Pasaje ya usado", status: 409 as const }
    return { row }
  })
  if ("error" in result) return c.json({ error: result.error }, result.status)
  try {
    if (result.row.receiptToken) broadcastReceiptUpdate(result.row.receiptToken)
    const owned = await db.select({ receiptToken: sales.receiptToken }).from(sales).where(and(eq(sales.customerId, result.row.pass.customerId), eq(sales.tenantId, staff.tenantId!), eq(sales.eventId, input.eventId), eq(sales.status, "COMPLETED")))
    for (const sale of owned) broadcastReceiptUpdate(sale.receiptToken)
  } catch { /* Boarding is committed even if the optional customer notification fails. */ }
  const { pass, booking } = result.row
  return c.json({ message: "Subida registrada", ticket: { id: pass.id, buyerName: pass.buyerName, buyerEmail: null, status: "USED" }, buyerName: pass.buyerName, status: "USED", ticketTypeId: booking.transportId, ticketTypeName: booking.name, validFrom: null, validUntil: null })
}
