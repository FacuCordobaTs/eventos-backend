import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { ticketTypes, tickets } from "../db/schema"
import { and, eq } from "drizzle-orm"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import {
  executeTicketPurchase,
  PurchaseError,
  purchaseErrorStatus,
} from "../lib/ticket-purchase"
import { qrCodeDataUrl } from "../lib/qr"
import { sendManualTicketQrEmail } from "../lib/send-checkout-receipt-email"

const sellTicketSchema = z.object({
  eventId: z.string().min(1),
  ticketTypeId: z.string().min(1),
  buyerName: z.string().min(1).max(255),
  buyerEmail: z.string().email(),
})

const validateTicketSchema = z.object({
  qrHash: z.string().min(1),
  eventId: z.string().min(1),
})

function requireTenantId(ctx: AuthenticatedContext): string | null {
  const id = ctx.staff.tenantId
  if (id == null || id === "") return null
  return id
}

function sanitizeValidatedTicket(row: typeof tickets.$inferSelect) {
  return {
    id: row.id,
    eventId: row.eventId,
    qrHash: row.qrHash,
    status: row.status,
    buyerName: row.buyerName,
    buyerEmail: row.buyerEmail,
    scannedAt: row.scannedAt,
    scannedBy: row.scannedBy,
  }
}

export const ticketsRoute = new Hono()
  .post("/sell", authMiddleware, zValidator("json", sellTicketSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const body = c.req.valid("json")
    const db = drizzle(pool)

    try {
      const result = await db.transaction(async (tx) =>
        executeTicketPurchase(tx, {
          eventId: body.eventId,
          ticketTypeId: body.ticketTypeId,
          buyerName: body.buyerName,
          buyerEmail: body.buyerEmail,
          enforceTenantId: tenantId,
        })
      )

      return c.json(
        {
          message: "Venta simulada completada",
          ticket: result.ticket,
          ticketTypeName: result.ticketTypeName,
          payment: { status: "completed" as const, method: "mock" as const },
        },
        201
      )
    } catch (e) {
      if (e instanceof PurchaseError) {
        const { status, body: errBody } = purchaseErrorStatus(e.code)
        return c.json(errBody, status)
      }
      throw e
    }
  })
  .post("/validate", authMiddleware, zValidator("json", validateTicketSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }

    const body = c.req.valid("json")
    const { qrHash, eventId } = body
    const staffId = ctx.staff.id
    const db = drizzle(pool)

    const outcome = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: tickets.id,
          eventId: tickets.eventId,
          status: tickets.status,
          buyerName: tickets.buyerName,
          buyerEmail: tickets.buyerEmail,
          qrHash: tickets.qrHash,
          ticketTypeName: ticketTypes.name,
          typeEventId: ticketTypes.eventId,
        })
        .from(tickets)
        .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
        .where(
          and(
            eq(tickets.qrHash, qrHash),
            eq(tickets.tenantId, tenantId),
            eq(ticketTypes.tenantId, tenantId)
          )
        )
        .limit(1)

      if (!row) {
        return { kind: "err" as const, status: 404 as const, error: "Ticket inválido" }
      }

      if (row.eventId !== eventId || row.typeEventId !== eventId) {
        return {
          kind: "err" as const,
          status: 400 as const,
          error: "Ticket para otro evento",
        }
      }

      if (row.status === "USED") {
        return { kind: "err" as const, status: 409 as const, error: "Ticket ya usado" }
      }

      if (row.status === "CANCELLED") {
        return { kind: "err" as const, status: 404 as const, error: "Ticket inválido" }
      }

      await tx
        .update(tickets)
        .set({
          status: "USED",
          scannedAt: new Date(),
          scannedBy: staffId,
        })
        .where(and(eq(tickets.id, row.id), eq(tickets.status, "PENDING")))

      const [updated] = await tx
        .select()
        .from(tickets)
        .where(eq(tickets.id, row.id))
        .limit(1)

      if (!updated || updated.status !== "USED") {
        return { kind: "err" as const, status: 409 as const, error: "Ticket ya usado" }
      }

      return {
        kind: "ok" as const,
        ticket: sanitizeValidatedTicket(updated),
        ticketTypeName: row.ticketTypeName,
      }
    })

    if (outcome.kind === "err") {
      return c.json({ error: outcome.error }, outcome.status)
    }

    return c.json({
      message: "Entrada válida",
      ticket: outcome.ticket,
      ticketTypeName: outcome.ticketTypeName,
    })
  })
  .get("/:id/qr", authMiddleware, async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }

    const ticketId = c.req.param("id")
    if (ticketId == null || ticketId === "") {
      return c.json({ error: "Falta el id de entrada" }, 400)
    }
    const db = drizzle(pool)

    const [row] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
      .limit(1)

    if (!row) {
      return c.json({ error: "Entrada no encontrada" }, 404)
    }

    const qrDataUrl = await qrCodeDataUrl(row.qrHash)

    return c.json({
      qrDataUrl,
      qrHash: row.qrHash,
    })
  })
  .post("/:id/cancel", authMiddleware, async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const ticketId = c.req.param("id")
    if (ticketId == null || ticketId === "") {
      return c.json({ error: "Falta el id de entrada" }, 400)
    }
    const db = drizzle(pool)

    const [row] = await db
      .select({ id: tickets.id, status: tickets.status })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
      .limit(1)

    if (!row) {
      return c.json({ error: "Entrada no encontrada" }, 404)
    }
    if (row.status !== "PENDING") {
      return c.json(
        {
          error: "Solo se pueden anular entradas pendientes (no usadas ni ya anuladas).",
        },
        409
      )
    }

    await db
      .update(tickets)
      .set({ status: "CANCELLED" })
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))

    return c.json({ message: "Entrada anulada" })
  })
  .post("/:id/send-email", authMiddleware, async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    const ticketId = c.req.param("id")
    if (ticketId == null || ticketId === "") {
      return c.json({ error: "Falta el id de entrada" }, 400)
    }
    const db = drizzle(pool)

    const [row] = await db
      .select({
        id: tickets.id,
        status: tickets.status,
        buyerEmail: tickets.buyerEmail,
      })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
      .limit(1)

    if (!row) {
      return c.json({ error: "Entrada no encontrada" }, 404)
    }
    if (row.status === "CANCELLED") {
      return c.json(
        { error: "No se puede enviar el email de una entrada anulada." },
        400
      )
    }
    if (row.buyerEmail == null || row.buyerEmail.trim() === "") {
      return c.json(
        { error: "No email associated with this ticket" },
        400
      )
    }

    try {
      await sendManualTicketQrEmail({ db, ticketId, tenantId })
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error al enviar el email"
      if (msg === "Entrada no encontrada") {
        return c.json({ error: "Entrada no encontrada" }, 404)
      }
      if (msg.includes("RESEND_API_KEY")) {
        return c.json({ error: msg }, 503)
      }
      return c.json({ error: msg }, 500)
    }

    await db
      .update(tickets)
      .set({ emailSentAt: new Date() })
      .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))

    return c.json({ message: "Email enviado" })
  })
