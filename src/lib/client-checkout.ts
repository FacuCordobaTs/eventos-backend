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
import { debitBalance, fulfillPendingBalanceDeposit, getBalance } from "./balance"

type Tx = MySql2Transaction<typeof schema, typeof schema>

export type ClientCheckoutTicketLine = { ticketTypeId: string; quantity: number }
export type ClientCheckoutDrinkLine = { productId: string; quantity: number }

export type ClientCheckoutContact = {
  name: string
  /** Email. Vacío ("") = desconocido (venta de caja en POS, tarea 5.1): no se pisa el email
   * real de un cliente existente y los nuevos se crean con un email sintético. */
  email: string
  phone: string
  /** Tarea 1.1 — DNI del comprador (identidad dentro del evento). Opcional: hoy no se pide en el checkout; lo manda F2. */
  dni?: string
  /** Fecha de nacimiento conocida (ej. parseada del código de barras en puerta). Opcional por ahora — el +18 es en puerta. */
  birthDate?: Date | null
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
  /** Tarea 6.1 — Saldo resultante tras pagar con saldo (solo cuando `paymentMethod === "SALDO"`). */
  balance?: string
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

/**
 * Tarea 1.1 + 5.1 — Resuelve (upsert) el customer por DNI primero, luego por email/teléfono.
 * El DNI es la identidad del cliente dentro del evento (una persona = un cliente,
 * `customers.dni` único global). Exportado para la venta de caja del POS (5.1).
 */
export async function findOrCreateCustomer(
  tx: Tx,
  contact: ClientCheckoutContact
): Promise<string> {
  const name = contact.name.trim()
  const email = contact.email.toLowerCase().trim()
  const phone = contact.phone.trim()
  // Tarea 1.1 — El DNI es la identidad del cliente dentro del evento: si viene, manda por
  // encima de email/teléfono (una persona = un cliente, `customers.dni` único global).
  const dni = contact.dni?.trim() || null
  const birthDate = contact.birthDate ?? null

  if (dni !== null) {
    const [byDni] = await tx
      .select()
      .from(customers)
      .where(eq(customers.dni, dni))
      .limit(1)

    if (byDni) {
      await tx
        .update(customers)
        .set({
          name,
          // Tarea 5.1 — Email vacío = no se conoce (caja): no pisar el email real.
          ...(email !== "" ? { email } : {}),
          phone: phone || byDni.phone,
          ...(birthDate !== null ? { birthDate } : {}),
        })
        .where(eq(customers.id, byDni.id))
      return byDni.id
    }
  }

  if (email !== "") {
    const [byEmail] = await tx
      .select()
      .from(customers)
      .where(eq(customers.email, email))
      .limit(1)

    if (byEmail) {
      // Si acá llegamos, ningún cliente tiene ese DNI (el lookup por dni falló arriba), así que
      // solo se asigna a un cliente cuyo dni esté libre — si el cliente ya tiene OTRO dni, el
      // email estaría en disputa entre dos personas y el unique key de `customers.dni` no se
      // toca (se prefiere la identidad ya registrada).
      const canClaimDni = dni === null || byEmail.dni == null || byEmail.dni === dni
      await tx
        .update(customers)
        .set({
          name,
          phone: phone || byEmail.phone,
          ...(canClaimDni ? { dni } : {}),
          ...(birthDate !== null ? { birthDate } : {}),
        })
        .where(eq(customers.id, byEmail.id))
      return byEmail.id
    }
  }

  if (phone !== "") {
    const [byPhone] = await tx
      .select()
      .from(customers)
      .where(eq(customers.phone, phone))
      .limit(1)
    if (byPhone) {
      const canClaimDni = dni === null || byPhone.dni == null || byPhone.dni === dni
      await tx
        .update(customers)
        .set({
          name,
          ...(email !== "" ? { email } : {}),
          ...(canClaimDni ? { dni } : {}),
          ...(birthDate !== null ? { birthDate } : {}),
        })
        .where(eq(customers.id, byPhone.id))
      return byPhone.id
    }
  }

  const id = uuidv4()
  await tx.insert(customers).values({
    id,
    name,
    // Tarea 5.1 — Sin email (caja POS): email sintético determinístico por DNI (o id).
    // El checkout web posterior (por DNI) lo reemplaza por el email real.
    email: email !== "" ? email : `pos-${dni ?? id}@crow.local`,
    phone: phone || null,
    ...(dni !== null ? { dni } : {}),
    ...(birthDate !== null ? { birthDate } : {}),
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
  // Tarea 11.3 — `isActive` retirado: el evento no disponible es el cerrado.
  if (ev.status === "closed") {
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

  // Tarea 6.1 — Pago con saldo (visión §2.7): el saldo está atado al DNI (identidad dentro del
  // evento) — sin DNI no hay saldo que gastar. El débito se hace tras insertar la sale, porque
  // el movimiento lo referencia. Si no alcanza, la compra no avanza.
  if (params.paymentMethod === "SALDO") {
    const dni = params.contact.dni?.trim()
    if (!dni) {
      throw new PurchaseError("BALANCE_REQUIRES_DNI")
    }
    const balance = dec(await getBalance(tx, prep.customerId, params.eventId))
    if (balance.lt(prep.total)) {
      throw new PurchaseError("INSUFFICIENT_BALANCE")
    }
  }

  if (
    params.paymentMethod === "MERCADOPAGO" ||
    params.paymentMethod === "CARD" ||
    params.paymentMethod === "TRANSFER"
  ) {
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
        ...(params.contact.dni?.trim() ? { dni: params.contact.dni.trim() } : {}),
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
      payOnReceipt: method === "CARD" || method === "TRANSFER",
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
        buyerDni: params.contact.dni?.trim() || null,
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

  // Tarea 6.1 — El saldo se descuenta recién acá: la venta ya existe (el movimiento de CONSUMO
  // la referencia) y el saldo se chequeó arriba (BALANCE_REQUIRES_DNI / INSUFFICIENT_BALANCE).
  let balanceAfter: string | null = null
  if (params.paymentMethod === "SALDO") {
    balanceAfter = await debitBalance(tx, {
      customerId: prep.customerId,
      eventId: params.eventId,
      tenantId: prep.tenantId,
      amount: prep.serverTotalStr,
      saleId,
      note: "Compra con saldo",
    })
  }

  return {
    saleId,
    receiptToken,
    ticketIds,
    consumptionIds,
    tenantId: prep.tenantId,
    ...(balanceAfter != null ? { balance: balanceAfter } : {}),
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
    (sale.paymentMethod !== "MERCADOPAGO" &&
      sale.paymentMethod !== "CARD" &&
      sale.paymentMethod !== "TRANSFER")
  ) {
    throw new Error("FULFILL_INVALID_SALE_STATE")
  }

  const snap = sale.guestCheckoutSnapshot
  if (snap == null) {
    throw new Error("FULFILL_NO_SNAPSHOT")
  }

  // Tarea 6.1 — Depósito de saldo (visión §2.7): una sale de carga de saldo se cumple
  // acreditando `customer_balances`, no emitiendo tickets/consumos. El webhook despacha por
  // `snapshot.kind` (mismo camino que el checkout: misma transacción, misma dedupe).
  if (snap.kind === "deposit") {
    const dep = await fulfillPendingBalanceDeposit(tx, saleId)
    return { ...dep, ticketIds: [], consumptionIds: [] }
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
    ...(snap.contact.dni != null && snap.contact.dni !== "" ? { dni: snap.contact.dni } : {}),
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
        buyerDni: contact.dni?.trim() || null,
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
    .set({
      status: "COMPLETED",
      paid: true,
      paidAt: new Date(),
    })
    .where(eq(sales.id, saleId))

  return {
    saleId,
    receiptToken: sale.receiptToken,
    ticketIds,
    consumptionIds,
    tenantId,
  }
}
