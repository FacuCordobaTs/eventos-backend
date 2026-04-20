import { Hono } from "hono"
import type { Context } from "hono"
import { drizzle } from "drizzle-orm/mysql2"
import { eq } from "drizzle-orm"
import { pool } from "../db"
import { tenants } from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { intercambiarCodigoPorTokens } from "../lib/mercadopago-utils"
import { processMercadoPagoPaymentNotification } from "../lib/mp-webhook"

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
