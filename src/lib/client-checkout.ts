import { and, count, eq, ne } from "drizzle-orm"
import type { MySql2Transaction } from "drizzle-orm/mysql2"
import * as schema from "../db/schema"
import {
  digitalConsumptions,
  events,
  products,
  saleItems,
  sales,
  ticketTypes,
  tickets,
} from "../db/schema"
import { v4 as uuidv4 } from "uuid"
import { randomUUID } from "node:crypto"
import { executeTicketPurchase, PurchaseError } from "./ticket-purchase"
import { dec, decFromDb, decToDb } from "./decimal-money"

type Tx = MySql2Transaction<typeof schema, typeof schema>

export type ClientCheckoutTicketLine = { ticketTypeId: string; quantity: number }
export type ClientCheckoutDrinkLine = { productId: string; quantity: number }

export type ClientCheckoutParams = {
  eventId: string
  customerId: string
  customerName: string
  customerEmail: string
  ticketLines: ClientCheckoutTicketLine[]
  drinkLines: ClientCheckoutDrinkLine[]
}

export type ClientCheckoutResult = {
  saleId: string
  ticketIds: string[]
  consumptionIds: string[]
}

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

export async function executeClientCheckout(
  tx: Tx,
  params: ClientCheckoutParams
): Promise<ClientCheckoutResult> {
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

  let total = dec(0)

  const normalizedTickets = params.ticketLines.filter((l) => l.quantity > 0)
  const normalizedDrinks = params.drinkLines.filter((l) => l.quantity > 0)

  for (const line of normalizedTickets) {
    const [tt] = await tx
      .select()
      .from(ticketTypes)
      .where(
        and(
          eq(ticketTypes.id, line.ticketTypeId),
          eq(ticketTypes.tenantId, tenantId),
          eq(ticketTypes.eventId, params.eventId)
        )
      )
      .limit(1)

    if (!tt) {
      throw new PurchaseError("TICKET_TYPE_NOT_FOUND")
    }

    const sold = await countIssuedForType(tx, tenantId, line.ticketTypeId)
    const limit = tt.stockLimit
    if (limit != null && sold + line.quantity > limit) {
      throw new PurchaseError("OUT_OF_STOCK")
    }

    total = total.add(decFromDb(tt.price).mul(line.quantity))
  }

  for (const line of normalizedDrinks) {
    const [p] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, line.productId), eq(products.tenantId, tenantId)))
      .limit(1)

    if (!p || p.isActive === false) {
      throw new PurchaseError("PRODUCT_NOT_FOUND")
    }

    total = total.add(decFromDb(p.price).mul(line.quantity))
  }

  const saleId = uuidv4()
  await tx.insert(sales).values({
    id: saleId,
    eventId: params.eventId,
    tenantId,
    customerId: params.customerId,
    source: "APP",
    totalAmount: decToDb(total),
    paymentMethod: "CARD",
    status: "COMPLETED",
    createdAt: new Date(),
  })

  for (const line of normalizedDrinks) {
    const [p] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, line.productId), eq(products.tenantId, tenantId)))
      .limit(1)
    if (!p) continue

    await tx.insert(saleItems).values({
      id: uuidv4(),
      saleId,
      productId: line.productId,
      quantity: line.quantity,
      priceAtTime: p.price,
    })
  }

  const ticketIds: string[] = []
  for (const line of normalizedTickets) {
    for (let i = 0; i < line.quantity; i++) {
      const { ticket } = await executeTicketPurchase(tx, {
        eventId: params.eventId,
        ticketTypeId: line.ticketTypeId,
        buyerName: params.customerName,
        buyerEmail: params.customerEmail,
        customerId: params.customerId,
      })
      ticketIds.push(ticket.id)
    }
  }

  const consumptionIds: string[] = []
  for (const line of normalizedDrinks) {
    const [p] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, line.productId), eq(products.tenantId, tenantId)))
      .limit(1)
    if (!p) continue

    for (let i = 0; i < line.quantity; i++) {
      const id = uuidv4()
      const qrHash = randomUUID()
      await tx.insert(digitalConsumptions).values({
        id,
        customerId: params.customerId,
        eventId: params.eventId,
        tenantId,
        productId: line.productId,
        saleId,
        qrHash,
        status: "PENDING",
        createdAt: new Date(),
      })
      consumptionIds.push(id)
    }
  }

  return { saleId, ticketIds, consumptionIds }
}
