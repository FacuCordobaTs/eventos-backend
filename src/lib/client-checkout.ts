import { and, count, eq, ne } from "drizzle-orm"
import type { MySql2Transaction } from "drizzle-orm/mysql2"
import * as schema from "../db/schema"
import type { GuestCheckoutSnapshotJson } from "../db/schema"
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
  tenantId: string
  /** Checkout Pro: preferencia MP + redirect. */
  pendingMercadoPago?: boolean
  /** Tarjeta (Brick): venta PENDING hasta pagar en `/receipt`. */
  payOnReceipt?: boolean
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

type PricedDrink = { productId: string; unit: ReturnType<typeof dec> }

type PreparedGuestCheckout = {
  ev: typeof events.$inferSelect
  tenantId: string
  customerId: string
  total: ReturnType<typeof dec>
  serverTotalStr: string
  normalizedTickets: ClientCheckoutTicketLine[]
  normalizedDrinks: ClientCheckoutDrinkLine[]
  drinkPrices: Map<string, PricedDrink>
}

async function prepareGuestCheckout(
  tx: Tx,
  params: ClientCheckoutParams
): Promise<PreparedGuestCheckout> {
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

  return {
    ev,
    tenantId,
    customerId,
    total,
    serverTotalStr,
    normalizedTickets,
    normalizedDrinks,
    drinkPrices,
  }
}

export async function executeClientCheckout(
  tx: Tx,
  params: ClientCheckoutParams
): Promise<ClientCheckoutResult> {
  const prep = await prepareGuestCheckout(tx, params)

  if (params.paymentMethod === "MERCADOPAGO" || params.paymentMethod === "CARD") {
    const saleId = uuidv4()
    const receiptToken = randomUUID()
    const method = params.paymentMethod

    const snapshot: GuestCheckoutSnapshotJson = {
      ticketLines: prep.normalizedTickets.map((l) => ({
        ticketTypeId: l.ticketTypeId,
        quantity: l.quantity,
      })),
      drinkLines: prep.normalizedDrinks.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
      })),
      contact: {
        name: params.contact.name.trim(),
        email: params.contact.email.toLowerCase().trim(),
        phone: params.contact.phone.trim(),
      },
    }

    await tx.insert(sales).values({
      id: saleId,
      eventId: params.eventId,
      tenantId: prep.tenantId,
      customerId: prep.customerId,
      receiptToken,
      source: "WEB",
      totalAmount: prep.serverTotalStr,
      paymentMethod: method,
      status: "PENDING",
      guestCheckoutSnapshot: snapshot,
      createdAt: new Date(),
    })

    for (const line of prep.normalizedDrinks) {
      const priced = prep.drinkPrices.get(line.productId)!
      await tx.insert(saleItems).values({
        id: uuidv4(),
        saleId,
        productId: line.productId,
        quantity: line.quantity,
        priceAtTime: decToDb(priced.unit),
      })
    }

    return {
      saleId,
      receiptToken,
      ticketIds: [],
      consumptionIds: [],
      tenantId: prep.tenantId,
      pendingMercadoPago: method === "MERCADOPAGO",
      payOnReceipt: method === "CARD",
    }
  }

  const saleId = uuidv4()
  const receiptToken = randomUUID()

  await tx.insert(sales).values({
    id: saleId,
    eventId: params.eventId,
    tenantId: prep.tenantId,
    customerId: prep.customerId,
    receiptToken,
    source: "WEB",
    totalAmount: prep.serverTotalStr,
    paymentMethod: params.paymentMethod,
    status: "COMPLETED",
    createdAt: new Date(),
  })

  for (const line of prep.normalizedDrinks) {
    const priced = prep.drinkPrices.get(line.productId)!
    await tx.insert(saleItems).values({
      id: uuidv4(),
      saleId,
      productId: line.productId,
      quantity: line.quantity,
      priceAtTime: decToDb(priced.unit),
    })
  }

  const ticketIds: string[] = []
  for (const line of prep.normalizedTickets) {
    for (let i = 0; i < line.quantity; i++) {
      const { ticket } = await executeTicketPurchase(tx, {
        eventId: params.eventId,
        ticketTypeId: line.ticketTypeId,
        buyerName: params.contact.name.trim(),
        buyerEmail: params.contact.email.toLowerCase().trim(),
        customerId: prep.customerId,
        saleId,
      })
      ticketIds.push(ticket.id)
    }
  }

  const consumptionIds: string[] = []
  for (const line of prep.normalizedDrinks) {
    for (let i = 0; i < line.quantity; i++) {
      const id = uuidv4()
      const qrHash = randomUUID()
      await tx.insert(digitalConsumptions).values({
        id,
        customerId: prep.customerId,
        eventId: params.eventId,
        tenantId: prep.tenantId,
        productId: line.productId,
        saleId,
        qrHash,
        status: "PENDING",
        createdAt: new Date(),
      })
      consumptionIds.push(id)
    }
  }

  return {
    saleId,
    receiptToken,
    ticketIds,
    consumptionIds,
    tenantId: prep.tenantId,
  }
}

/**
 * Completa una venta web PENDING tras pago MP aprobado (misma transacción que el webhook).
 */
export async function fulfillPendingGuestCheckout(
  tx: Tx,
  saleId: string
): Promise<ClientCheckoutResult> {
  const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).limit(1)
  if (!sale) {
    throw new Error("FULFILL_SALE_NOT_FOUND")
  }
  if (sale.status === "COMPLETED") {
    return {
      saleId: sale.id,
      receiptToken: sale.receiptToken,
      ticketIds: [],
      consumptionIds: [],
      tenantId: sale.tenantId,
    }
  }
  if (
    sale.status !== "PENDING" ||
    (sale.paymentMethod !== "MERCADOPAGO" && sale.paymentMethod !== "CARD")
  ) {
    throw new Error("FULFILL_INVALID_SALE_STATE")
  }

  const snap = sale.guestCheckoutSnapshot
  if (snap == null) {
    throw new Error("FULFILL_NO_SNAPSHOT")
  }

  const customerId = sale.customerId
  if (customerId == null || customerId === "") {
    throw new Error("FULFILL_NO_CUSTOMER")
  }

  const eventId = sale.eventId
  const tenantId = sale.tenantId

  const normalizedTickets = snap.ticketLines
  const normalizedDrinks = snap.drinkLines

  const contact: ClientCheckoutContact = {
    name: snap.contact.name,
    email: snap.contact.email,
    phone: snap.contact.phone,
  }

  const drinkPrices = new Map<string, PricedDrink>()
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
          eq(eventProducts.eventId, eventId),
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
  }

  for (const line of normalizedTickets) {
    const [tt] = await tx
      .select()
      .from(ticketTypes)
      .where(
        and(
          eq(ticketTypes.id, line.ticketTypeId),
          eq(ticketTypes.tenantId, tenantId),
          eq(ticketTypes.eventId, eventId)
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
  }

  const ticketIds: string[] = []
  for (const line of normalizedTickets) {
    for (let i = 0; i < line.quantity; i++) {
      const { ticket } = await executeTicketPurchase(tx, {
        eventId,
        ticketTypeId: line.ticketTypeId,
        buyerName: contact.name.trim(),
        buyerEmail: contact.email.toLowerCase().trim(),
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
        eventId,
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

  await tx
    .update(sales)
    .set({ status: "COMPLETED" })
    .where(eq(sales.id, saleId))

  return {
    saleId,
    receiptToken: sale.receiptToken,
    ticketIds,
    consumptionIds,
    tenantId,
  }
}
