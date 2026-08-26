import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import { drizzle } from "drizzle-orm/mysql2"
import { and, eq } from "drizzle-orm"
import { pool } from "../db"
import { mpProcessedPayments, sales, tenants } from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import {
  enriquecerTenantConUsersMe,
  intercambiarCodigoPorTokens,
  obtenerTokenValido,
} from "../lib/mercadopago-utils"
import { sendGuestCheckoutReceiptEmail } from "../lib/send-checkout-receipt-email"
import { isMysqlDuplicateKey, processMercadoPagoPaymentNotification } from "../lib/mp-webhook"
import { fulfillPendingGuestCheckout } from "../lib/client-checkout"
import { PurchaseError } from "../lib/ticket-purchase"

const MP_MARKETPLACE_FEE_RATE = 0.01
const ADMIN_URL = process.env.ADMIN_URL || 'https://admin.crow.ar'
const MP_CLIENT_ID = process.env.MP_CLIENT_ID
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET
const MP_REDIRECT_URI = process.env.MP_REDIRECT_URI

function marketplaceFeeFromAmount(amount: number): number {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * MP_MARKETPLACE_FEE_RATE * 100) / 100
}

export const mercadopagoRoute = new Hono()
  .get("/callback", async (c) => {
    const code = c.req.query("code")
    const rawState = c.req.query("state") || ""

    const stateParts = rawState.split("_")
    const tenantId = stateParts[0]
    const source = stateParts[1] || "perfil"
    const basePath = source === "onboarding" ? "/onboarding" : "/dashboard/perfil"

    if (!code || !tenantId) {
      console.error("❌ MP Callback: Faltan code o state")
      return c.redirect(
        `${ADMIN_URL}${basePath}?mp_status=error&mp_error=missing_params`
      )
    }

    if (!MP_CLIENT_ID || !MP_CLIENT_SECRET || !MP_REDIRECT_URI) {
      console.error("❌ MP Callback: Faltan credenciales o MP_REDIRECT_URI de MercadoPago")
      return c.redirect(
        `${ADMIN_URL}${basePath}?mp_status=error&mp_error=config_error`
      )
    }

    try {
      const result = await intercambiarCodigoPorTokens({ code, tenantId })
      if (!result) {
        console.error("❌ MP Callback: intercambio de código inválido o vacío")
        return c.redirect(
          `${ADMIN_URL}${basePath}?mp_status=error&mp_error=oauth_failed`
        )
      }
      await enriquecerTenantConUsersMe(tenantId, result.accessToken)

      console.log(
        `✅ MP Callback: Productora ${tenantId} vinculada con MercadoPago exitosamente`
      )

      return c.redirect(`${ADMIN_URL}${basePath}?mp_status=success`)
    } catch (error) {
      console.error("❌ MP Callback: Error al intercambiar código con MP:", error)
      return c.redirect(
        `${ADMIN_URL}${basePath}?mp_status=error&mp_error=oauth_failed`
      )
    }
  })
  .get("/status", authMiddleware, async (c) => {
    const ctx = c as unknown as AuthenticatedContext
    const tenantId = ctx.staff.tenantId
    if (tenantId == null || tenantId === "") {
      console.log('❌ MP Status: Productora no configurada')
      return c.json({
        mpConnected: false,
        mpPublicKey: null as string | null,
        mpUserId: null as string | null,
      })
    }

    const db = drizzle(pool)
    const [row] = await db
      .select({
        mpPublicKey: tenants.mpPublicKey,
        mpUserId: tenants.mpUserId,
        mpAccessToken: tenants.mpAccessToken,
        mpConnected: tenants.mpConnected,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)

    const connected =
      row != null &&
      (row.mpPublicKey != null ||
        (row.mpAccessToken != null && row.mpConnected === true))
    return c.json({
      mpConnected: connected,
      mpPublicKey: row?.mpPublicKey ?? null,
      mpUserId: row?.mpUserId ?? null,
    })
  })
  .post("/disconnect", authMiddleware, async (c) => {
    const ctx = c as unknown as AuthenticatedContext
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

  .post("/webhook", async (c) => {
    try {
      const query = c.req.query() as Record<string, string>
      let body: { data?: { id?: string }; type?: string; topic?: string } = {}

      try {
        body = (await c.req.json()) as typeof body
      } catch {
        // MP sometimes POSTs with empty or non-JSON body
      }

      const paymentId =
        query["data.id"] || query["id"] || body?.data?.id
      const type = query["type"] || body?.type
      const topic = query["topic"] || body?.topic

      const isPayment =
        type === "payment" ||
        topic === "payment" ||
        body?.type === "payment" ||
        body?.topic === "payment"

      if (!isPayment) {
        if (topic === "merchant_order" || type === "merchant_order") {
          return c.json({ status: "ignored", reason: "merchant_order" })
        }
        console.log(
          `⏭️ [Webhook] Ignorando notificación: type=${String(type)}, topic=${String(topic)}`
        )
        return c.json({ status: "ignored" })
      }

      if (!paymentId) {
        console.log("⏭️ [Webhook] Notificación de pago sin id")
        return c.json({ status: "ignored" })
      }

      await processMercadoPagoPaymentNotification(String(paymentId))
      return c.json({ status: "ok" })
    } catch (e) {
      console.error("❌ [Webhook]", e)
      return c.json({ status: "error" }, 500)
    }
  })
  .post("/crear-preferencia-externo", async (c) => {
    const db = drizzle(pool)
    try {
      const { saleId } = await c.req.json()
      if (!saleId) {
        return c.json({ success: false, error: 'saleId es requerido' }, 400)
      }

      const [sale] = await db.select().from(sales).where(eq(sales.id, saleId)).limit(1)
      if (!sale) {
        return c.json({ success: false, error: 'Sale no encontrada' }, 404)
      }
      
      const total = parseFloat(String(sale.totalAmount || '0'))

      const mpAccessToken = await obtenerTokenValido(sale.tenantId)
      if (!mpAccessToken) {
        return c.json({ success: false, error: 'No se pudo validar Mercado Pago para esta productora.' }, 502)
      }

      const mpItems = [{
        title: `Venta #${saleId}`,
        quantity: 1,
        currency_id: 'ARS',
        unit_price: total,
      }]

      const externalReference = `totem-sale-${saleId}`
      
      const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${mpAccessToken}`,
        },
        body: JSON.stringify({
          items: mpItems,
          marketplace_fee: marketplaceFeeFromAmount(total),
          back_urls: {
            success: `https://crow.ar/receipt/${sale.receiptToken}`,
            failure: `https://crow.ar/receipt/${sale.receiptToken}`,
            pending: `https://crow.ar/receipt/${sale.receiptToken}`,
          },
          auto_return: 'approved',
          external_reference: externalReference,
          notification_url: `https://api.crow.ar/api/mp/webhook`,
          statement_descriptor: 'TOTEM',
          expires: true,
          expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        }),
      })

      const preference = await mpResponse.json()
      if (!mpResponse.ok) {
        return c.json({ success: false, error: 'Error al crear preferencia de Mercado Pago' }, 500)
      }

      return c.json({ success: true, url_pago: preference.init_point, preference_id: preference.id, total: total.toFixed(2) })
    } catch (error) {
      console.error("[crear-preferencia-externo]", error)
      return c.json({ success: false, error: 'Error al crear preferencia de Mercado Pago' }, 500)
    }
  })

  .post("/process-brick", async (c) => {
    const db = drizzle(pool)
    try {
      const body = await c.req.json()
      const { token, installments, payer, payment_method_id, issuer_id, receiptToken } = body
      if (!receiptToken) {
        return c.json({ success: false, error: 'receiptToken es requerido' }, 400)
      }

      if (!token || !payer?.email) {
        return c.json({ success: false, error: 'Datos de pago incompletos' }, 400)
      }

      const [sale] = await db.select().from(sales).where(eq(sales.receiptToken, receiptToken)).limit(1)
      if (!sale) {
        return c.json({ success: false, error: 'Sale no encontrada' }, 404)
      }
    
      const mpAccessToken = await obtenerTokenValido(sale.tenantId)
      if (!mpAccessToken) {
        return c.json({ success: false, error: 'No se pudo validar Mercado Pago para esta productora.' }, 502)
      }

      const transactionAmount = parseFloat(String(sale.totalAmount || '0'))
      const applicationFee = marketplaceFeeFromAmount(transactionAmount)
      
      const mpPayload: Record<string, unknown> = {
        transaction_amount: transactionAmount,
        token,
        description: `Venta #${sale.id}`,
        installments,
        payment_method_id,
        payer: {
          email: payer.email,
          identification: payer.identification
        },
        external_reference: `totem-sale-${sale.id}`,
        notification_url: `https://api.crow.ar/api/mp/webhook`
      }
      if (applicationFee > 0) {
        mpPayload.application_fee = applicationFee
      }
      if (issuer_id != null && issuer_id !== '') {
        mpPayload.issuer_id = Number(issuer_id)
      }

      const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${mpAccessToken}`,
          'X-Idempotency-Key': `${sale.id}-${Date.now()}`
        },
        body: JSON.stringify(mpPayload),
      })
      
      const payment = await mpResponse.json()
      if (!mpResponse.ok) {
        return c.json({ success: false, error: 'Error al procesar pago' }, 500)
      }

      if (payment.status === 'approved') {
        // Tarea 2.2 (hallazgo 1.6#5) — un pago de tarjeta aprobado debe CUMPLIR la sale
        // PENDING (emitir tickets/consumos desde el snapshot), igual que hace el webhook MP.
        // Deduplicación idempotente con `mpProcessedPayments`: si el webhook ya lo procesó,
        // este insert falla con ER_DUP_ENTRY y no hacemos nada (y viceversa).
        let skippedAsDuplicate = false
        await db.transaction(async (tx) => {
          try {
            await tx.insert(mpProcessedPayments).values({
              paymentId: String(payment.id),
              saleId: sale.id,
            })
          } catch (e) {
            if (isMysqlDuplicateKey(e)) {
              skippedAsDuplicate = true
              return
            }
            throw e
          }

          const [current] = await tx
            .select()
            .from(sales)
            .where(eq(sales.id, sale.id))
            .limit(1)
          if (!current || current.paid) return

          if (current.status === "PENDING" && current.guestCheckoutSnapshot != null) {
            try {
              await fulfillPendingGuestCheckout(tx, current.id)
            } catch (e) {
              if (e instanceof PurchaseError) {
                await tx
                  .update(sales)
                  .set({ status: "PAYMENT_FAILED" })
                  .where(and(eq(sales.id, current.id), eq(sales.status, "PENDING")))
              } else {
                throw e
              }
            }
          } else {
            // Venta sin snapshot (ej. POS): solo se marca como pagada, como antes.
            await tx
              .update(sales)
              .set({ paid: true, paidAt: new Date() })
              .where(eq(sales.id, current.id))
          }
        })

        if (!skippedAsDuplicate) {
          const [after] = await db
            .select()
            .from(sales)
            .where(eq(sales.id, sale.id))
            .limit(1)

          if (after?.status === "COMPLETED") {
            const snap = after.guestCheckoutSnapshot
            const contact =
              snap && typeof snap === "object" && "contact" in snap
                ? (snap as { contact?: { email?: string; name?: string } }).contact
                : undefined
            if (contact?.email) {
              void sendGuestCheckoutReceiptEmail({
                db,
                eventId: after.eventId,
                saleId: sale.id,
                receiptToken: after.receiptToken,
                contact: {
                  name: contact.name ?? "Cliente",
                  email: contact.email,
                },
              }).catch((err) => {
                console.error("[process-brick] Receipt email failed:", err)
              })
            }
          }
        }
        return c.json({ success: true, status: 'approved' })
      }

      return c.json({ success: true, payment_id: payment.id, status: payment.status })
    } catch (error) {
      // El catch vacío anterior dejaba el request colgado (el Brick quedaba en loading
      // eterno). Tarea 2.2: responder siempre para que el client pueda mostrar el error.
      console.error("[process-brick] Error al procesar el pago:", error)
      return c.json({ success: false, error: "Error al procesar el pago" }, 500)
    }
  })