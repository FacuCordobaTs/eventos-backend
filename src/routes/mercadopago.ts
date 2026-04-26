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
const MP_PLATFORM_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
const ADMIN_URL = process.env.ADMIN_URL || 'https://admin.totem.uno'
const MP_CLIENT_ID = process.env.MP_CLIENT_ID
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET
const MP_REDIRECT_URI = process.env.MP_REDIRECT_URI

function marketplaceFeeFromAmount(amount: number): number {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * MP_MARKETPLACE_FEE_RATE * 100) / 100
}

function parseSaleIdFromExternalReference(externalReference: string): string | null {
  const unified = externalReference.match(/^totem-sale-(\d+)$/)
  if (unified) return unified[1]
  return null
}


export const mercadopagoRoute = new Hono()
  .get("/callback", async (c) => {
    const db = drizzle(pool)
    const code = c.req.query("code")
    const rawState = c.req.query("state") || ''

    const stateParts = rawState.split('_')
    const tenantId = stateParts[0]
    const source = stateParts[1] || 'perfil'
    const basePath = source === 'onboarding' ? '/onboarding' : '/dashboard/perfil'

    if (!code || !tenantId) {
      console.error('❌ MP Callback: Faltan code o state')
      return c.redirect(`${ADMIN_URL}${basePath}?mp_status=error&mp_error=missing_params`)
    }

    if (!MP_CLIENT_ID || !MP_CLIENT_SECRET) {
      console.error('❌ MP Callback: Faltan credenciales de MercadoPago')
      return c.redirect(`${ADMIN_URL}${basePath}?mp_status=error&mp_error=config_error`)
    }

    try {
      const response = await fetch('https://api.mercadopago.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: MP_CLIENT_ID,
          client_secret: MP_CLIENT_SECRET,
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: MP_REDIRECT_URI,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        console.error('❌ MP Callback: Error al intercambiar código con MP:', data)
        return c.redirect(`${ADMIN_URL}${basePath}?mp_status=error&mp_error=oauth_failed`)
      }

      await db.update(tenants).set({
        mpAccessToken: data.access_token,
        mpRefreshToken: data.refresh_token,
      }).where(eq(tenants.id, tenantId))

      console.log(`✅ MP Callback: Productora ${tenantId} vinculada con MercadoPago exitosamente`)

      return c.redirect(`${ADMIN_URL}${basePath}?mp_status=success`)
    } catch (error) {
      console.error('❌ MP Callback: Error al intercambiar código con MP:', error)
      return c.redirect(`${ADMIN_URL}${basePath}?mp_status=error&mp_error=oauth_failed`)
    }
  })
  .get("/status", authMiddleware, async (c) => {
    const ctx = c as unknown as AuthenticatedContext
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
    const db = drizzle(pool)

    try {
      const query = c.req.query()
      let body: any = {}

      try {
       body = await c.req.json()
      } catch (error) {
        
      }

      const paymentId = query['data.id'] || query['id'] || body?.data?.id
      const type = query['type'] || body?.type
      const topic = query['topic'] || body?.topic

      if ((type !== 'payment' && topic !== 'payment') || !paymentId) {
        console.log(`⏭️ [Webhook] Ignorando notificación: type=${type}, topic=${topic}`)
        return c.json({ status: 'ignored' })
      }

      if (!MP_PLATFORM_ACCESS_TOKEN) {
        console.error('❌ [Webhook] Falta MP_ACCESS_TOKEN para consultar pagos')
        return c.json({ status: 'error', message: 'Missing platform token' }, 500)
      }

      const paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          'Authorization': `Bearer ${MP_PLATFORM_ACCESS_TOKEN}`
        }
      })

      if (!paymentResponse.ok) {
        console.error(`❌ [Webhook] Error consultando pago ${paymentId}: ${paymentResponse.status}`)
        return c.json({ status: 'error', message: 'Payment not found' })
      }

      const paymentData = await paymentResponse.json()

      const externalReference = paymentData.external_reference
      const status = paymentData.status

      if (!externalReference || typeof externalReference !== 'string') {
        console.log(`⏭️ [Webhook] Sin external_reference`)
        return c.json({ status: 'ignored' })
      }

      const saleId = parseSaleIdFromExternalReference(externalReference)

      if (saleId == null) {
        console.log(`⏭️ [Webhook] Referencia no es venta TOTEM: ${externalReference}`)
        return c.json({ status: 'ignored' })
      }

      const saleWhere = eq(sales.id, saleId)

      const [sale] = await db.select().from(sales).where(saleWhere).limit(1)
      if (!sale) {
        console.log(`⏭️ [Webhook] Venta no encontrada: ${saleId}`)
        return c.json({ status: 'ignored' })
      }
      if (status === 'approved') {
        if (sale.paid) {
          console.log(`⏭️ [Webhook] Venta ${saleId} ya figuraba como pagada.`)
          return c.json({ status: 'already_processed' })
        }
        if (sale.customerId == null) {
          console.log(`⏭️ [Webhook] Venta ${saleId} no tiene customerId.`)
          return c.json({ status: 'ignored' })
        }
        await db.update(sales).set({ paid: true }).where(saleWhere)

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


    } catch (error) {
      
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