import { and, count, eq, ne } from "drizzle-orm"
import type { MySql2Transaction } from "drizzle-orm/mysql2"
import * as schema from "../db/schema"
import {
  customers,
  digitalConsumptions,
  eventProducts,
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

export type ClientCheckoutContact = {
  name: string
  email: string
  phone: string
}

export type ClientCheckoutParams = {
  eventId: string
  contact: ClientCheckoutContact
  paymentMethod: (typeof sales.$inferInsert)["paymentMethod"]
  /** Total enviado por el cliente, ej. "123.45"; debe coincidir exacto con el servidor. */
  clientTotal: string
  ticketLines: ClientCheckoutTicketLine[]
  drinkLines: ClientCheckoutDrinkLine[]
}

export type ClientCheckoutResult = {
  saleId: string
  receiptToken: string
  ticketIds: string[]
  consumptionIds: string[]
}

function assertWindow(
  availableFrom: Date | null | undefined,
  code: "TICKETS_NOT_YET_AVAILABLE" | "CONSUMPTIONS_NOT_YET_AVAILABLE"
) {
  if (availableFrom == null) return
  if (Date.now() < availableFrom.getTime()) {
    throw new PurchaseError(code)
  }
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

async function findOrCreateCustomer(
  tx: Tx,
  contact: ClientCheckoutContact
): Promise<string> {
  const name = contact.name.trim()
  const email = contact.email.toLowerCase().trim()
  const phone = contact.phone.trim()

  const [byEmail] = await tx
    .select()
    .from(customers)
    .where(eq(customers.email, email))
    .limit(1)

  if (byEmail) {
    await tx
      .update(customers)
      .set({ name, phone: phone || byEmail.phone })
      .where(eq(customers.id, byEmail.id))
    return byEmail.id
  }

  if (phone !== "") {
    const [byPhone] = await tx
      .select()
      .from(customers)
      .where(eq(customers.phone, phone))
      .limit(1)
    if (byPhone) {
      await tx
        .update(customers)
        .set({ name, email })
        .where(eq(customers.id, byPhone.id))
      return byPhone.id
    }
  }

  const id = uuidv4()
  await tx.insert(customers).values({
    id,
    name,
    email,
    phone: phone || null,
    isActive: true,
    createdAt: new Date(),
  })
  return id
}

export async function executeClientCheckout(
  tx: Tx,
  params: ClientCheckoutParams
): Promise<ClientCheckoutResult> {
  const normalizedTickets = params.ticketLines.filter((l) => l.quantity > 0)
  const normalizedDrinks = params.drinkLines.filter((l) => l.quantity > 0)

  if (normalizedTickets.length === 0 && normalizedDrinks.length === 0) {
    throw new PurchaseError("EMPTY_CART")
  }

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

  if (normalizedTickets.length > 0) {
    assertWindow(ev.ticketsAvailableFrom, "TICKETS_NOT_YET_AVAILABLE")
  }
  if (normalizedDrinks.length > 0) {
    assertWindow(ev.consumptionsAvailableFrom, "CONSUMPTIONS_NOT_YET_AVAILABLE")
  }

  const customerId = await findOrCreateCustomer(tx, params.contact)

  type PricedDrink = { productId: string; unit: ReturnType<typeof dec> }
  const drinkPrices = new Map<string, PricedDrink>()

  let total = dec(0)

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
    const [row] = await tx
      .select({
        productId: eventProducts.productId,
        priceOverride: eventProducts.priceOverride,
        basePrice: products.price,
      })
      .from(eventProducts)
      .innerJoin(products, eq(eventProducts.productId, products.id))
      .where(
        and(
          eq(eventProducts.eventId, params.eventId),
          eq(eventProducts.tenantId, tenantId),
          eq(eventProducts.productId, line.productId),
          eq(eventProducts.isActive, true),
          eq(products.tenantId, tenantId),
          eq(products.isActive, true)
        )
      )
      .limit(1)

    if (!row) {
      throw new PurchaseError("PRODUCT_NOT_FOUND")
    }

    const unit =
      row.priceOverride != null && row.priceOverride !== ""
        ? decFromDb(row.priceOverride)
        : decFromDb(row.basePrice)
    drinkPrices.set(line.productId, { productId: line.productId, unit })
    total = total.add(unit.mul(line.quantity))
  }

  const serverTotalStr = decToDb(total)
  if (!total.eq(dec(params.clientTotal.trim()))) {
    throw new PurchaseError("CHECKOUT_TOTAL_MISMATCH")
  }

  const saleId = uuidv4()
  const receiptToken = randomUUID()

  await tx.insert(sales).values({
    id: saleId,
    eventId: params.eventId,
    tenantId,
    customerId,
    receiptToken,
    source: "WEB",
    totalAmount: serverTotalStr,
    paymentMethod: params.paymentMethod,
    status: "COMPLETED",
    createdAt: new Date(),
  })

  for (const line of normalizedDrinks) {
    const priced = drinkPrices.get(line.productId)!
    await tx.insert(saleItems).values({
      id: uuidv4(),
      saleId,
      productId: line.productId,
      quantity: line.quantity,
      priceAtTime: decToDb(priced.unit),
    })
  }

  const ticketIds: string[] = []
  for (const line of normalizedTickets) {
    for (let i = 0; i < line.quantity; i++) {
      const { ticket } = await executeTicketPurchase(tx, {
        eventId: params.eventId,
        ticketTypeId: line.ticketTypeId,
        buyerName: params.contact.name.trim(),
        buyerEmail: params.contact.email.toLowerCase().trim(),
        customerId,
        saleId,
      })
      ticketIds.push(ticket.id)
    }
  }

  const consumptionIds: string[] = []
  for (const line of normalizedDrinks) {
    for (let i = 0; i < line.quantity; i++) {
      const id = uuidv4()
      const qrHash = randomUUID()
      await tx.insert(digitalConsumptions).values({
        id,
        customerId,
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

  return { saleId, receiptToken, ticketIds, consumptionIds }
}
