import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { events, gateLogs, sales, ticketTypes, tickets } from "../db/schema"
import { and, asc, eq, ne } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import {
  executeTicketPurchase,
  PurchaseError,
  purchaseErrorStatus,
} from "../lib/ticket-purchase"
import { qrCodeDataUrl } from "../lib/qr"
import { sendManualTicketQrEmail } from "../lib/send-checkout-receipt-email"
import { findActiveBlacklistEntry } from "../lib/admission-blacklist"
import { broadcastReceiptUpdate } from "../lib/public-qr-broadcast"

// Venta manual (spec §4.2): pide lo mínimo — tipo → cobrar → listo. Nombre, correo y DNI opcionales.
// El DNI (tarea 1.1/1.2) se guarda como snapshot en `tickets.buyer_dni`: es lo que la puerta
// chequea contra la blacklist.
const sellTicketSchema = z.object({
  eventId: z.string().min(1),
  ticketTypeId: z.string().min(1),
  buyerName: z.string().max(255).optional(),
  buyerEmail: z.union([z.string().email(), z.literal(""), z.null()]).optional(),
  buyerDni: z.union([z.string().min(6).max(20), z.literal(""), z.null()]).optional(),
  // Tarea 9.1 — Promotor que vende la entrada (atribución en tickets.promoter_id).
  promoterId: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.string().max(36).optional()
  ),
})

const validateTicketSchema = z.object({
  qrHash: z.string().min(1),
  eventId: z.string().min(1),
})

// Tarea 1.4 — Validación por DNI en puerta (visión §2.4: "Da el DNI y el guardia escanea").
// El DNI es la identidad dentro del evento: con el snapshot `tickets.buyer_dni` se resuelve la
// entrada sin QR ni join a customers.
const validateByDniSchema = z.object({
  eventId: z.string().min(1),
  dni: z
    .string()
    .min(6)
    .max(20)
    .transform((v) => v.trim()),
})

function requireTenantId(ctx: AuthenticatedContext): string | null {
  const id = ctx.staff.tenantId
  if (id == null || id === "") return null
  return id
}

/** Acepta la DB directa o el tx de una transacción (mismo patrón que `admission-blacklist.ts`). */
type GateDb = ReturnType<typeof drizzle>
type GateTx = Parameters<Parameters<GateDb["transaction"]>[0]>[0]

/**
 * Tarea 1.3 — Cuenta los ingresos (IN) registrados de un ticket en `gate_logs`. El scanner lo
 * muestra como "Pase #N" en el reingreso (tarea 3.2). Los pocos pases de un ticket se cuentan
 * en JS: nunca hay miles de filas por ticket.
 */
async function countInPasses(db: GateDb | GateTx, ticketId: string): Promise<number> {
  const rows = await db
    .select({ action: gateLogs.action })
    .from(gateLogs)
    .where(eq(gateLogs.ticketId, ticketId))
  return rows.filter((r) => r.action === "IN").length
}

function sanitizeValidatedTicket(row: typeof tickets.$inferSelect) {
  return {
    id: row.id,
    eventId: row.eventId,
    qrHash: row.qrHash,
    status: row.status,
    buyerName: row.buyerName,
    buyerEmail: row.buyerEmail,
    buyerDni: row.buyerDni ?? null,
    scannedAt: row.scannedAt,
    scannedBy: row.scannedBy,
  }
}

/** Fila mínima de ticket + su tipo que `applyGateValidation` necesita para operar. */
type GateRow = {
  id: string
  eventId: string
  saleId: string | null
  /** `tickets.status` es nullable en el schema (default PENDING) — null se trata como no usado. */
  status: string | null
  buyerDni: string | null
  qrHash: string
  /** Tarea 3.2 — `ticketTypeId` llega al scanner para el mapa de color por tipo de entrada. */
  ticketTypeId: string
  ticketTypeName: string
}

async function notifyTicketOwner(ticketId: string) {
  const db = drizzle(pool)
  const [row] = await db
    .select({ receiptToken: sales.receiptToken })
    .from(tickets)
    .innerJoin(sales, eq(tickets.saleId, sales.id))
    .where(eq(tickets.id, ticketId))
    .limit(1)
  if (row?.receiptToken) broadcastReceiptUpdate(row.receiptToken)
}

type GateOutcome =
  | {
      kind: "err"
      status: 400 | 403 | 404 | 409
      error: string
      blacklist?: {
        motivo: string
        foto: string | null
        fullName: string | null
        entryId: string
      }
    }
  | {
      kind: "ok"
      ticket: ReturnType<typeof sanitizeValidatedTicket>
      /** Tarea 3.2 — id del tipo de entrada (para el mapa de color de la puerta). */
      ticketTypeId: string
      ticketTypeName: string
      reentry?: boolean
      gatePassCount?: number
    }

/**
 * Tarea 1.2/1.3/1.4 — Núcleo de la validación de puerta, compartido por `POST /tickets/validate`
 * (escáner de QR) y `POST /tickets/validate-by-dni` (escáner de DNI). La diferencia entre ambos
 * es SOLO cómo se encontró el ticket; a partir de ahí la lógica es idéntica: blacklist (1.2) →
 * estado del ticket (reingreso 1.3) → primer pase con registro en `gate_logs`. Corre dentro de
 * una transacción.
 */
async function applyGateValidation(
  tx: GateTx,
  row: GateRow,
  staffId: string,
  tenantId: string
): Promise<GateOutcome> {
  // Tarea 1.2 — Blacklist / registro de admisión: el DNI es la identidad dentro del evento.
  // Si el comprador tiene una entrada ACTIVA en la lista, se rechaza el ingreso con motivo
  // y foto (la pantalla de puerta los muestra). Se chequea ANTES del estado del ticket: la
  // lista puede actualizarse durante la noche, así que también bloquea un reingreso.
  if (row.buyerDni) {
    const entry = await findActiveBlacklistEntry(tx, row.eventId, row.buyerDni)
    if (entry) {
      return {
        kind: "err" as const,
        status: 403 as const,
        error: "Persona en la lista de admisión",
        blacklist: {
          motivo: entry.reason,
          foto: entry.photoUrl ?? null,
          fullName: entry.fullName ?? null,
          entryId: entry.id,
        },
      }
    }
  }

  if (row.status === "CANCELLED") {
    return { kind: "err" as const, status: 404 as const, error: "Ticket inválido" }
  }

  // Tarea 1.3 — Reingreso: un ticket USED vuelve a pasar SOLO si el evento tiene
  // `allowReentry` (visión §2.4: "Si ya entró con esa entrada, avisa"). Se registra otro
  // pase IN en `gate_logs` y la respuesta avisa `reentry: true` — la pantalla de puerta
  // (3.2) muestra "Ya entró — reingreso" pero deja pasar. Sin allowReentry → 409 como hoy.
  if (row.status === "USED") {
    const [evRow] = await tx
      .select({ allowReentry: events.allowReentry })
      .from(events)
      .where(eq(events.id, row.eventId))
      .limit(1)

    if (!evRow?.allowReentry) {
      return { kind: "err" as const, status: 409 as const, error: "Ticket ya usado" }
    }

    await tx.insert(gateLogs).values({
      id: randomUUID(),
      ticketId: row.id,
      eventId: row.eventId,
      tenantId,
      action: "IN",
      scannedBy: staffId,
    })

    const [updated] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.id, row.id))
      .limit(1)

    if (!updated) {
      return { kind: "err" as const, status: 404 as const, error: "Ticket inválido" }
    }

    return {
      kind: "ok" as const,
      ticket: sanitizeValidatedTicket(updated),
      ticketTypeId: row.ticketTypeId,
      ticketTypeName: row.ticketTypeName,
      reentry: true,
      gatePassCount: await countInPasses(tx, row.id),
    }
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

  // Tarea 1.3 — Todo ingreso queda en `gate_logs` (primer pase y cada reingreso).
  await tx.insert(gateLogs).values({
    id: randomUUID(),
    ticketId: row.id,
    eventId: row.eventId,
    tenantId,
    action: "IN",
    scannedBy: staffId,
  })

  return {
    kind: "ok" as const,
    ticket: sanitizeValidatedTicket(updated),
    ticketTypeId: row.ticketTypeId,
    ticketTypeName: row.ticketTypeName,
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
          buyerName: body.buyerName?.trim() || null,
          buyerEmail: body.buyerEmail?.trim() || null,
          buyerDni: body.buyerDni?.trim() || null,
          ...(body.promoterId !== undefined ? { promoterId: body.promoterId } : {}),
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
          saleId: tickets.saleId,
          status: tickets.status,
          buyerName: tickets.buyerName,
          buyerEmail: tickets.buyerEmail,
          buyerDni: tickets.buyerDni,
          qrHash: tickets.qrHash,
          ticketTypeName: ticketTypes.name,
          // Tarea 3.2 — el scanner colorea la entrada por tipo (VIP = dorado, General = blanco).
          ticketTypeId: ticketTypes.id,
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

      // Tarea 1.2/1.3 — Blacklist, reingreso y primer pase: lógica compartida con
      // `POST /tickets/validate-by-dni` (1.4) — la única diferencia es cómo se encontró el ticket.
      return applyGateValidation(tx, row, staffId, tenantId)
    })

    if (outcome.kind === "err") {
      if (outcome.blacklist) {
        // 403 — la puerta muestra motivo + foto (tarea 1.2).
        return c.json(
          {
            error: outcome.error,
            motivo: outcome.blacklist.motivo,
            foto: outcome.blacklist.foto,
            fullName: outcome.blacklist.fullName,
            entryId: outcome.blacklist.entryId,
          },
          403
        )
      }
      return c.json({ error: outcome.error }, outcome.status)
    }

    void notifyTicketOwner(outcome.ticket.id)

    return c.json({
      message: outcome.reentry ? "Reingreso permitido" : "Entrada válida",
      ticket: outcome.ticket,
      // Tarea 3.2 — id del tipo para el mapa de color de la puerta (VIP dorado, General blanco).
      ticketTypeId: outcome.ticketTypeId,
      ticketTypeName: outcome.ticketTypeName,
      ...(outcome.reentry
        ? { reentry: true as const, gatePassCount: outcome.gatePassCount }
        : {}),
    })
  })
  .post("/validate-by-dni", authMiddleware, zValidator("json", validateByDniSchema), async (c) => {
    // Tarea 1.4 — Validación por DNI en puerta (visión §2.4: "Nadie necesita batería, datos ni
    // la app para entrar"). Con el DNI del comprador se resuelve su entrada vía el snapshot
    // `tickets.buyer_dni` y se aplica la MISMA lógica que el escaneo de QR: blacklist (1.2),
    // reingreso (1.3) y primer pase. Un DNI puede tener varias entradas (compró para otros):
    // cada escaneo consume una; se valida la más antigua PENDING y, si todas ya entraron,
    // el reingreso opera sobre el último pase.
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }

    const body = c.req.valid("json")
    const { eventId, dni } = body
    const staffId = ctx.staff.id
    const db = drizzle(pool)

    const outcome = await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: tickets.id,
          eventId: tickets.eventId,
          saleId: tickets.saleId,
          status: tickets.status,
          buyerDni: tickets.buyerDni,
          qrHash: tickets.qrHash,
          ticketTypeName: ticketTypes.name,
          // Tarea 3.2 — el scanner colorea la entrada por tipo (VIP = dorado, General = blanco).
          ticketTypeId: ticketTypes.id,
        })
        .from(tickets)
        .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
        .where(
          and(
            eq(tickets.eventId, eventId),
            eq(tickets.buyerDni, dni),
            eq(tickets.tenantId, tenantId),
            ne(tickets.status, "CANCELLED"),
            eq(ticketTypes.tenantId, tenantId)
          )
        )
        .orderBy(asc(tickets.createdAt))

      if (rows.length === 0) {
        return {
          kind: "err" as const,
          status: 404 as const,
          error: "Sin entradas para ese DNI",
        }
      }

      const row = rows.find((r) => r.status === "PENDING") ?? rows[rows.length - 1]
      return applyGateValidation(tx, row, staffId, tenantId)
    })

    if (outcome.kind === "err") {
      if (outcome.blacklist) {
        // 403 — la puerta muestra motivo + foto (tarea 1.2).
        return c.json(
          {
            error: outcome.error,
            motivo: outcome.blacklist.motivo,
            foto: outcome.blacklist.foto,
            fullName: outcome.blacklist.fullName,
            entryId: outcome.blacklist.entryId,
          },
          403
        )
      }
      return c.json({ error: outcome.error }, outcome.status)
    }

    void notifyTicketOwner(outcome.ticket.id)

    return c.json({
      message: outcome.reentry ? "Reingreso permitido" : "Entrada válida",
      ticket: outcome.ticket,
      // Discriminadores para la pantalla de puerta (tarea 3.2): id del tipo para el mapa de
      // color (VIP/General), nombre para el chip y estado para el aviso ("Ya entró" / reingreso).
      buyerName: outcome.ticket.buyerName,
      ticketTypeId: outcome.ticketTypeId,
      ticketTypeName: outcome.ticketTypeName,
      status: outcome.ticket.status,
      ...(outcome.reentry
        ? { reentry: true as const, gatePassCount: outcome.gatePassCount }
        : {}),
    })
  })
  .post("/out", authMiddleware, zValidator("json", validateTicketSchema), async (c) => {
    // Tarea 1.3 — Registro de salida desde el scanner (visión §2.4): la puerta marca que la
    // persona salió. Queda en `gate_logs` (OUT) y el ticket sigue USED — si el evento tiene
    // `allowReentry`, el próximo IN registra un reingreso. Requiere que el ticket YA haya
    // entrado (USED): no se puede salir sin haber ingresado.
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
        .select({ id: tickets.id, eventId: tickets.eventId, status: tickets.status })
        .from(tickets)
        .where(and(eq(tickets.qrHash, qrHash), eq(tickets.tenantId, tenantId)))
        .limit(1)

      if (!row) {
        return { kind: "err" as const, status: 404 as const, error: "Ticket inválido" }
      }

      if (row.eventId !== eventId) {
        return {
          kind: "err" as const,
          status: 400 as const,
          error: "Ticket para otro evento",
        }
      }

      if (row.status !== "USED") {
        return {
          kind: "err" as const,
          status: 409 as const,
          error: "El ticket todavía no ingresó",
        }
      }

      await tx.insert(gateLogs).values({
        id: randomUUID(),
        ticketId: row.id,
        eventId,
        tenantId,
        action: "OUT",
        scannedBy: staffId,
      })

      return { kind: "ok" as const }
    })

    if (outcome.kind === "err") {
      return c.json({ error: outcome.error }, outcome.status)
    }

    return c.json({ message: "Salida registrada" })
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
