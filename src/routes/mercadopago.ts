import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import { drizzle } from "drizzle-orm/mysql2"
import { eq } from "drizzle-orm"
import { pool } from "../db"
import { sales, tenants, customers } from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { intercambiarCodigoPorTokens, obtenerTokenValido } from "../lib/mercadopago-utils"
import { sendGuestCheckoutReceiptEmail } from "../lib/send-checkout-receipt-email"

const MP_MARKETPLACE_FEE_RATE = 0.01;

function marketplaceFeeFromAmount(amount: number): number {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * MP_MARKETPLACE_FEE_RATE * 100) / 100
}

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
            success: `https://totem.uno/receipt/${sale.receiptToken}`,
            failure: `https://totem.uno/receipt/${sale.receiptToken}`,
            pending: `https://totem.uno/receipt/${sale.receiptToken}`,
          },
          auto_return: 'approved',
          external_reference: externalReference,
          notification_url: `https://api.totem.uno/api/mp/webhook`,
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
        notification_url: `https://api.totem.uno/api/mp/webhook`
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
        await db.update(sales).set({ paid: true }).where(eq(sales.id, sale.id))
          
        if (sale.customerId) {  
        const customer = await db.select().from(customers).where(eq(customers.id, sale.customerId)).limit(1)
          await sendGuestCheckoutReceiptEmail({
            db,
            eventId: sale.eventId,
            saleId: sale.id,
            receiptToken: sale.receiptToken,
            contact: {
              name: customer[0].name,
              email: customer[0].email,
            },
          })
        }
        return c.json({ success: true, status: 'approved' })
      }

      return c.json({ success: true, payment_id: payment.id, status: payment.status })
    } catch (error) {
      
    }
  })