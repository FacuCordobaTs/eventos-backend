import { and, count, eq, ne } from "drizzle-orm"
import type { MySql2Transaction } from "drizzle-orm/mysql2"
import * as schema from "../db/schema"
import { events, ticketTypes, tickets } from "../db/schema"
import { v4 as uuidv4 } from "uuid"
import { randomUUID } from "node:crypto"

export type PurchaseErrorCode =
  | "EVENT_NOT_FOUND"
  | "TICKET_TYPE_NOT_FOUND"
  | "OUT_OF_STOCK"
  | "EVENT_INACTIVE"
  | "PRODUCT_NOT_FOUND"

export class PurchaseError extends Error {
  readonly code: PurchaseErrorCode

  constructor(code: PurchaseErrorCode) {
    super(code)
    this.name = "PurchaseError"
    this.code = code
  }
}

type Tx = MySql2Transaction<typeof schema, typeof schema>

async function countIssuedForType(
  tx: Tx,
  tenantId: string,
  ticketTypeId: string
): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(tickets)
    .where(
      and(
        eq(tickets.tenantId, tenantId),
        eq(tickets.ticketTypeId, ticketTypeId),
        ne(tickets.status, "CANCELLED")
      )
    )
  return Number(row?.n ?? 0)
}

export type PurchaseParams = {
  eventId: string
  ticketTypeId: string
  buyerName: string
  buyerEmail: string
  /** App B2B2C: vincula la entrada al cliente. */
  customerId?: string
  /** Staff flows: must match event tenant. Omit for public (tenant taken from event). */
  enforceTenantId?: string
}

export type PurchaseRow = typeof tickets.$inferSelect

export async function executeTicketPurchase(
  tx: Tx,
  params: PurchaseParams
): Promise<{
  ticket: PurchaseRow
  ticketTypeName: string
}> {
  const [ev] = await tx
    .select()
    .from(events)
    .where(eq(events.id, params.eventId))
    .limit(1)

  if (!ev) {
    throw new PurchaseError("EVENT_NOT_FOUND")
  }
  if (ev.isActive === false) {
    throw new PurchaseError("EVENT_INACTIVE")
  }

  const tenantId = ev.tenantId
  if (
    params.enforceTenantId !== undefined &&
    params.enforceTenantId !== tenantId
  ) {
    throw new PurchaseError("EVENT_NOT_FOUND")
  }

  const [tt] = await tx
    .select()
    .from(ticketTypes)
    .where(
      and(
        eq(ticketTypes.id, params.ticketTypeId),
        eq(ticketTypes.tenantId, tenantId),
        eq(ticketTypes.eventId, params.eventId)
      )
    )
    .limit(1)

  if (!tt) {
    throw new PurchaseError("TICKET_TYPE_NOT_FOUND")
  }

  const sold = await countIssuedForType(tx, tenantId, params.ticketTypeId)
  const limit = tt.stockLimit
  if (limit != null && sold >= limit) {
    throw new PurchaseError("OUT_OF_STOCK")
  }

  const ticketId = uuidv4()
  const qrHash = randomUUID()

  await tx.insert(tickets).values({
    id: ticketId,
    ticketTypeId: params.ticketTypeId,
    eventId: params.eventId,
    tenantId,
    qrHash,
    status: "PENDING",
    buyerName: params.buyerName,
    buyerEmail: params.buyerEmail,
    ...(params.customerId !== undefined ? { customerId: params.customerId } : {}),
    createdAt: new Date(),
  })

  const [row] = await tx
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, tenantId)))
    .limit(1)

  if (!row) {
    throw new PurchaseError("EVENT_NOT_FOUND")
  }

  return { ticket: row, ticketTypeName: tt.name }
}

export function purchaseErrorStatus(
  code: PurchaseErrorCode
): { status: number; body: { error: string } } {
  switch (code) {
    case "EVENT_NOT_FOUND":
      return { status: 404, body: { error: "Evento no encontrado" } }
    case "EVENT_INACTIVE":
      return { status: 404, body: { error: "Evento no disponible" } }
    case "TICKET_TYPE_NOT_FOUND":
      return { status: 404, body: { error: "Tipo de entrada no encontrado" } }
    case "OUT_OF_STOCK":
      return {
        status: 409,
        body: { error: "Sin stock disponible para este tipo de entrada" },
      }
    case "PRODUCT_NOT_FOUND":
      return { status: 404, body: { error: "Producto no disponible" } }
    default:
      return { status: 500, body: { error: "Error al procesar la compra" } }
  }
}
