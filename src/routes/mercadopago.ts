import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { eq } from "drizzle-orm"
import { pool } from "../db"
import { events, sales, tenants } from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { fulfillPendingGuestCheckout } from "../lib/client-checkout"
import { dec, decFromDb } from "../lib/decimal-money"
import { intercambiarCodigoPorTokens, obtenerTokenValido } from "../lib/mercadopago-utils"
import { processMercadoPagoPaymentNotification } from "../lib/mp-webhook"
import { sendGuestCheckoutReceiptEmail } from "../lib/send-checkout-receipt-email"
import { PurchaseError, purchaseErrorStatus } from "../lib/ticket-purchase"

async function extractMercadoPagoPaymentId(c: Context): Promise<string | null> {
  const qTopic = c.req.query("topic") ?? c.req.query("type")
  const qId = c.req.query("id") ?? c.req.query("data.id")
  if (qTopic === "payment" && qId) {
    return String(qId)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = null
  }
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>
    if (b.type === "payment" && b.data && typeof b.data === "object") {
      const id = (b.data as Record<string, unknown>).id
      if (id != null) return String(id)
    }
    if (b.topic === "payment" && b.data && typeof b.data === "object") {
      const id = (b.data as Record<string, unknown>).id
      if (id != null) return String(id)
    }
    if (b.action && b.data && typeof b.data === "object") {
      const id = (b.data as Record<string, unknown>).id
      if (id != null && String(b.action).includes("payment")) {
        return String(id)
      }
    }
  }
  return qId ? String(qId) : null
}

function adminUrl(): string {
  const u = process.env.ADMIN_URL
  if (!u) throw new Error("ADMIN_URL no configurado")
  return u.replace(/\/$/, "")
}

const processBrickSchema = z.object({
  token: z.string().min(1),
  installments: z.number().int().min(1).max(48),
  payer: z.record(z.string(), z.any()),
  payment_method_id: z.string().min(1),
  issuer_id: z.union([z.string(), z.number()]).optional(),
  receiptToken: z.string().min(1),
})

type MpPaymentCreateResponse = {
  id?: number | string
  status?: string
  status_detail?: string
  transaction_amount?: number
  message?: string
  cause?: unknown
}

export const mercadopagoRoute = new Hono()
  .get("/callback", async (c) => {
    const code = c.req.query("code")
    const state = c.req.query("state")
    const base = adminUrl()

    if (!code || !state) {
      return c.redirect(`${base}/settings?tab=finances&mp_status=error`, 302)
    }

    try {
      const ok = await intercambiarCodigoPorTokens({
        code,
        tenantId: state,
      })
      if (!ok) {
        return c.redirect(`${base}/settings?tab=finances&mp_status=error`, 302)
      }
      return c.redirect(`${base}/settings?tab=finances&mp_status=success`, 302)
    } catch {
      return c.redirect(`${base}/settings?tab=finances&mp_status=error`, 302)
    }
  })
  .get("/status", authMiddleware, async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = ctx.staff.tenantId
    if (tenantId == null || tenantId === "") {
      return c.json({
        mpConnected: false,
        mpPublicKey: null as string | null,
        mpUserId: null as string | null,
      })
    }

    const db = drizzle(pool)
    const [row] = await db
      .select({
        mpConnected: tenants.mpConnected,
        mpPublicKey: tenants.mpPublicKey,
        mpUserId: tenants.mpUserId,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)

    return c.json({
      mpConnected: row?.mpConnected ?? false,
      mpPublicKey: row?.mpPublicKey ?? null,
      mpUserId: row?.mpUserId ?? null,
    })
  })
  .post("/disconnect", authMiddleware, async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = ctx.staff.tenantId
    if (tenantId == null || tenantId === "") {
      return c.json({ error: "Productora no configurada" }, 400)
    }

    const db = drizzle(pool)
    await db
      .update(tenants)
      .set({
        mpAccessToken: null,
        mpRefreshToken: null,
        mpPublicKey: null,
        mpUserId: null,
        mpConnected: false,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, tenantId))

    return c.json({ ok: true })
  })
  .post("/process-brick", zValidator("json", processBrickSchema), async (c) => {
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const [row] = await db
      .select({ sale: sales })
      .from(sales)
      .innerJoin(events, eq(sales.eventId, events.id))
      .innerJoin(tenants, eq(sales.tenantId, tenants.id))
      .where(eq(sales.receiptToken, body.receiptToken))
      .limit(1)

    if (!row) {
      return c.json({ error: "Venta no encontrada" }, 404)
    }

    if (
      row.sale.status !== "PENDING" ||
      (row.sale.paymentMethod !== "MERCADOPAGO" &&
        row.sale.paymentMethod !== "CARD")
    ) {
      return c.json(
        { error: "La venta no está pendiente de pago con Mercado Pago." },
        400
      )
    }

    const mpAccessToken = await obtenerTokenValido(row.sale.tenantId)
    if (!mpAccessToken) {
      return c.json(
        { error: "No se pudo validar Mercado Pago para esta productora." },
        502
      )
    }

    const transactionAmount = decFromDb(row.sale.totalAmount).toNumber()

    const paymentBody: Record<string, unknown> = {
      transaction_amount: transactionAmount,
      token: body.token,
      description: "Compra en Totem",
      installments: body.installments,
      payment_method_id: body.payment_method_id,
      payer: body.payer,
      external_reference: `totem-sale-${row.sale.id}`,
      currency_id: "ARS",
    }
    if (body.issuer_id !== undefined && body.issuer_id !== "") {
      paymentBody.issuer_id = String(body.issuer_id)
    }

    const idempotencyKey = `${row.sale.id}-${Date.now()}`

    const mpRes = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${mpAccessToken}`,
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(paymentBody),
    })

    let paymentData: MpPaymentCreateResponse
    try {
      paymentData = (await mpRes.json()) as MpPaymentCreateResponse
    } catch {
      return c.json(
        { success: false, status: "rejected", message: "Respuesta inválida de Mercado Pago" },
        502
      )
    }

    if (!mpRes.ok) {
      const msg =
        typeof paymentData.message === "string"
          ? paymentData.message
          : typeof paymentData.status_detail === "string"
            ? paymentData.status_detail
            : `Error ${mpRes.status}`
      return c.json(
        {
          success: false,
          status: "rejected",
          message: msg,
        },
        400
      )
    }

    const paid = dec(String(paymentData.transaction_amount ?? 0))
    const expected = decFromDb(row.sale.totalAmount)
    if (!paid.eq(expected)) {
      return c.json({
        success: false,
        status: "rejected",
        message: "El monto del pago no coincide con la venta.",
      })
    }

    const st = (paymentData.status ?? "").toLowerCase()

    if (st === "in_process" || st === "pending") {
      return c.json({ success: true, status: "pending" as const })
    }

    if (st === "approved") {
      try {
        const out = await db.transaction(async (tx) => {
          return fulfillPendingGuestCheckout(tx, row.sale.id)
        })

        const snap = row.sale.guestCheckoutSnapshot
        const contact =
          snap && typeof snap === "object" && "contact" in snap
            ? (snap as { contact?: { email?: string; name?: string } }).contact
            : undefined
        if (contact?.email) {
          void sendGuestCheckoutReceiptEmail({
            db,
            eventId: row.sale.eventId,
            saleId: row.sale.id,
            receiptToken: out.receiptToken,
            contact: {
              name: contact.name ?? "Cliente",
              email: contact.email,
            },
          }).catch((err) => {
            console.error("[process-brick] Receipt email failed:", err)
          })
        }

        return c.json({ success: true, status: "approved" as const })
      } catch (e) {
        if (e instanceof PurchaseError) {
          const { body: errBody } = purchaseErrorStatus(e.code)
          return c.json(
            {
              success: false,
              status: "rejected",
              message: errBody.error,
            },
            409
          )
        }
        console.error("[process-brick] fulfill failed:", e)
        return c.json(
          { success: false, status: "rejected", message: "No se pudo completar la venta." },
          500
        )
      }
    }

    return c.json({
      success: false,
      status: "rejected" as const,
      message: paymentData.status_detail ?? st ?? "Pago no aprobado",
    })
  })
  .post("/webhook", async (c) => {
    const paymentId = await extractMercadoPagoPaymentId(c)
    if (!paymentId) {
      return c.text("OK", 200)
    }
    try {
      await processMercadoPagoPaymentNotification(paymentId)
    } catch (e) {
      console.error("[mp-webhook]", e)
      return c.text("Error", 500)
    }
    return c.text("OK", 200)
  })
