import { and, eq, gte, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { mpProcessedPayments, sales } from "../db/schema"
import { fulfillPendingGuestCheckout } from "./client-checkout"
import { dec, decFromDb } from "./decimal-money"
import {
  mpGetPayment,
  mpSearchPaymentsByExternalReference,
  type MpPaymentResource,
} from "./mp-checkout-api"
import { obtenerTokenValido } from "./mercadopago-utils"
import { sendGuestCheckoutReceiptEmail } from "./send-checkout-receipt-email"
import { broadcastReceiptUpdate } from "./public-qr-broadcast"
import { PurchaseError } from "./ticket-purchase"

export const MP_EXTERNAL_REF_PREFIX = "totem-sale-"

/** ER_DUP_ENTRY / errno 1062 — usado por webhook y process-brick para deduplicar notificaciones. */
export function isMysqlDuplicateKey(e: unknown): boolean {
  if (e == null || typeof e !== "object") return false
  const err = e as { code?: string; errno?: number }
  return err.code === "ER_DUP_ENTRY" || err.errno === 1062
}

export function parseSaleIdFromExternalReference(
  ref: string | null | undefined
): string | null {
  if (ref == null || ref === "") return null
  if (!ref.startsWith(MP_EXTERNAL_REF_PREFIX)) return null
  const id = ref.slice(MP_EXTERNAL_REF_PREFIX.length).trim()
  return id.length > 0 ? id : null
}

export async function resolveMercadoPagoPayment(
  paymentId: string
): Promise<{ payment: MpPaymentResource; tenantId: string; accessToken: string } | null> {
  const db = drizzle(pool)
  const since = new Date(Date.now() - 7 * 864e5)

  const tenantRows = await db
    .selectDistinct({ tenantId: sales.tenantId })
    .from(sales)
    .where(
      and(
        eq(sales.status, "PENDING"),
        inArray(sales.paymentMethod, ["MERCADOPAGO", "CARD"]),
        gte(sales.createdAt, since)
      )
    )

  const seen = new Set<string>()
  for (const row of tenantRows) {
    const tid = row.tenantId
    if (seen.has(tid)) continue
    seen.add(tid)

    const accessToken = await obtenerTokenValido(tid)
    if (!accessToken) continue

    const payment = await mpGetPayment(accessToken, paymentId)
    if (!payment || String(payment.id) !== String(paymentId)) continue

    return { payment, tenantId: tid, accessToken }
  }

  return null
}

export async function processMercadoPagoPaymentNotification(
  paymentId: string
): Promise<void> {
  const resolved = await resolveMercadoPagoPayment(paymentId)
  if (!resolved) {
    console.warn("[mp-webhook] Could not resolve payment", paymentId)
    return
  }

  const verified = await mpGetPayment(resolved.accessToken, paymentId)
  if (!verified || String(verified.id) !== String(paymentId)) {
    console.warn("[mp-webhook] Payment verification failed", paymentId)
    return
  }

  await applyVerifiedMercadoPagoPayment(verified, resolved.tenantId)
}

/**
 * Aplica un pago ya leído de la API de Mercado Pago con la credencial del tenant. Lo usan el
 * webhook y la confirmación activa del comprobante: el cobro sale siempre de Mercado Pago, nunca
 * de lo que diga el navegador, y `mpProcessedPayments` hace que dos caminos no lo apliquen dos veces.
 */
async function applyVerifiedMercadoPagoPayment(
  verified: MpPaymentResource,
  tenantId: string
): Promise<void> {
  const paymentId = String(verified.id)
  const saleId = parseSaleIdFromExternalReference(verified.external_reference ?? undefined)
  if (!saleId) {
    console.warn("[mp-webhook] Missing external_reference", paymentId)
    return
  }

  const db = drizzle(pool)
  const [sale] = await db.select().from(sales).where(eq(sales.id, saleId)).limit(1)
  if (!sale) {
    console.warn("[mp-webhook] Sale not found", saleId)
    return
  }
  if (sale.tenantId !== tenantId) {
    console.warn("[mp-webhook] Tenant mismatch for sale", saleId)
    return
  }

  const expected = decFromDb(sale.totalAmount)
  const paid = dec(String(verified.transaction_amount ?? 0))
  if (!paid.eq(expected)) {
    console.warn("[mp-webhook] Amount mismatch", saleId, paid.toString(), expected.toString())
    try {
      await db.insert(mpProcessedPayments).values({
        paymentId: String(paymentId),
        saleId,
      })
    } catch (e) {
      if (!isMysqlDuplicateKey(e)) {
        throw e
      }
    }
    await db
      .update(sales)
      .set({ status: "PAYMENT_FAILED" })
      .where(and(eq(sales.id, saleId), eq(sales.status, "PENDING")))
    return
  }

  const status = (verified.status ?? "").toLowerCase()

  const terminalRejected =
    status === "rejected" ||
    status === "cancelled" ||
    status === "refunded" ||
    status === "charged_back"

  if (status !== "approved" && !terminalRejected) {
    return
  }

  // Checkout Pro deja reintentar con otro medio sobre la misma preferencia: un rechazo no cierra la
  // venta, porque el pago siguiente puede aprobarse y tiene que encontrarla todavía PENDING.
  const retriableRejection =
    sale.paymentMethod === "MERCADOPAGO" && (status === "rejected" || status === "cancelled")

  const db2 = drizzle(pool)
  let skippedProcessedDuplicate = false
  await db2.transaction(async (tx) => {
    try {
      await tx.insert(mpProcessedPayments).values({
        paymentId: String(paymentId),
        saleId,
      })
    } catch (e) {
      if (isMysqlDuplicateKey(e)) {
        skippedProcessedDuplicate = true
        return
      }
      throw e
    }

    if (retriableRejection) return

    if (terminalRejected) {
      await tx
        .update(sales)
        .set({ status: "PAYMENT_FAILED" })
        .where(and(eq(sales.id, saleId), eq(sales.status, "PENDING")))
      return
    }

    try {
      await fulfillPendingGuestCheckout(tx, saleId)
    } catch (e) {
      if (e instanceof PurchaseError) {
        await tx
          .update(sales)
          .set({ status: "PAYMENT_FAILED" })
          .where(and(eq(sales.id, saleId), eq(sales.status, "PENDING")))
      } else {
        throw e
      }
    }
  })

  if (skippedProcessedDuplicate) {
    return
  }

  if (status !== "approved") {
    return
  }

  const [after] = await db2.select().from(sales).where(eq(sales.id, saleId)).limit(1)
  if (after?.status !== "COMPLETED") {
    return
  }

  broadcastReceiptUpdate(after.receiptToken)

  const snap = after.guestCheckoutSnapshot
  const contact =
    snap && typeof snap === "object" && "contact" in snap
      ? (snap as { contact?: { email?: string; name?: string } }).contact
      : undefined

  if (contact?.email) {
    void sendGuestCheckoutReceiptEmail({
      db: drizzle(pool),
      eventId: after.eventId,
      saleId,
      receiptToken: after.receiptToken,
      contact: {
        name: contact.name ?? "Cliente",
        email: contact.email,
      },
    }).catch((err) => {
      console.error("[mp-webhook] Receipt email failed:", err)
    })
  }
}

/**
 * Confirmación activa de una venta de Mercado Pago: si el cliente ya pagó y el webhook todavía no
 * llegó, busca el pago en Mercado Pago y lo aplica por el mismo camino. Devuelve si la venta quedó
 * cobrada. Es lo que hace que volver de Mercado Pago muestre el retiro sin esperar la notificación.
 */
export async function syncMercadoPagoSalePayment(sale: {
  id: string
  tenantId: string
}): Promise<boolean> {
  const accessToken = await obtenerTokenValido(sale.tenantId)
  if (!accessToken) return false

  const payments = await mpSearchPaymentsByExternalReference(
    accessToken,
    `${MP_EXTERNAL_REF_PREFIX}${sale.id}`
  )
  const approved = payments.find((payment) => (payment.status ?? "").toLowerCase() === "approved")
  if (!approved) return false

  await applyVerifiedMercadoPagoPayment(approved, sale.tenantId)
  const [after] = await drizzle(pool)
    .select({ status: sales.status })
    .from(sales)
    .where(eq(sales.id, sale.id))
    .limit(1)
  return after?.status === "COMPLETED"
}
