import { and, eq, sql } from "drizzle-orm"
import type { MySql2Transaction } from "drizzle-orm/mysql2"
import type { drizzle } from "drizzle-orm/mysql2"
import * as schema from "../db/schema"
import { balanceMovements, customerBalances, sales } from "../db/schema"
import { v4 as uuidv4 } from "uuid"
import { dec, decFromDb, decToDb } from "./decimal-money"

type Tx = MySql2Transaction<typeof schema, typeof schema>
type Db = ReturnType<typeof drizzle>

/** Origen de un movimiento de saldo (visión §2.7). WEB = carga desde el celular (webhook
 * acreditado); CAJA = carga en efectivo/tarjeta en la caja física; REGALO = cortesía de la
 * productora; CONSUMO = gasto al pagar con saldo. */
export type BalanceMovementType = "WEB" | "CAJA" | "REGALO" | "CONSUMO"

export type BalanceMovementPaymentMethod =
  | "CASH"
  | "CARD"
  | "MERCADOPAGO"
  | "TRANSFER"
  | "SALDO"

export class BalanceError extends Error {
  readonly code: "BALANCE_INSUFFICIENT"

  constructor(code: "BALANCE_INSUFFICIENT") {
    super(code)
    this.name = "BalanceError"
    this.code = code
  }
}

export type CreditBalanceInput = {
  customerId: string
  eventId: string
  tenantId: string
  /** Monto a acreditar, string decimal (ej. "1000.00"). Debe ser > 0. */
  amount: string
  type: BalanceMovementType
  /** Medio de la carga (null en REGALO: no entra plata). */
  paymentMethod?: BalanceMovementPaymentMethod | null
  staffId?: string | null
  saleId?: string | null
  note?: string | null
}

export type DebitBalanceInput = {
  customerId: string
  eventId: string
  tenantId: string
  /** Monto a debitar, string decimal (ej. "1000.00"). Debe ser > 0. */
  amount: string
  note?: string | null
  staffId?: string | null
  saleId?: string | null
}

/** Saldo vigente del cliente en el evento (string decimal, "0.00" si nunca cargó). */
export async function getBalance(
  db: Db | Tx,
  customerId: string,
  eventId: string
): Promise<string> {
  const [row] = await db
    .select({ amount: customerBalances.amount })
    .from(customerBalances)
    .where(
      and(
        eq(customerBalances.customerId, customerId),
        eq(customerBalances.eventId, eventId)
      )
    )
    .limit(1)
  return decToDb(decFromDb(row?.amount))
}

/**
 * Acredita saldo a un cliente en un evento: upsert de `customer_balances` (único por
 * customer+evento) + registro del movimiento. Devuelve el saldo resultante.
 */
export async function creditBalance(tx: Tx, input: CreditBalanceInput): Promise<string> {
  const amt = dec(input.amount)
  if (amt.isNaN() || !amt.isFinite() || amt.lte(0)) {
    throw new Error("BALANCE_AMOUNT_MUST_BE_POSITIVE")
  }
  const amountStr = decToDb(amt)

  await tx
    .insert(customerBalances)
    .values({
      id: uuidv4(),
      customerId: input.customerId,
      eventId: input.eventId,
      tenantId: input.tenantId,
      amount: amountStr,
    })
    .onDuplicateKeyUpdate({
      set: { amount: sql`${customerBalances.amount} + ${amountStr}` },
    })

  await tx.insert(balanceMovements).values({
    id: uuidv4(),
    customerId: input.customerId,
    eventId: input.eventId,
    tenantId: input.tenantId,
    type: input.type,
    paymentMethod: input.paymentMethod ?? null,
    amount: amountStr,
    staffId: input.staffId ?? null,
    saleId: input.saleId ?? null,
    note: input.note ?? null,
    createdAt: new Date(),
  })

  const [after] = await tx
    .select({ amount: customerBalances.amount })
    .from(customerBalances)
    .where(
      and(
        eq(customerBalances.customerId, input.customerId),
        eq(customerBalances.eventId, input.eventId)
      )
    )
    .limit(1)
  return decToDb(decFromDb(after?.amount))
}

/**
 * Debita saldo al pagar (CONSUMO): valida que alcance y actualiza `customer_balances` +
 * registro del movimiento. Lanza `BalanceError` ("BALANCE_INSUFFICIENT") si no alcanza.
 * Devuelve el saldo resultante.
 */
export async function debitBalance(tx: Tx, input: DebitBalanceInput): Promise<string> {
  const amt = dec(input.amount)
  if (amt.isNaN() || !amt.isFinite() || amt.lte(0)) {
    throw new Error("BALANCE_AMOUNT_MUST_BE_POSITIVE")
  }
  const amountStr = decToDb(amt)

  const [row] = await tx
    .select()
    .from(customerBalances)
    .where(
      and(
        eq(customerBalances.customerId, input.customerId),
        eq(customerBalances.eventId, input.eventId)
      )
    )
    .limit(1)

  const current = decFromDb(row?.amount)
  if (current.lt(amt)) {
    throw new BalanceError("BALANCE_INSUFFICIENT")
  }
  if (!row) {
    throw new BalanceError("BALANCE_INSUFFICIENT")
  }

  const next = current.minus(amt)
  await tx
    .update(customerBalances)
    .set({ amount: decToDb(next) })
    .where(eq(customerBalances.id, row.id))

  await tx.insert(balanceMovements).values({
    id: uuidv4(),
    customerId: input.customerId,
    eventId: input.eventId,
    tenantId: input.tenantId,
    type: "CONSUMO",
    paymentMethod: "SALDO",
    amount: amountStr,
    staffId: input.staffId ?? null,
    saleId: input.saleId ?? null,
    note: input.note ?? null,
    createdAt: new Date(),
  })

  return decToDb(next)
}

export type FulfilledBalanceDeposit = {
  saleId: string
  receiptToken: string
  tenantId: string
}

/**
 * Tarea 6.1 — Cumple una venta PENDING de CARGA DE SALDO (snapshot `kind: "deposit"`, visión
 * §2.7): acredita `customer_balances` con el monto de la sale y la marca COMPLETED + paid.
 * Es el análogo de `fulfillPendingGuestCheckout` (que emite tickets/consumos) — el webhook
 * despacha por `snapshot.kind`. Idempotente: una sale ya COMPLETED devuelve el resultado
 * sin acreditar de nuevo.
 */
export async function fulfillPendingBalanceDeposit(
  tx: Tx,
  saleId: string
): Promise<FulfilledBalanceDeposit> {
  const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).limit(1)
  if (!sale) {
    throw new Error("FULFILL_SALE_NOT_FOUND")
  }
  if (sale.status === "COMPLETED") {
    return { saleId: sale.id, receiptToken: sale.receiptToken, tenantId: sale.tenantId }
  }
  if (sale.status !== "PENDING" || sale.customerId == null || sale.customerId === "") {
    throw new Error("FULFILL_INVALID_SALE_STATE")
  }
  const snap = sale.guestCheckoutSnapshot
  if (snap == null || snap.kind !== "deposit") {
    throw new Error("FULFILL_NOT_A_DEPOSIT")
  }

  await creditBalance(tx, {
    customerId: sale.customerId,
    eventId: sale.eventId,
    tenantId: sale.tenantId,
    amount: decToDb(decFromDb(sale.totalAmount)),
    type: "WEB",
    paymentMethod: sale.paymentMethod,
    saleId: sale.id,
    note: "Carga de saldo desde el celular",
  })

  await tx
    .update(sales)
    .set({ status: "COMPLETED", paid: true, paidAt: new Date() })
    .where(eq(sales.id, saleId))

  return { saleId: sale.id, receiptToken: sale.receiptToken, tenantId: sale.tenantId }
}
