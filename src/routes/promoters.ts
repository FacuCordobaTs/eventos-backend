import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { and, asc, eq } from "drizzle-orm"
import { pool } from "../db"
import { promoters } from "../db/schema"
import { v4 as uuidv4 } from "uuid"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"

// Tarea 9.1 — Promotores (visión §2.8): la productora da de alta a las personas que venden
// entradas a comisión, y cada venta (manual de entradas o caja POS) puede atribuírseles con
// `sales.promoter_id` / `tickets.promoter_id`. A nivel TENANT: un promotor trabaja en todos
// los eventos de la productora. El borrado es blando (`isActive = false`): las ventas
// históricas siguen referenciándolos (FK), y el reporte 9.2 agrupa por estas columnas.

const createPromoterSchema = z.object({
  name: z.string().min(1).max(255),
  phone: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.string().max(32).optional()
  ),
})

const updatePromoterSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  phone: z.preprocess(
    (v) => (v === null || v === "" ? undefined : v),
    z.string().max(32).optional()
  ),
  isActive: z.boolean().optional(),
})

function requireTenantId(ctx: AuthenticatedContext): string | null {
  const id = ctx.staff.tenantId
  if (id == null || id === "") return null
  return id
}

// Una sola instanciación del genérico eq() reusada en todos los where del archivo: el tipo de
// columna de `promoters` (referenciada desde tickets/sales) es pesado y TS rompe la inferencia
// si eq() se instancia en cada uso ("No overload matches this call").
const promoterMatch = (id: string, tenantId: string) =>
  and(eq(promoters.id, id), eq(promoters.tenantId, tenantId))

// Mismo criterio que el ABM de Equipo: solo ADMIN/MANAGER escriben.
function canManage(ctx: AuthenticatedContext): boolean {
  return ctx.staff.role === "ADMIN" || ctx.staff.role === "MANAGER"
}

function sanitizePromoter(row: typeof promoters.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    isActive: row.isActive !== false,
    createdAt: row.createdAt,
  }
}

export const promotersRoute = new Hono()
  .get("/", authMiddleware, async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }

    const db = drizzle(pool)
    const rows = await db
      .select()
      .from(promoters)
      .where(eq(promoters.tenantId, tenantId))
      .orderBy(asc(promoters.name))

    return c.json({ promoters: rows.map(sanitizePromoter) })
  })
  .post("/", authMiddleware, zValidator("json", createPromoterSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    if (!canManage(ctx)) {
      return c.json({ error: "Solo administradores y managers pueden administrar promotores." }, 403)
    }
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const id = uuidv4()
    await db.insert(promoters).values({
      id,
      tenantId,
      name: body.name.trim(),
      ...(body.phone !== undefined ? { phone: body.phone.trim() } : {}),
      isActive: true,
      createdAt: new Date(),
    })

    const [row] = await db
      .select()
      .from(promoters)
      .where(and(eq(promoters.id, id), eq(promoters.tenantId, tenantId)))
      .limit(1)

    return c.json({ promoter: row ? sanitizePromoter(row) : null }, 201)
  })
  .patch("/:id", authMiddleware, zValidator("json", updatePromoterSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    if (!canManage(ctx)) {
      return c.json({ error: "Solo administradores y managers pueden administrar promotores." }, 403)
    }
    const promoterId = c.req.param("id")
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const [row] = await db
      .select()
      .from(promoters)
      .where(promoterMatch(promoterId, tenantId))
      .limit(1)
    if (!row) {
      return c.json({ error: "Promotor no encontrado" }, 404)
    }

    await db
      .update(promoters)
      .set({
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.phone !== undefined ? { phone: body.phone.trim() } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      })
      .where(promoterMatch(promoterId, tenantId))

    const [updated] = await db
      .select()
      .from(promoters)
      .where(promoterMatch(promoterId, tenantId))
      .limit(1)

    return c.json({ promoter: updated ? sanitizePromoter(updated) : null })
  })
  .delete("/:id", authMiddleware, async (c) => {
    // Soft delete: desactiva el promotor (las ventas históricas lo siguen referenciando).
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene tenant asignado." }, 400)
    }
    if (!canManage(ctx)) {
      return c.json({ error: "Solo administradores y managers pueden administrar promotores." }, 403)
    }
    // El contexto de .delete() no está tipado por zValidator: param("id") es string | undefined.
    const promoterId = c.req.param("id") ?? "" 
    const db = drizzle(pool)

    const [row] = await db
      .select()
      .from(promoters)
      .where(promoterMatch(promoterId, tenantId))
      .limit(1)
    if (!row) {
      return c.json({ error: "Promotor no encontrado" }, 404)
    }

    await db
      .update(promoters)
      .set({ isActive: false })
      .where(promoterMatch(promoterId, tenantId))

    return c.json({ ok: true })
  })
