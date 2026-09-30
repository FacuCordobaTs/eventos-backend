import { and, asc, desc, eq, inArray } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import { randomBytes, randomUUID } from "node:crypto"
import { v4 as uuidv4 } from "uuid"
import {
  customers,
  events,
  sales,
  tenants,
  ticketShares,
  ticketTransfers,
  ticketTypes,
  tickets,
} from "../db/schema"
import { normalizeWhatsAppPhone } from "./whatsapp-service"

/**
 * Compartir entradas (ver `docs/EVENTS_TICKETS_AND_ACCESS.md`).
 *
 * Quien compró varias entradas arma un link para mandar al grupo y cada amigo reclama una. Reclamar
 * es un traspaso real: la MISMA fila de `tickets` pasa al nombre del amigo (`customerId`, nombre,
 * email y DNI) y cambia de `qrHash`, así la copia que tenía el comprador deja de servir. La venta
 * (`saleId`) y el promotor no se tocan: los reportes y las comisiones siguen siendo los de la compra.
 *
 * Invariantes que este módulo sostiene:
 * - Un cupo (`ticket_transfers`) sólo se entrega con un UPDATE condicional sobre `tickets`
 *   (`customerId` = dueño y `status` = PENDING): aunque dos links reserven la misma entrada, o la
 *   puerta la escanee justo en ese instante, nunca se entrega dos veces ni una ya usada.
 * - Reclamar serializa por link (`SELECT ... FOR UPDATE` sobre `ticket_shares`).
 * - Reclamar nunca pisa datos de un cliente existente: sólo completa un celular que no tenía. Quien
 *   escribe un DNI ajeno en el formulario no puede cambiar el email ni el nombre de esa ficha.
 */

type Db = MySql2Database<Record<string, never>>
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** Tope de cupos por link: alcanza para cualquier grupo y acota el tamaño de las respuestas. */
export const MAX_SHARE_QUANTITY = 50

export type ShareErrorCode =
  | "SHARE_NOT_FOUND"
  | "SHARE_CANCELLED"
  | "EVENT_CLOSED"
  | "SOLD_OUT"
  | "ALREADY_CLAIMED"
  | "OWN_SHARE"
  | "CUSTOMER_INACTIVE"
  | "NOT_ENOUGH_TICKETS"
  | "TICKET_TYPE_NOT_FOUND"
  | "INVALID_QUANTITY"
  | "HOLDER_NOT_FOUND"

const SHARE_ERRORS: Record<ShareErrorCode, { status: 400 | 403 | 404 | 409 | 410; error: string }> = {
  SHARE_NOT_FOUND: { status: 404, error: "Este link no existe o está incompleto." },
  SHARE_CANCELLED: {
    status: 410,
    error: "Quien te lo mandó canceló este link. Pedile uno nuevo.",
  },
  EVENT_CLOSED: { status: 410, error: "Este evento ya finalizó." },
  SOLD_OUT: { status: 409, error: "Ya se reclamaron todas las entradas de este link." },
  ALREADY_CLAIMED: {
    status: 409,
    error: "Ya reclamaste una entrada con este link. Para verla, ingresá con tu DNI o tu celular.",
  },
  OWN_SHARE: {
    status: 409,
    error: "Este link es tuyo: compartilo con tus amigos para que reclamen sus entradas.",
  },
  CUSTOMER_INACTIVE: {
    status: 403,
    error: "Tu cuenta no está activa. Comunicate con la productora.",
  },
  NOT_ENOUGH_TICKETS: {
    status: 409,
    error: "No tenés tantas entradas disponibles para compartir.",
  },
  TICKET_TYPE_NOT_FOUND: { status: 404, error: "No encontramos ese tipo de entrada." },
  INVALID_QUANTITY: { status: 400, error: "Elegí cuántas entradas querés compartir." },
  HOLDER_NOT_FOUND: { status: 404, error: "El enlace no es válido" },
}

export function shareErrorResponse(code: ShareErrorCode) {
  const { status, error } = SHARE_ERRORS[code]
  return { status, body: { error, code } }
}

// -----------------------------------------------------------------------------
// Helpers puros
// -----------------------------------------------------------------------------

/** 192 bits de azar: el token es la única credencial del link, así que no se puede adivinar. */
export function generateShareToken(): string {
  return randomBytes(24).toString("base64url")
}

/** Documento en dígitos (sin puntos ni espacios). `null` si no tiene el largo de un DNI. */
export function normalizeDni(raw: string): string | null {
  const digits = raw.replace(/\D/g, "")
  return /^\d{6,9}$/.test(digits) ? digits : null
}

/**
 * Celular en el formato de WhatsApp (`5491155555555`), el mismo contra el que el acceso por evento
 * busca clientes. `null` si no tiene largo de teléfono.
 */
export function normalizeClaimPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "")
  if (digits.length < 8 || digits.length > 15) return null
  return normalizeWhatsAppPhone(raw)
}

export function joinFullName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.replace(/\s+/g, " ").trim().slice(0, 255)
}

/** Con quién se presenta el link a los amigos: sólo el nombre de pila, nunca el apellido. */
export function firstNameOf(fullName: string | null | undefined): string {
  const first = (fullName ?? "").trim().split(/\s+/)[0] ?? ""
  if (first === "" || /^invitado$/i.test(first)) return "Un amigo"
  return first
}

/** El cierre de la ventana es exclusivo, igual que en la puerta: a las 22:00 ya no se admite. */
export function admissionWindowEnded(
  window: { validUntil?: Date | string | null },
  now = new Date()
): boolean {
  return window.validUntil != null && now.getTime() >= new Date(window.validUntil).getTime()
}

/**
 * ¿Se le puede entregar esta entrada a un amigo? Sólo si sigue siendo del dueño que armó el link,
 * no se usó ni se anuló, y su ventana de ingreso no terminó (sería regalar una entrada muerta).
 */
export function isTicketDeliverable(
  ticket: { status: string | null; customerId: string | null },
  ownerCustomerId: string,
  window: { validUntil?: Date | string | null },
  now = new Date()
): boolean {
  return (
    ticket.status === "PENDING" &&
    ticket.customerId === ownerCustomerId &&
    !admissionWindowEnded(window, now)
  )
}

export type ShareLinkStatus = "ACTIVE" | "COMPLETED" | "CANCELLED"

export type ShareLinkDto = {
  id: string
  token: string
  ticketTypeName: string
  /** Cupos vivos del link: los ya reclamados más los que todavía se pueden reclamar. */
  total: number
  claimed: number
  pending: number
  status: ShareLinkStatus
  createdAt: string | null
  claims: { name: string; claimedAt: string | null }[]
}

export type TransferSummaryRow = {
  status: "PENDING" | "CLAIMED" | "VOID"
  /** Sólo importa en PENDING: la entrada sigue siendo entregable. */
  deliverable: boolean
  claimantName: string | null
  claimedAt: Date | null
}

/** Resume un link a partir de sus cupos. Los VOID no cuentan: nunca fueron entradas de nadie. */
export function summarizeShare(input: { cancelledAt: Date | null; rows: TransferSummaryRow[] }) {
  const claimedRows = input.rows.filter((r) => r.status === "CLAIMED")
  const pending =
    input.cancelledAt != null
      ? 0
      : input.rows.filter((r) => r.status === "PENDING" && r.deliverable).length
  const status: ShareLinkStatus =
    input.cancelledAt != null ? "CANCELLED" : pending > 0 ? "ACTIVE" : "COMPLETED"
  return {
    total: claimedRows.length + pending,
    claimed: claimedRows.length,
    pending,
    status,
    claims: claimedRows.map((r) => ({
      name: r.claimantName?.trim() || "Un amigo",
      claimedAt: r.claimedAt ? r.claimedAt.toISOString() : null,
    })),
  }
}

/** Un link cancelado o ya agotado que no entregó nada es ruido para el dueño: no se lista. */
export function isShareListable(summary: { status: ShareLinkStatus; claimed: number }): boolean {
  return summary.status === "ACTIVE" || summary.claimed > 0
}

/** `ER_DUP_ENTRY` tal cual lo tira mysql2 o envuelto por Drizzle (`cause`). */
export function isDuplicateEntryError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current != null; depth++) {
    const e = current as { code?: unknown; errno?: unknown; cause?: unknown }
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true
    current = e.cause
  }
  return false
}

// -----------------------------------------------------------------------------
// Vistas para el dueño (comprobante y cuenta del evento)
// -----------------------------------------------------------------------------

export type TicketSharesInfo = {
  /** Hay al menos una entrada para compartir y el evento sigue abierto. */
  canShare: boolean
  /** Lo que se puede poner en un link nuevo, por tipo de entrada. */
  eligible: { ticketTypeId: string; ticketTypeName: string; available: number }[]
  links: ShareLinkDto[]
}

export const EMPTY_TICKET_SHARES: TicketSharesInfo = { canShare: false, eligible: [], links: [] }

/** Entradas con un cupo vigente en algún link → id del link que las reserva. */
export async function earmarkedTickets(
  db: Db,
  ticketIds: string[]
): Promise<Map<string, string>> {
  const reserved = new Map<string, string>()
  if (ticketIds.length === 0) return reserved
  const rows = await db
    .select({ ticketId: ticketTransfers.ticketId, shareId: ticketTransfers.shareId })
    .from(ticketTransfers)
    .where(and(inArray(ticketTransfers.ticketId, ticketIds), eq(ticketTransfers.status, "PENDING")))
  for (const row of rows) reserved.set(row.ticketId, row.shareId)
  return reserved
}

export async function loadOwnerShares(
  db: Db,
  input: { customerId: string; eventId: string; tenantId: string }
): Promise<TicketSharesInfo> {
  const { customerId, eventId, tenantId } = input
  const now = new Date()

  const [ev] = await db
    .select({ status: events.status })
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
    .limit(1)
  const open = ev != null && ev.status !== "closed"

  const owned = await db
    .select({
      id: tickets.id,
      ticketTypeId: tickets.ticketTypeId,
      ticketTypeName: ticketTypes.name,
      validUntil: ticketTypes.validUntil,
    })
    .from(tickets)
    .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
    .where(
      and(
        eq(tickets.customerId, customerId),
        eq(tickets.eventId, eventId),
        eq(tickets.tenantId, tenantId),
        eq(tickets.status, "PENDING")
      )
    )
    .orderBy(asc(ticketTypes.name), asc(tickets.createdAt))

  const reserved = await earmarkedTickets(
    db,
    owned.map((t) => t.id)
  )
  const byType = new Map<string, { ticketTypeId: string; ticketTypeName: string; available: number }>()
  if (open) {
    for (const t of owned) {
      if (reserved.has(t.id) || admissionWindowEnded(t, now)) continue
      const current = byType.get(t.ticketTypeId) ?? {
        ticketTypeId: t.ticketTypeId,
        ticketTypeName: t.ticketTypeName,
        available: 0,
      }
      current.available += 1
      byType.set(t.ticketTypeId, current)
    }
  }
  const eligible = [...byType.values()]

  const shareRows = await db
    .select({ share: ticketShares, ticketTypeName: ticketTypes.name })
    .from(ticketShares)
    .innerJoin(ticketTypes, eq(ticketShares.ticketTypeId, ticketTypes.id))
    .where(
      and(
        eq(ticketShares.ownerCustomerId, customerId),
        eq(ticketShares.eventId, eventId),
        eq(ticketShares.tenantId, tenantId)
      )
    )
    .orderBy(desc(ticketShares.createdAt))

  let links: ShareLinkDto[] = []
  if (shareRows.length > 0) {
    const transferRows = await db
      .select({
        shareId: ticketTransfers.shareId,
        status: ticketTransfers.status,
        claimedAt: ticketTransfers.claimedAt,
        claimantName: ticketTransfers.toName,
        ticketStatus: tickets.status,
        ticketCustomerId: tickets.customerId,
        validUntil: ticketTypes.validUntil,
      })
      .from(ticketTransfers)
      .innerJoin(tickets, eq(ticketTransfers.ticketId, tickets.id))
      .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
      .where(
        inArray(
          ticketTransfers.shareId,
          shareRows.map((r) => r.share.id)
        )
      )
      .orderBy(asc(ticketTransfers.position))

    links = shareRows.flatMap(({ share, ticketTypeName }) => {
      const summary = summarizeShare({
        cancelledAt: share.cancelledAt,
        rows: transferRows
          .filter((r) => r.shareId === share.id)
          .map((r) => ({
            status: r.status,
            deliverable: isTicketDeliverable(
              { status: r.ticketStatus, customerId: r.ticketCustomerId },
              customerId,
              r,
              now
            ),
            claimantName: r.claimantName,
            claimedAt: r.claimedAt,
          })),
      })
      if (!isShareListable(summary)) return []
      return [
        {
          id: share.id,
          token: share.token,
          ticketTypeName,
          ...summary,
          createdAt: share.createdAt ? share.createdAt.toISOString() : null,
        },
      ]
    })
  }

  return { canShare: open && eligible.length > 0, eligible, links }
}

/** Comprobantes del dueño en el evento: es a quienes hay que avisar que cambió algo. */
export async function ownerReceiptTokens(
  db: Db,
  customerId: string,
  eventId: string
): Promise<string[]> {
  const rows = await db
    .select({ receiptToken: sales.receiptToken })
    .from(sales)
    .where(
      and(
        eq(sales.customerId, customerId),
        eq(sales.eventId, eventId),
        eq(sales.status, "COMPLETED")
      )
    )
  return rows.map((r) => r.receiptToken)
}

// -----------------------------------------------------------------------------
// Armar y cancelar un link
// -----------------------------------------------------------------------------

export type CreateShareInput = {
  customerId: string
  eventId: string
  tenantId: string
  ticketTypeId: string
  quantity: number
}

export type CreateShareResult =
  | { ok: true; share: ShareLinkDto }
  | { ok: false; code: ShareErrorCode }

export async function createTicketShare(db: Db, input: CreateShareInput): Promise<CreateShareResult> {
  const { customerId, eventId, tenantId, ticketTypeId, quantity } = input
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_SHARE_QUANTITY) {
    return { ok: false, code: "INVALID_QUANTITY" }
  }

  return db.transaction(async (tx) => {
    // Primero, un lock por dueño: todo lo que arma links para la misma persona se atiende de a uno.
    // Tiene que ser lo PRIMERO de la transacción: bajo REPEATABLE READ el snapshot de las lecturas
    // comunes se toma en la primera lectura no bloqueante, así que todo lo que se lee después ya ve
    // lo que confirmó el pedido anterior (un doble toque no reserva dos veces las mismas entradas).
    const [owner] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, customerId))
      .for("update")
      .limit(1)
    if (!owner) return { ok: false as const, code: "HOLDER_NOT_FOUND" as const }

    const [ev] = await tx
      .select({ status: events.status })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
      .limit(1)
    if (!ev || ev.status === "closed") return { ok: false as const, code: "EVENT_CLOSED" as const }

    const [type] = await tx
      .select({ name: ticketTypes.name, validUntil: ticketTypes.validUntil })
      .from(ticketTypes)
      .where(
        and(
          eq(ticketTypes.id, ticketTypeId),
          eq(ticketTypes.eventId, eventId),
          eq(ticketTypes.tenantId, tenantId)
        )
      )
      .limit(1)
    if (!type) return { ok: false as const, code: "TICKET_TYPE_NOT_FOUND" as const }
    if (admissionWindowEnded(type)) return { ok: false as const, code: "NOT_ENOUGH_TICKETS" as const }

    // Lectura actual de las entradas candidatas: si entre el lock del dueño y acá la puerta usó una
    // o un link se llevó otra, no figuran.
    const candidates = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.customerId, customerId),
          eq(tickets.eventId, eventId),
          eq(tickets.tenantId, tenantId),
          eq(tickets.ticketTypeId, ticketTypeId),
          eq(tickets.status, "PENDING")
        )
      )
      .orderBy(asc(tickets.createdAt), asc(tickets.id))
      .for("update")

    const reservedRows =
      candidates.length === 0
        ? []
        : await tx
            .select({ ticketId: ticketTransfers.ticketId })
            .from(ticketTransfers)
            .where(
              and(
                inArray(
                  ticketTransfers.ticketId,
                  candidates.map((c) => c.id)
                ),
                eq(ticketTransfers.status, "PENDING")
              )
            )
    const reserved = new Set(reservedRows.map((r) => r.ticketId))
    const free = candidates.filter((c) => !reserved.has(c.id))
    if (free.length < quantity) return { ok: false as const, code: "NOT_ENOUGH_TICKETS" as const }

    const shareId = uuidv4()
    const token = generateShareToken()
    const now = new Date()
    await tx.insert(ticketShares).values({
      id: shareId,
      tenantId,
      eventId,
      ticketTypeId,
      ownerCustomerId: customerId,
      token,
      createdAt: now,
    })
    await tx.insert(ticketTransfers).values(
      free.slice(0, quantity).map((ticket, position) => ({
        id: uuidv4(),
        shareId,
        ticketId: ticket.id,
        tenantId,
        eventId,
        fromCustomerId: customerId,
        position,
        status: "PENDING" as const,
        createdAt: now,
      }))
    )

    return {
      ok: true as const,
      share: {
        id: shareId,
        token,
        ticketTypeName: type.name,
        total: quantity,
        claimed: 0,
        pending: quantity,
        status: "ACTIVE" as const,
        createdAt: now.toISOString(),
        claims: [],
      },
    }
  })
}

/**
 * Cancela un link: los cupos que nadie reclamó vuelven a ser entradas comunes del dueño. Lo ya
 * reclamado no se deshace (la entrada es del amigo). Idempotente.
 */
export async function cancelTicketShare(
  db: Db,
  input: { shareId: string; customerId: string; eventId: string; tenantId: string }
): Promise<{ ok: true } | { ok: false; code: ShareErrorCode }> {
  return db.transaction(async (tx) => {
    const [share] = await tx
      .select()
      .from(ticketShares)
      .where(eq(ticketShares.id, input.shareId))
      .for("update")
      .limit(1)
    // Un link de otro cliente, evento o productora es indistinguible de uno inexistente.
    if (
      !share ||
      share.ownerCustomerId !== input.customerId ||
      share.eventId !== input.eventId ||
      share.tenantId !== input.tenantId
    ) {
      return { ok: false as const, code: "SHARE_NOT_FOUND" as const }
    }
    if (share.cancelledAt != null) return { ok: true as const }

    await tx
      .update(ticketShares)
      .set({ cancelledAt: new Date() })
      .where(eq(ticketShares.id, share.id))
    await tx
      .update(ticketTransfers)
      .set({ status: "VOID" })
      .where(and(eq(ticketTransfers.shareId, share.id), eq(ticketTransfers.status, "PENDING")))
    return { ok: true as const }
  })
}

// -----------------------------------------------------------------------------
// Lo que ve el amigo: vista previa y canje
// -----------------------------------------------------------------------------

export type SharePreviewState = "AVAILABLE" | "SOLD_OUT" | "CANCELLED" | "EVENT_CLOSED"

export type SharePreview = {
  state: SharePreviewState
  /** Nombre de pila de quien armó el link. */
  hostName: string
  event: {
    id: string
    slug: string | null
    name: string
    date: Date
    venue: string | null
    location: string | null
    imageUrl: string | null
  }
  productoraName: string
  ticketType: { name: string; validFrom: Date | null; validUntil: Date | null }
  remaining: number
  total: number
}

export async function getSharePreview(db: Db, token: string): Promise<SharePreview | null> {
  const [row] = await db
    .select({
      share: ticketShares,
      ownerName: customers.name,
      typeName: ticketTypes.name,
      validFrom: ticketTypes.validFrom,
      validUntil: ticketTypes.validUntil,
      eventId: events.id,
      eventSlug: events.slug,
      eventName: events.name,
      eventDate: events.date,
      eventVenue: events.venue,
      eventLocation: events.location,
      eventImageUrl: events.imageUrl,
      eventStatus: events.status,
      productoraName: tenants.name,
    })
    .from(ticketShares)
    .innerJoin(customers, eq(ticketShares.ownerCustomerId, customers.id))
    .innerJoin(ticketTypes, eq(ticketShares.ticketTypeId, ticketTypes.id))
    .innerJoin(events, eq(ticketShares.eventId, events.id))
    .innerJoin(tenants, eq(ticketShares.tenantId, tenants.id))
    .where(eq(ticketShares.token, token))
    .limit(1)
  if (!row) return null

  const now = new Date()
  const transferRows = await db
    .select({
      status: ticketTransfers.status,
      ticketStatus: tickets.status,
      ticketCustomerId: tickets.customerId,
    })
    .from(ticketTransfers)
    .innerJoin(tickets, eq(ticketTransfers.ticketId, tickets.id))
    .where(eq(ticketTransfers.shareId, row.share.id))
  const summary = summarizeShare({
    cancelledAt: row.share.cancelledAt,
    rows: transferRows.map((r) => ({
      status: r.status,
      deliverable: isTicketDeliverable(
        { status: r.ticketStatus, customerId: r.ticketCustomerId },
        row.share.ownerCustomerId,
        row,
        now
      ),
      claimantName: null,
      claimedAt: null,
    })),
  })

  const state: SharePreviewState =
    row.share.cancelledAt != null
      ? "CANCELLED"
      : row.eventStatus === "closed"
        ? "EVENT_CLOSED"
        : summary.pending === 0
          ? "SOLD_OUT"
          : "AVAILABLE"

  return {
    state,
    hostName: firstNameOf(row.ownerName),
    event: {
      id: row.eventId,
      slug: row.eventSlug ?? null,
      name: row.eventName,
      date: row.eventDate,
      venue: row.eventVenue,
      location: row.eventLocation,
      imageUrl: row.eventImageUrl ?? null,
    },
    productoraName: row.productoraName,
    ticketType: { name: row.typeName, validFrom: row.validFrom, validUntil: row.validUntil },
    remaining: summary.pending,
    total: summary.total,
  }
}

export type ClaimInput = {
  firstName: string
  lastName: string
  /** Ya normalizado por `normalizeDni`. */
  dni: string
  /** Ya normalizado por `normalizeClaimPhone`. */
  phone: string
  email: string
}

export type ClaimedTicket = {
  ticketId: string
  qrHash: string
  ticketType: { name: string; validFrom: Date | null; validUntil: Date | null }
  event: SharePreview["event"]
  tenantId: string
  ownerCustomerId: string
  claimant: { customerId: string; name: string; email: string; createdNow: boolean }
}

export type ClaimResult = { ok: true; claimed: ClaimedTicket } | { ok: false; code: ShareErrorCode }

/** Aborta la transacción del canje (y deshace lo escrito hasta ahí) con un motivo de negocio. */
class ClaimAbort extends Error {
  constructor(readonly code: ShareErrorCode) {
    super(code)
  }
}

export async function claimTicketShare(
  db: Db,
  token: string,
  input: ClaimInput
): Promise<ClaimResult> {
  const fullName = joinFullName(input.firstName, input.lastName)

  try {
    return await db.transaction(async (tx): Promise<ClaimResult> => {
      // El link se bloquea: dos amigos que tocan "reclamar" a la vez se atienden de a uno.
      const [share] = await tx
        .select()
        .from(ticketShares)
        .where(eq(ticketShares.token, token))
        .for("update")
        .limit(1)
      if (!share) return { ok: false, code: "SHARE_NOT_FOUND" }
      if (share.cancelledAt != null) return { ok: false, code: "SHARE_CANCELLED" }

      const [ev] = await tx
        .select({
          id: events.id,
          slug: events.slug,
          name: events.name,
          date: events.date,
          venue: events.venue,
          location: events.location,
          imageUrl: events.imageUrl,
          status: events.status,
        })
        .from(events)
        .where(and(eq(events.id, share.eventId), eq(events.tenantId, share.tenantId)))
        .limit(1)
      if (!ev || ev.status === "closed") return { ok: false, code: "EVENT_CLOSED" }

      const [type] = await tx
        .select({
          name: ticketTypes.name,
          validFrom: ticketTypes.validFrom,
          validUntil: ticketTypes.validUntil,
        })
        .from(ticketTypes)
        .where(eq(ticketTypes.id, share.ticketTypeId))
        .limit(1)
      if (!type) return { ok: false, code: "SHARE_NOT_FOUND" }

      // Cupos que todavía se pueden entregar, en orden. Los que dejaron de ser entregables (la
      // entrada se usó, se anuló o ya no es del dueño) se marcan VOID y no se vuelven a mirar.
      const now = new Date()
      const pendingRows = await tx
        .select({
          transferId: ticketTransfers.id,
          ticketId: ticketTransfers.ticketId,
          ticketStatus: tickets.status,
          ticketCustomerId: tickets.customerId,
        })
        .from(ticketTransfers)
        .innerJoin(tickets, eq(ticketTransfers.ticketId, tickets.id))
        .where(and(eq(ticketTransfers.shareId, share.id), eq(ticketTransfers.status, "PENDING")))
        .orderBy(asc(ticketTransfers.position))

      const stale: string[] = []
      const candidates: { transferId: string; ticketId: string }[] = []
      for (const row of pendingRows) {
        const deliverable = isTicketDeliverable(
          { status: row.ticketStatus, customerId: row.ticketCustomerId },
          share.ownerCustomerId,
          type,
          now
        )
        if (deliverable) candidates.push(row)
        else stale.push(row.transferId)
      }
      if (stale.length > 0) {
        await tx
          .update(ticketTransfers)
          .set({ status: "VOID" })
          .where(inArray(ticketTransfers.id, stale))
      }
      if (candidates.length === 0) return { ok: false, code: "SOLD_OUT" }

      // Quién reclama. Un DNI que ya existe es la misma persona: se la reutiliza sin tocarle
      // nombre ni email (el formulario es público y no verifica que el DNI sea de quien lo escribe).
      const [existing] = await tx
        .select()
        .from(customers)
        .where(eq(customers.dni, input.dni))
        .limit(1)

      if (existing) {
        if (existing.isActive === false) return { ok: false, code: "CUSTOMER_INACTIVE" }
        if (existing.id === share.ownerCustomerId) return { ok: false, code: "OWN_SHARE" }
        const [already] = await tx
          .select({ id: ticketTransfers.id })
          .from(ticketTransfers)
          .where(
            and(
              eq(ticketTransfers.shareId, share.id),
              eq(ticketTransfers.toCustomerId, existing.id)
            )
          )
          .limit(1)
        if (already) return { ok: false, code: "ALREADY_CLAIMED" }
      }

      let customerId: string
      let createdNow = false
      if (existing) {
        customerId = existing.id
        // Sólo se completa un celular que no había; uno existente no se pisa nunca.
        if (!existing.phone) {
          await tx.update(customers).set({ phone: input.phone }).where(eq(customers.id, existing.id))
        }
      } else {
        const created = await insertClaimantCustomer(tx, {
          name: fullName,
          email: input.email,
          phone: input.phone,
          dni: input.dni,
        })
        customerId = created.id
        createdNow = created.createdNow
        if (!createdNow) {
          // Otro pedido creó esta ficha un instante antes: se aplican las mismas guardas.
          if (customerId === share.ownerCustomerId) return { ok: false, code: "OWN_SHARE" }
        }
      }

      // Entrega: UPDATE condicional. Si entre la lectura y acá la entrada cambió de manos o se
      // usó, ese cupo se anula y se prueba con el siguiente.
      const newQrHash = randomUUID()
      let delivered: { transferId: string; ticketId: string } | null = null
      for (const candidate of candidates) {
        const [result] = await tx
          .update(tickets)
          .set({
            customerId,
            buyerName: fullName,
            buyerEmail: input.email,
            buyerDni: input.dni,
            qrHash: newQrHash,
            // El mail anterior (con el QR viejo) ya no sirve: el nuevo dueño recibe el suyo.
            emailSentAt: null,
          })
          .where(
            and(
              eq(tickets.id, candidate.ticketId),
              eq(tickets.customerId, share.ownerCustomerId),
              eq(tickets.status, "PENDING")
            )
          )
        if (result.affectedRows === 1) {
          delivered = candidate
          break
        }
        await tx
          .update(ticketTransfers)
          .set({ status: "VOID" })
          .where(eq(ticketTransfers.id, candidate.transferId))
      }
      if (!delivered) throw new ClaimAbort("SOLD_OUT")

      try {
        await tx
          .update(ticketTransfers)
          .set({ status: "CLAIMED", toCustomerId: customerId, toName: fullName, claimedAt: now })
          .where(eq(ticketTransfers.id, delivered.transferId))
      } catch (error) {
        // El unique (link, cliente): la misma persona no se lleva dos entradas del mismo link.
        if (isDuplicateEntryError(error)) throw new ClaimAbort("ALREADY_CLAIMED")
        throw error
      }

      return {
        ok: true,
        claimed: {
          ticketId: delivered.ticketId,
          qrHash: newQrHash,
          ticketType: type,
          event: {
            id: ev.id,
            slug: ev.slug ?? null,
            name: ev.name,
            date: ev.date,
            venue: ev.venue,
            location: ev.location,
            imageUrl: ev.imageUrl ?? null,
          },
          tenantId: share.tenantId,
          ownerCustomerId: share.ownerCustomerId,
          // Siempre el nombre tipeado: el de una ficha existente no se le devuelve a quien
          // escribió el DNI (no se verifica que sea suyo).
          claimant: { customerId, name: fullName, email: input.email, createdNow },
        },
      }
    })
  } catch (error) {
    if (error instanceof ClaimAbort) return { ok: false, code: error.code }
    throw error
  }
}

/**
 * Alta del cliente que reclama. `customers.email` es NOT NULL y único en toda la plataforma: si el
 * email que escribió ya es de otra ficha (otro DNI), no se le cuelga esta a esa persona — la ficha
 * se crea con el email sintético `acceso-{dni}@crow.local` (el mismo que usa el acceso por evento,
 * que `isDeliverableEmail` filtra) y el email real queda igual en la entrada.
 *
 * Dos pedidos pueden querer crear el mismo DNI a la vez: el segundo choca con el unique y se
 * resuelve leyendo la ficha que ganó.
 */
async function insertClaimantCustomer(
  tx: Tx,
  input: { name: string; email: string; phone: string; dni: string }
): Promise<{ id: string; createdNow: boolean }> {
  const [emailOwner] = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.email, input.email))
    .limit(1)

  const attempts = emailOwner
    ? [`acceso-${input.dni}@crow.local`]
    : [input.email, `acceso-${input.dni}@crow.local`]

  for (const email of attempts) {
    const id = uuidv4()
    try {
      await tx.insert(customers).values({
        id,
        name: input.name,
        email,
        phone: input.phone,
        dni: input.dni,
        isActive: true,
        createdAt: new Date(),
      })
      return { id, createdNow: true }
    } catch (error) {
      if (!isDuplicateEntryError(error)) throw error
      // Lectura actual (`FOR UPDATE`) y no de snapshot: bajo REPEATABLE READ un SELECT común no ve
      // la fila que el otro pedido acaba de confirmar, y el choque no se podría resolver.
      const [winner] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.dni, input.dni))
        .for("update")
        .limit(1)
      if (winner) return { id: winner.id, createdNow: false }
      // El choque fue por el email (otro pedido lo tomó entre la consulta y el alta): se reintenta
      // con el sintético, que es único por DNI.
    }
  }
  throw new Error("No se pudo registrar al cliente")
}
