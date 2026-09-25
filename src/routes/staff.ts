import { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import {
  bars,
  events,
  eventStaff,
  magicLinks,
  posSessions,
  promoters,
  staff,
  staffDeviceLinks,
  staffInvitations,
  tenants,
} from "../db/schema"
import { v4 as uuidv4 } from "uuid"
import { randomBytes } from "crypto"
import { setCookie } from "hono/cookie"
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, type SQL } from "drizzle-orm"
import { createAccessToken } from "../lib/jwt"
import * as bcrypt from "bcrypt"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { eventSupportsConsumptions } from "../lib/event-operation-mode"
import { sanitizeStaff, type StaffRow } from "../lib/staff-dto"
import { sendMagicLinkEmail } from "../lib/send-magic-link-email"
import { clientIp, consumeRateLimit } from "../lib/rate-limit"
import { isWhatsAppConfigured, sendWhatsAppTemplateMessage } from "../lib/whatsapp-service"

const ADMIN_URL = (process.env.ADMIN_URL ?? "https://admin.crow.ar").replace(/\/$/, "")

/** Token URL-safe (hex) para links de invitación, magic links y sesiones de puesto. */
function genToken(): string {
  return randomBytes(24).toString("hex")
}

const roleEnum = z.enum(["ADMIN", "MANAGER", "BARTENDER", "SECURITY", "PROMOTER"])
const pinSchema = z.string().regex(/^\d{4,6}$/, "El PIN debe tener entre 4 y 6 dígitos")

const createInvitationSchema = z.object({
  name: z.string().trim().min(1).max(255),
  role: roleEnum,
  // Desde el dashboard el alta también queda asignada al evento actual.
  eventId: z.string().min(1).optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
})

const acceptInvitationSchema = z.object({})

const magicLinkRequestSchema = z.object({ email: z.string().email() })
const magicLinkConsumeSchema = z.object({
  token: z.string().min(1),
  staffId: z.string().optional(),
})

const createDeviceLinkSchema = z.object({
  // Módulo que el equipo está abriendo. Sólo contextúa la pantalla del teléfono.
  access: z.enum(["pos", "security"]).optional(),
})
const claimDeviceLinkSchema = z.object({
  code: z.string().min(1),
  secret: z.string().min(1),
})
/**
 * Cuerpo de la aprobación del vínculo. `assignment` es opcional a propósito: los clientes previos
 * mandan `{}` y eso significa "no opinó" (no se toca la barra que la computadora ya tenía).
 * `null` explícito significa "quitar la barra asignada".
 */
const approveDeviceLinkSchema = z.object({
  assignment: z
    .object({ eventId: z.string().min(1).max(36), barId: z.string().min(1).max(36) })
    .nullable()
    .optional(),
})

const createPosSessionSchema = z.object({
  eventId: z.string().min(1),
  barId: z.string().optional(),
  label: z.string().min(1).optional(),
})
const posPinSchema = z.object({ pin: pinSchema })

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000
const STAFF_INVITATION_TEMPLATE = "crow_invitacion_staff"

/** Vida del código de vinculación de equipo: el teléfono tiene que escanear dentro de esa ventana. */
const DEVICE_LINK_TTL_MS = 5 * 60 * 1000
/** Si el teléfono aprueba sobre el final, el equipo todavía necesita tiempo para reclamar el JWT. */
const DEVICE_LINK_CLAIM_GRACE_MS = 2 * 60 * 1000
const DEVICE_LINK_LIMIT_PER_IP = { limit: 20, windowMs: 60 * 1000 }

type StaffDeviceLinkRow = typeof staffDeviceLinks.$inferSelect

/**
 * Estado del vínculo. `approved` y `claimed` significan lo mismo para el teléfono (ya vinculó);
 * para el equipo que espera sólo `approved` habilita reclamar el JWT.
 */
function deviceLinkStatus(row: StaffDeviceLinkRow): "pending" | "approved" | "claimed" | "expired" {
  if (row.claimedAt) return "claimed"
  if (row.expiresAt.getTime() < Date.now()) return "expired"
  if (row.approvedAt) return "approved"
  return "pending"
}

/**
 * ¿Ese PIN ya lo usa OTRA persona activa del tenant? El alta/rotación por PIN requiere que el
 * PIN sea único dentro del tenant (no hay constraint en DB por back-compat con PINs viejos).
 */
async function pinTaken(
  db: ReturnType<typeof drizzle>,
  tenantId: string | null | undefined,
  pin: string,
  excludeStaffId?: string
): Promise<boolean> {
  const rows = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(staffTenantScope(tenantId), eq(staff.pinCode, pin), eq(staff.isActive, true)))
  return rows.some((r) => r.id !== excludeStaffId)
}

const signupStaffSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
})

const loginStaffSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  staffId: z.string().optional(),
})

const createTeamMemberSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: roleEnum,
})

const updateTeamMemberSchema = z
  .object({
    name: z.string().min(1).optional(),
    role: roleEnum.optional(),
    password: z.string().min(8).optional(),
    // PIN de 4-6 dígitos para rotación en la sesión de puesto (spec §1). null lo borra.
    pin: z.string().regex(/^\d{4,6}$/, "El PIN debe tener entre 4 y 6 dígitos").nullable().optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.role !== undefined ||
      b.password !== undefined ||
      b.pin !== undefined,
    {
      message: "Al menos un campo para actualizar",
    }
  )

function staffTenantScope(tenantId: string | null | undefined): SQL {
  if (tenantId == null || tenantId === "") {
    return isNull(staff.tenantId)
  }
  return eq(staff.tenantId, tenantId)
}

function tenantMatches(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const aNull = a == null || a === ""
  const bNull = b == null || b === ""
  if (aNull && bNull) return true
  return a === b
}

const adminOnly: MiddlewareHandler = async (c, next) => {
  const ctx = c as AuthenticatedContext
  if (ctx.staff.role !== "ADMIN") {
    return c.json({ error: "Solo administradores pueden realizar esta acción" }, 403)
  }
  await next()
}

/**
 * ADMIN o MANAGER: quien puede fijar la barra de una computadora desde el QR, y ver la lista de
 * barras para elegir. El `adminOnly` de las sesiones de puesto queda como estaba.
 */
const adminOrManager: MiddlewareHandler = async (c, next) => {
  const ctx = c as AuthenticatedContext
  if (ctx.staff.role !== "ADMIN" && ctx.staff.role !== "MANAGER") {
    return c.json({ error: "Solo administradores y encargados pueden realizar esta acción" }, 403)
  }
  await next()
}

const cookieOptions = (
  c: { req: { header: (name: string) => string | undefined } },
  maxAge = 365 * 24 * 60 * 60
) => {
  const isHttps =
    c.req.header("x-forwarded-proto") === "https" || process.env.NODE_ENV === "production"
  return {
    path: "/",
    sameSite: "Lax" as const,
    secure: isHttps,
    maxAge,
    httpOnly: true,
  }
}

async function staffPayloadForClient(db: ReturnType<typeof drizzle>, row: StaffRow) {
  const base = sanitizeStaff(row)
  if (!row.tenantId) {
    return { ...base, tenantName: null as string | null }
  }
  const [t] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, row.tenantId))
    .limit(1)
  return { ...base, tenantName: t?.name ?? null }
}

/** Mantiene la identidad comercial del promotor ligada a su cuenta de staff. */
async function ensurePromoterAccount(
  db: any,
  input: { staffId: string; tenantId: string; name: string; isActive?: boolean }
) {
  const [existing] = await db
    .select({ id: promoters.id })
    .from(promoters)
    .where(eq(promoters.staffId, input.staffId))
    .limit(1)

  if (existing) {
    await db
      .update(promoters)
      .set({ name: input.name, ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) })
      .where(eq(promoters.id, existing.id))
    return existing.id
  }

  const id = uuidv4()
  await db.insert(promoters).values({
    id,
    tenantId: input.tenantId,
    staffId: input.staffId,
    name: input.name,
    isActive: input.isActive ?? true,
    createdAt: new Date(),
  })
  return id
}

function sanitizeInvitation(row: typeof staffInvitations.$inferSelect) {
  return {
    id: row.id,
    name: row.inviteeName ?? "Nuevo empleado",
    phone: row.inviteePhone ?? "",
    role: row.role,
    token: row.token,
    url: `${ADMIN_URL}/unirse/${row.token}`,
    status: row.status,
    // Permite volver a abrir el mismo enlace desde el equipo, sin crear otra cuenta.
    acceptedStaffId: row.acceptedStaffId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }
}

export const staffRoute = new Hono()
  .get("/", (c) => {
    return c.json({ message: "Staff API" })
  })
  .get("/me/shift", authMiddleware, async (c) => {
    const ctx = c as AuthenticatedContext
    if (ctx.staff.role !== "BARTENDER") {
      return c.json(
        { error: "Este recurso es solo para personal de barra." },
        403
      )
    }
    const tenantId = ctx.staff.tenantId
    if (tenantId == null || tenantId === "") {
      return c.json({ shift: null })
    }

    const db = drizzle(pool)
    const rows = await db
      .select({
        eventId: events.id,
        eventName: events.name,
        barId: eventStaff.barId,
        barName: bars.name,
      })
      .from(eventStaff)
      .innerJoin(events, eq(eventStaff.eventId, events.id))
      .leftJoin(bars, eq(eventStaff.barId, bars.id))
      .where(
        and(
          eq(eventStaff.staffId, ctx.staff.id),
          eq(eventStaff.tenantId, tenantId),
          eq(events.tenantId, tenantId),
          ne(events.status, "closed")
        )
      )
      .orderBy(desc(events.date))
      .limit(1)

    const row = rows[0]
    if (!row?.barId) {
      return c.json({ shift: null })
    }

    return c.json({
      shift: {
        eventId: row.eventId,
        eventName: row.eventName,
        barId: row.barId,
        barName: row.barName ?? "",
      },
    })
  })
  .get("/me", authMiddleware, async (c) => {
    const ctx = c as AuthenticatedContext
    const db = drizzle(pool)
    const [row] = await db
      .select()
      .from(staff)
      .where(eq(staff.id, ctx.staff.id))
      .limit(1)
    if (!row) {
      return c.json({ error: "Usuario no encontrado" }, 401)
    }
    return c.json({
      staff: await staffPayloadForClient(db, row),
    })
  })
  .get("/team", authMiddleware, async (c) => {
    const db = drizzle(pool)
    const ctx = c as AuthenticatedContext
    const includeInactive =
      c.req.query("includeInactive") === "true" && ctx.staff.role === "ADMIN"

    const whereClause = includeInactive
      ? staffTenantScope(ctx.staff.tenantId)
      : and(staffTenantScope(ctx.staff.tenantId), eq(staff.isActive, true))

    const rows = await db.select().from(staff).where(whereClause)

    return c.json({
      staff: rows.map(sanitizeStaff),
    })
  })
  .post(
    "/team",
    authMiddleware,
    adminOnly,
    zValidator("json", createTeamMemberSchema),
    async (c) => {
      const db = drizzle(pool)
      const ctx = c as AuthenticatedContext
      const body = c.req.valid("json")
      const currentTenantId = ctx.staff.tenantId ?? null

      // Check if (email, tenantId) pair already exists
      const alreadyMember = await db
        .select()
        .from(staff)
        .where(and(eq(staff.email, body.email), staffTenantScope(currentTenantId)))
      if (alreadyMember.length) {
        return c.json({ error: "Este email ya está registrado en tu Productora" }, 409)
      }

      // Check if email exists in another tenant — reuse their password hash
      const existingElsewhere = await db
        .select()
        .from(staff)
        .where(eq(staff.email, body.email))
        .limit(1)

      const passwordHash =
        existingElsewhere.length > 0
          ? existingElsewhere[0].passwordHash
          : await bcrypt.hash(body.password, 10)

      const imported = existingElsewhere.length > 0

      if (body.role === "PROMOTER" && !currentTenantId) {
        return c.json({ error: "Un promotor debe pertenecer a una productora." }, 400)
      }

      const id = uuidv4()
      await db.insert(staff).values({
        id,
        tenantId: currentTenantId,
        name: body.name,
        email: body.email,
        passwordHash,
        role: body.role,
        isActive: true,
        createdAt: new Date(),
      })
      if (body.role === "PROMOTER" && currentTenantId) {
        await ensurePromoterAccount(db, { staffId: id, tenantId: currentTenantId, name: body.name })
      }

      const [inserted] = await db.select().from(staff).where(eq(staff.id, id))
      return c.json({ staff: sanitizeStaff(inserted), imported }, 201)
    }
  )
  .patch(
    "/team/:id",
    authMiddleware,
    adminOnly,
    zValidator("json", updateTeamMemberSchema),
    async (c) => {
      const db = drizzle(pool)
      const ctx = c as AuthenticatedContext
      const id = c.req.param("id")
      const body = c.req.valid("json")

      if (id === ctx.staff.id) {
        return c.json({ error: "No podés editar tu propio usuario desde aquí" }, 400)
      }

      const [target] = await db.select().from(staff).where(eq(staff.id, id)).limit(1)
      if (!target) {
        return c.json({ error: "Persona no encontrada" }, 404)
      }
      if (!tenantMatches(ctx.staff.tenantId, target.tenantId)) {
        return c.json({ error: "Sin permiso" }, 403)
      }

      const passwordHash =
        body.password !== undefined ? await bcrypt.hash(body.password, 10) : undefined

      // El PIN debe ser único dentro del tenant (para poder rotar por PIN en la sesión de puesto).
      if (body.pin != null && (await pinTaken(db, target.tenantId, body.pin, id))) {
        return c.json({ error: "Ese PIN ya lo usa otra persona del equipo" }, 409)
      }

      await db
        .update(staff)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(passwordHash !== undefined ? { passwordHash } : {}),
          ...(body.pin !== undefined ? { pinCode: body.pin } : {}),
        })
        .where(eq(staff.id, id))

      const nextRole = body.role ?? target.role
      if (nextRole === "PROMOTER" && target.tenantId) {
        await ensurePromoterAccount(db, {
          staffId: target.id,
          tenantId: target.tenantId,
          name: body.name ?? target.name,
          isActive: target.isActive !== false,
        })
      } else if (target.role === "PROMOTER" && body.role !== undefined) {
        await db
          .update(promoters)
          .set({ isActive: false })
          .where(eq(promoters.staffId, target.id))
      }

      const [updated] = await db.select().from(staff).where(eq(staff.id, id)).limit(1)
      return c.json({ staff: sanitizeStaff(updated) })
    }
  )
  .delete("/team/:id", authMiddleware, adminOnly, async (c) => {
    const db = drizzle(pool)
    const ctx = c as AuthenticatedContext
    const id = c.req.param("id")

    if (id === ctx.staff.id) {
      return c.json({ error: "No podés desactivar tu propia cuenta" }, 400)
    }

    const [target] = await db.select().from(staff).where(eq(staff.id, id)).limit(1)
    if (!target) {
      return c.json({ error: "Persona no encontrada" }, 404)
    }
    if (!tenantMatches(ctx.staff.tenantId, target.tenantId)) {
      return c.json({ error: "Sin permiso" }, 403)
    }
    if (!target.isActive) {
      return c.json({ error: "La cuenta ya está desactivada" }, 400)
    }

    await db.update(staff).set({ isActive: false }).where(eq(staff.id, id))
    if (target.role === "PROMOTER") {
      await db.update(promoters).set({ isActive: false }).where(eq(promoters.staffId, id))
    }
    return c.json({ ok: true })
  })
  .post("/team/:id/reactivate", authMiddleware, adminOnly, async (c) => {
    const db = drizzle(pool)
    const ctx = c as AuthenticatedContext
    const id = c.req.param("id")

    const [target] = await db.select().from(staff).where(eq(staff.id, id)).limit(1)
    if (!target) {
      return c.json({ error: "Persona no encontrada" }, 404)
    }
    if (!tenantMatches(ctx.staff.tenantId, target.tenantId)) {
      return c.json({ error: "Sin permiso" }, 403)
    }
    if (target.isActive) {
      return c.json({ error: "La cuenta ya está activa" }, 400)
    }

    await db.update(staff).set({ isActive: true }).where(eq(staff.id, id))
    if (target.role === "PROMOTER" && target.tenantId) {
      await ensurePromoterAccount(db, { staffId: id, tenantId: target.tenantId, name: target.name, isActive: true })
    }
    const [updated] = await db.select().from(staff).where(eq(staff.id, id)).limit(1)
    return c.json({ staff: sanitizeStaff(updated) })
  })
  // ---------------------------------------------------------------------------
  // Invitaciones de staff (spec §1): el admin genera un link/QR nominado a un rol.
  // ---------------------------------------------------------------------------
  .post(
    "/invitations",
    authMiddleware,
    adminOnly,
    zValidator("json", createInvitationSchema),
    async (c) => {
      const db = drizzle(pool)
      const ctx = c as AuthenticatedContext
      const tenantId = ctx.staff.tenantId ?? null
      if (!tenantId) {
        return c.json({ error: "Tu cuenta no tiene productora asignada." }, 400)
      }
      const body = c.req.valid("json")
      const id = uuidv4()
      const staffId = uuidv4()
      const token = genToken()
      const expiresAt = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
        : null
      if (body.eventId) {
        const [event] = await db
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, body.eventId), eq(events.tenantId, tenantId)))
          .limit(1)
        if (!event) {
          return c.json({ error: "Evento no encontrado" }, 404)
        }
      }

      // El empleado existe desde que se genera la invitación. El primer acceso al link solo
      // activa su sesión; así se muestra y queda asignado al evento inmediatamente.
      const syntheticEmail = `invite-${staffId}@staff.local`
      const passwordHash = await bcrypt.hash(genToken(), 10)
      await db.insert(staff).values({
        id: staffId,
        tenantId,
        name: body.name,
        email: syntheticEmail,
        passwordHash,
        role: body.role,
        isActive: true,
        createdAt: new Date(),
      })
      if (body.role === "PROMOTER") {
        await ensurePromoterAccount(db, { staffId, tenantId, name: body.name })
      }
      await db.insert(staffInvitations).values({
        id,
        tenantId,
        inviteeName: body.name,
        role: body.role,
        token,
        status: "PENDING",
        expiresAt,
        createdBy: ctx.staff.id,
        acceptedStaffId: staffId,
        createdAt: new Date(),
      })
      if (body.eventId) {
        await db.insert(eventStaff).values({
          id: uuidv4(),
          eventId: body.eventId,
          tenantId,
          staffId,
          createdAt: new Date(),
        })
      }
      const [row] = await db
        .select()
        .from(staffInvitations)
        .where(eq(staffInvitations.id, id))
        .limit(1)
      return c.json({ invitation: sanitizeInvitation(row) }, 201)
    }
  )
  .get("/invitations", authMiddleware, adminOnly, async (c) => {
    const db = drizzle(pool)
    const ctx = c as AuthenticatedContext
    const tenantId = ctx.staff.tenantId ?? null
    if (!tenantId) {
      return c.json({ invitations: [] })
    }
    const rows = await db
      .select()
      .from(staffInvitations)
      .where(
        and(
          eq(staffInvitations.tenantId, tenantId),
          inArray(staffInvitations.status, ["PENDING", "ACCEPTED"])
        )
      )
      .orderBy(desc(staffInvitations.createdAt))
    return c.json({ invitations: rows.map(sanitizeInvitation) })
  })
  .post("/invitations/:id/revoke", authMiddleware, adminOnly, async (c) => {
    const db = drizzle(pool)
    const ctx = c as AuthenticatedContext
    const tenantId = ctx.staff.tenantId ?? null
    const id = c.req.param("id")
    const [inv] = await db
      .select()
      .from(staffInvitations)
      .where(eq(staffInvitations.id, id))
      .limit(1)
    if (!inv || !tenantMatches(tenantId, inv.tenantId)) {
      return c.json({ error: "Invitación no encontrada" }, 404)
    }
    if (inv.status === "REVOKED") {
      return c.json({ error: "La invitación ya fue revocada" }, 400)
    }
    await db
      .update(staffInvitations)
      .set({ status: "REVOKED" })
      .where(eq(staffInvitations.id, id))
    return c.json({ ok: true })
  })
  .post("/invitations/:id/send", authMiddleware, adminOnly, async (c) => {
    const db = drizzle(pool)
    const ctx = c as AuthenticatedContext
    const tenantId = ctx.staff.tenantId ?? null
    const id = c.req.param("id")
    const [invitation] = await db
      .select()
      .from(staffInvitations)
      .where(eq(staffInvitations.id, id))
      .limit(1)
    if (!invitation || !tenantMatches(tenantId, invitation.tenantId)) {
      return c.json({ error: "Invitación no encontrada" }, 404)
    }
    if (invitation.status !== "PENDING") {
      return c.json({ error: "La invitación ya no está pendiente" }, 400)
    }
    if (!invitation.inviteePhone?.trim()) {
      return c.json({ error: "Esta invitación no tiene un número de WhatsApp" }, 400)
    }
    if (!isWhatsAppConfigured()) {
      return c.json({ error: "El envío por WhatsApp no está disponible." }, 400)
    }
    const result = await sendWhatsAppTemplateMessage({
      to: invitation.inviteePhone,
      templateName: STAFF_INVITATION_TEMPLATE,
      bodyParameters: [invitation.inviteeName ?? "", invitation.role],
      urlButton: { parameter: invitation.token },
    })
    if (!result.ok) {
      return c.json({ error: `No se pudo enviar por WhatsApp: ${result.error ?? "error desconocido"}` }, 502)
    }
    return c.json({ ok: true })
  })
  // Público (sin auth): la persona abre el link para ver y usar su acceso por invitación.
  .get("/invitations/:token", async (c) => {
    const db = drizzle(pool)
    const token = c.req.param("token")
    const [inv] = await db
      .select()
      .from(staffInvitations)
      .where(eq(staffInvitations.token, token))
      .limit(1)
    if (!inv) {
      return c.json({ error: "Invitación no encontrada" }, 404)
    }
    // El vencimiento limita la aceptación inicial; una vez creada la cuenta, el link queda
    // como acceso persistente hasta que un administrador lo revoque.
    const expired =
      inv.status === "PENDING" &&
      inv.expiresAt != null &&
      inv.expiresAt.getTime() < Date.now()
    let tenantName: string | null = null
    if (inv.tenantId) {
      const [t] = await db
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, inv.tenantId))
        .limit(1)
      tenantName = t?.name ?? null
    }
    return c.json({
      invitation: {
        role: inv.role,
        status: inv.status,
        expired,
        tenantName,
      },
    })
  })
  .post(
    "/invitations/:token/accept",
    zValidator("json", acceptInvitationSchema),
    async (c) => {
      const db = drizzle(pool)
      const token = c.req.param("token")
      const [inv] = await db
        .select()
        .from(staffInvitations)
        .where(eq(staffInvitations.token, token))
        .limit(1)
      if (!inv) {
        return c.json({ error: "Invitación no encontrada" }, 404)
      }
      if (inv.status === "REVOKED") {
        return c.json({ error: "Esta invitación fue revocada" }, 410)
      }

      let row: StaffRow | undefined
      let created = false

      if (inv.status === "PENDING" && inv.acceptedStaffId) {
        // Las invitaciones nuevas ya provisionan la cuenta; este primer acceso solo inicia sesión.
        const [provisionedStaff] = await db
          .select()
          .from(staff)
          .where(and(eq(staff.id, inv.acceptedStaffId), eq(staff.tenantId, inv.tenantId)))
          .limit(1)
        if (!provisionedStaff || !provisionedStaff.isActive) {
          return c.json({ error: "El acceso de este empleado ya no está disponible" }, 410)
        }
        await db
          .update(staffInvitations)
          .set({ status: "ACCEPTED", acceptedAt: new Date() })
          .where(eq(staffInvitations.id, inv.id))
        row = provisionedStaff
      } else if (inv.status === "PENDING") {
        if (inv.expiresAt != null && inv.expiresAt.getTime() < Date.now()) {
          return c.json({ error: "La invitación venció" }, 410)
        }

        // El nombre y el rol se definieron al crear la invitación. El enlace crea la cuenta
        // en el primer acceso, sin pedir nombre, contraseña ni PIN.
        // Conservamos email/hash sintéticos para respetar las columnas NOT NULL de `staff`.
        const staffId = uuidv4()
        const syntheticEmail = `invite-${staffId}@staff.local`
        const passwordHash = await bcrypt.hash(genToken(), 10)
        await db.insert(staff).values({
          id: staffId,
          tenantId: inv.tenantId,
          name: inv.inviteeName ?? "Nuevo empleado",
          email: syntheticEmail,
          passwordHash,
          role: inv.role,
          isActive: true,
          createdAt: new Date(),
        })
        if (inv.role === "PROMOTER" && inv.tenantId) {
          await ensurePromoterAccount(db, {
            staffId,
            tenantId: inv.tenantId,
            name: inv.inviteeName ?? "Nuevo promotor",
          })
        }
        await db
          .update(staffInvitations)
          .set({
            status: "ACCEPTED",
            acceptedStaffId: staffId,
            acceptedAt: new Date(),
          })
          .where(eq(staffInvitations.id, inv.id))
        const [createdStaff] = await db
          .select()
          .from(staff)
          .where(eq(staff.id, staffId))
          .limit(1)
        row = createdStaff
        created = true
      } else {
        // Una invitación aceptada conserva el mismo enlace como credencial de acceso. Así,
        // aunque el empleado cierre sesión o cambie de dispositivo, vuelve a entrar por este URL.
        if (!inv.acceptedStaffId) {
          return c.json({ error: "La invitación no tiene una cuenta asociada" }, 409)
        }
        const [acceptedStaff] = await db
          .select()
          .from(staff)
          .where(and(eq(staff.id, inv.acceptedStaffId), eq(staff.tenantId, inv.tenantId)))
          .limit(1)
        row = acceptedStaff
        if (!row || !row.isActive) {
          return c.json({ error: "El acceso de este empleado ya no está disponible" }, 410)
        }
      }

      if (!row) {
        return c.json({ error: "No se pudo crear el acceso del empleado" }, 500)
      }
      const invitationSessionSeconds = 60 * 24 * 60 * 60
      const jwt = await createAccessToken(row.id, "staff", "60d")
      setCookie(c, "token", jwt, cookieOptions(c, invitationSessionSeconds))
      return c.json(
        {
          message: created ? "Cuenta creada" : "Sesión iniciada",
          token: jwt,
          staff: await staffPayloadForClient(db, row),
        },
        created ? 201 : 200
      )
    }
  )
  // ---------------------------------------------------------------------------
  // Magic link de login (spec §1): "Recibir un enlace de acceso".
  // ---------------------------------------------------------------------------
  .post("/magic-link", zValidator("json", magicLinkRequestSchema), async (c) => {
    const db = drizzle(pool)
    const { email } = c.req.valid("json")
    const dev = process.env.NODE_ENV !== "production"
    const candidates = await db
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.email, email), eq(staff.isActive, true)))
      .limit(1)
    // No revelamos si el email existe o no: siempre respondemos ok.
    if (!candidates.length) {
      return c.json({ ok: true })
    }
    const id = uuidv4()
    const token = genToken()
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS)
    await db.insert(magicLinks).values({ id, email, token, expiresAt, createdAt: new Date() })
    const url = `${ADMIN_URL}/acceso/${token}`
    await sendMagicLinkEmail({ to: email, url })
    return c.json({ ok: true, ...(dev ? { devUrl: url, devToken: token } : {}) })
  })
  .post("/magic-link/consume", zValidator("json", magicLinkConsumeSchema), async (c) => {
    const db = drizzle(pool)
    const body = c.req.valid("json")
    const [link] = await db
      .select()
      .from(magicLinks)
      .where(
        and(
          eq(magicLinks.token, body.token),
          isNull(magicLinks.usedAt),
          gt(magicLinks.expiresAt, new Date())
        )
      )
      .limit(1)
    if (!link) {
      return c.json({ error: "El enlace es inválido o venció" }, 401)
    }
    // Se resuelve como el login normal: por email, puede requerir elegir productora.
    const candidates = await db
      .select()
      .from(staff)
      .where(and(eq(staff.email, link.email), eq(staff.isActive, true)))
    if (!candidates.length) {
      return c.json({ error: "El enlace es inválido o venció" }, 401)
    }
    const finish = async (row: StaffRow) => {
      await db.update(magicLinks).set({ usedAt: new Date() }).where(eq(magicLinks.id, link.id))
      const jwt = await createAccessToken(row.id, "staff")
      setCookie(c, "token", jwt, cookieOptions(c))
      return c.json({
        message: "Inicio de sesión exitoso",
        token: jwt,
        staff: await staffPayloadForClient(db, row),
      })
    }
    if (body.staffId) {
      const row = candidates.find((r) => r.id === body.staffId)
      if (!row) {
        return c.json({ error: "Opción inválida" }, 401)
      }
      return finish(row)
    }
    if (candidates.length === 1) {
      return finish(candidates[0])
    }
    const options = await Promise.all(
      candidates.map(async (row) => {
        let tenantName: string | null = null
        if (row.tenantId) {
          const [t] = await db
            .select({ name: tenants.name })
            .from(tenants)
            .where(eq(tenants.id, row.tenantId))
            .limit(1)
          tenantName = t?.name ?? null
        }
        return { staffId: row.id, tenantName: tenantName ?? "Sin productora" }
      })
    )
    return c.json({ requiresTenantSelection: true as const, options })
  })
  // ---------------------------------------------------------------------------
  // Vinculación de equipo por QR (estilo WhatsApp Web): la computadora muestra un código, el
  // teléfono que ya tiene sesión staff lo aprueba y la computadora recibe la sesión de esa
  // persona. El `secret` no viaja en el QR: sólo el equipo que creó el vínculo puede reclamar
  // el JWT, así una foto del código no alcanza para quedarse con la sesión.
  // ---------------------------------------------------------------------------
  .post("/device-links", zValidator("json", createDeviceLinkSchema), async (c) => {
    const db = drizzle(pool)
    const body = c.req.valid("json")
    // Cada llamada escribe una fila y devuelve el `secret`: sin cupo por IP, cualquiera podría
    // llenar la tabla desde afuera.
    const ip = clientIp(c.req.raw.headers)
    if (ip) {
      const byIp = consumeRateLimit(
        `device-link:ip:${ip}`,
        DEVICE_LINK_LIMIT_PER_IP.limit,
        DEVICE_LINK_LIMIT_PER_IP.windowMs
      )
      if (!byIp.ok) {
        return c.json({ error: "Demasiados intentos. Esperá un momento." }, 429)
      }
    }
    const id = uuidv4()
    const code = randomBytes(16).toString("hex")
    const secret = genToken()
    const expiresAt = new Date(Date.now() + DEVICE_LINK_TTL_MS)
    await db.insert(staffDeviceLinks).values({
      id,
      code,
      secret,
      requestedAccess: body.access ?? null,
      expiresAt,
      createdAt: new Date(),
    })
    return c.json(
      {
        deviceLink: {
          code,
          secret,
          access: body.access ?? null,
          expiresAt,
          // El QR apunta siempre a Crow web: la app de escritorio no es una URL que un teléfono abra.
          url: `${ADMIN_URL}/vincular/${code}`,
        },
      },
      201
    )
  })
  // Público (sin auth): el teléfono consulta el vínculo que acaba de escanear, antes de aprobarlo.
  // Nunca revela quién lo aprobó ni qué barra se le fijó: sólo el estado y el módulo que pidió el
  // equipo.
  .get("/device-links/:code", async (c) => {
    const db = drizzle(pool)
    const [link] = await db
      .select()
      .from(staffDeviceLinks)
      .where(eq(staffDeviceLinks.code, c.req.param("code")))
      .limit(1)
    if (!link) {
      return c.json({ error: "El código no existe" }, 404)
    }
    return c.json({
      deviceLink: {
        access: link.requestedAccess,
        status: deviceLinkStatus(link),
        expiresAt: link.expiresAt,
      },
    })
  })
  // Barras que el teléfono puede fijar a esa computadora, ya agrupadas por evento para la pantalla
  // de vinculación. Exige sesión propia (ADMIN/MANAGER): el `code` es público, así que el listado
  // del catálogo de la productora no puede colgar del GET público de arriba.
  .get("/device-links/:code/bars", authMiddleware, adminOrManager, async (c) => {
    const db = drizzle(pool)
    const ctx = c as AuthenticatedContext
    const tenantId = ctx.staff.tenantId ?? null
    if (!tenantId) {
      return c.json({ error: "Tu cuenta no tiene productora asignada." }, 400)
    }
    const [link] = await db
      .select()
      .from(staffDeviceLinks)
      .where(eq(staffDeviceLinks.code, c.req.param("code")))
      .limit(1)
    if (!link) {
      return c.json({ error: "El código no existe. Pedí uno nuevo en la computadora." }, 404)
    }
    if (link.requestedAccess !== "pos") {
      return c.json({ error: "Este código no es para el POS." }, 400)
    }
    if (link.approvedAt) {
      return c.json({ error: "Este código ya fue usado. Generá uno nuevo en la computadora." }, 409)
    }
    if (link.expiresAt.getTime() < Date.now()) {
      return c.json({ error: "El código venció. Generá uno nuevo en la computadora." }, 410)
    }
    // Mismo universo que el POS: eventos ni cerrados ni sólo-entradas, con sus barras activas.
    // `is_active` es nullable, así que "activa" es `true` o NULL (como en el POS, que compara
    // contra `false`): un `ne(..., false)` de SQL descartaría los NULL.
    const rows = await db
      .select({
        eventId: events.id,
        eventName: events.name,
        eventDate: events.date,
        barId: bars.id,
        barName: bars.name,
        barIsDefault: bars.isDefault,
      })
      .from(bars)
      .innerJoin(events, eq(bars.eventId, events.id))
      .where(
        and(
          eq(bars.tenantId, tenantId),
          eq(events.tenantId, tenantId),
          or(eq(bars.isActive, true), isNull(bars.isActive)),
          ne(events.status, "closed"),
          ne(events.operationMode, "TICKETS_ONLY")
        )
      )
      .orderBy(desc(events.date), asc(bars.name))
    const grouped = new Map<
      string,
      { id: string; name: string; date: Date; bars: { id: string; name: string; isDefault: boolean }[] }
    >()
    for (const r of rows) {
      const bar = { id: r.barId, name: r.barName, isDefault: r.barIsDefault }
      const ev = grouped.get(r.eventId)
      if (ev) {
        ev.bars.push(bar)
      } else {
        grouped.set(r.eventId, {
          id: r.eventId,
          name: r.eventName,
          date: r.eventDate,
          bars: [bar],
        })
      }
    }
    // Sin barras activas no hay nada que elegir: el evento no aparece.
    return c.json({ events: [...grouped.values()] })
  })
  .post("/device-links/:code/approve", authMiddleware, async (c) => {
    const db = drizzle(pool)
    const ctx = c as AuthenticatedContext
    const code = String(c.req.param("code"))
    const [link] = await db
      .select()
      .from(staffDeviceLinks)
      .where(eq(staffDeviceLinks.code, code))
      .limit(1)
    if (!link) {
      return c.json({ error: "El código no existe. Pedí uno nuevo en la computadora." }, 404)
    }
    if (link.approvedAt) {
      return c.json({ error: "Este código ya fue usado. Generá uno nuevo en la computadora." }, 409)
    }
    if (link.expiresAt.getTime() < Date.now()) {
      return c.json({ error: "El código venció. Generá uno nuevo en la computadora." }, 410)
    }
    // Cuerpo tolerante: los clientes previos no mandan nada y aprueban igual (equivale a "no opinó").
    const parsed = approveDeviceLinkSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "Datos inválidos" }, 400)
    }
    const tenantId = ctx.staff.tenantId ?? null
    const assignment = parsed.data.assignment
    // Fijar la barra es potestad de ADMIN/MANAGER sobre un vínculo de POS de su propia productora.
    // Cualquier otro (bartender, seguridad, una cuenta sin productora) aprueba exactamente como
    // antes: ignora el campo sin pisar la fijación que la computadora ya tenía.
    const canAssign =
      link.requestedAccess === "pos" &&
      (ctx.staff.role === "ADMIN" || ctx.staff.role === "MANAGER") &&
      !!tenantId
    const decides = canAssign && assignment !== undefined
    let assignedBarId: string | null = null
    if (decides && assignment && tenantId) {
      // Mismo patrón que POST /pos-sessions: el evento y la barra se resuelven por id Y tenant, y
      // el evento tiene que seguir operando consumiciones. El teléfono acaba de leer esta lista del
      // mismo backend, así que un fallo no se silencia: fijar el puesto equivocado es peor.
      const [ev] = await db
        .select()
        .from(events)
        .where(and(eq(events.id, assignment.eventId), eq(events.tenantId, tenantId)))
        .limit(1)
      if (!ev || !eventSupportsConsumptions(ev.operationMode ?? "FULL_OPERATION")) {
        return c.json({ error: "Evento no encontrado" }, 404)
      }
      const [bar] = await db
        .select({ id: bars.id })
        .from(bars)
        .where(
          and(
            eq(bars.id, assignment.barId),
            eq(bars.eventId, assignment.eventId),
            eq(bars.tenantId, tenantId),
            or(eq(bars.isActive, true), isNull(bars.isActive))
          )
        )
        .limit(1)
      if (!bar) {
        return c.json({ error: "Puesto no encontrado" }, 404)
      }
      assignedBarId = bar.id
    }
    // La sesión que se entrega es la de quien aprueba, con su rol y su tenant: vincular un equipo
    // no agrega permisos ni permite prestar otra cuenta. Por eso alcanza con estar autenticado;
    // el rol se sigue validando al operar, como en cualquier login.
    await db
      .update(staffDeviceLinks)
      .set({
        staffId: ctx.staff.id,
        approvedAt: new Date(),
        expiresAt: new Date(
          Math.max(link.expiresAt.getTime(), Date.now() + DEVICE_LINK_CLAIM_GRACE_MS)
        ),
        ...(decides ? { assignedBarId, assignmentDecided: true } : {}),
      })
      .where(eq(staffDeviceLinks.id, link.id))
    return c.json({ ok: true })
  })
  // El equipo espera con su `secret`; cuando el teléfono aprobó, acá recibe su sesión.
  .post("/device-links/claim", zValidator("json", claimDeviceLinkSchema), async (c) => {
    const db = drizzle(pool)
    const { code, secret } = c.req.valid("json")
    const [link] = await db
      .select()
      .from(staffDeviceLinks)
      .where(and(eq(staffDeviceLinks.code, code), eq(staffDeviceLinks.secret, secret)))
      .limit(1)
    if (!link) {
      return c.json({ error: "Vínculo no encontrado" }, 404)
    }
    if (link.claimedAt) {
      return c.json({ error: "Este código ya fue reclamado. Generá uno nuevo." }, 409)
    }
    if (link.expiresAt.getTime() < Date.now()) {
      return c.json({ status: "expired" as const })
    }
    if (!link.staffId) {
      return c.json({ status: "pending" as const })
    }
    const [row] = await db.select().from(staff).where(eq(staff.id, link.staffId)).limit(1)
    if (!row || !row.isActive) {
      return c.json({ error: "La cuenta de este acceso ya no está disponible" }, 410)
    }
    // Barra que quien aprobó fijó a esta computadora. Se resuelve contra el tenant de ESA cuenta
    // (segunda barrera: un `assigned_bar_id` tocado a mano no puede sacar por acá una barra de otra
    // productora). Si la barra o su evento ya no existen, va null con `assignmentDecided: true`,
    // que es la señal para que la computadora libere su fijación local.
    let assignment: {
      eventId: string
      eventName: string
      barId: string
      barName: string
    } | null = null
    if (link.assignmentDecided && link.assignedBarId && row.tenantId) {
      const [bar] = await db
        .select({
          eventId: events.id,
          eventName: events.name,
          barId: bars.id,
          barName: bars.name,
        })
        .from(bars)
        .innerJoin(events, eq(bars.eventId, events.id))
        .where(
          and(
            eq(bars.id, link.assignedBarId),
            eq(bars.tenantId, row.tenantId),
            eq(events.tenantId, row.tenantId)
          )
        )
        .limit(1)
      assignment = bar ?? null
    }
    await db
      .update(staffDeviceLinks)
      .set({ claimedAt: new Date() })
      .where(eq(staffDeviceLinks.id, link.id))
    const jwt = await createAccessToken(row.id, "staff")
    return c.json({
      status: "approved" as const,
      token: jwt,
      staff: await staffPayloadForClient(db, row),
      assignment,
      assignmentDecided: link.assignmentDecided === true,
    })
  })
  // ---------------------------------------------------------------------------
  // Sesión de puesto (spec §1): dispositivo fijado a una barra, rotación por PIN.
  // ---------------------------------------------------------------------------
  .post(
    "/pos-sessions",
    authMiddleware,
    adminOnly,
    zValidator("json", createPosSessionSchema),
    async (c) => {
      const db = drizzle(pool)
      const ctx = c as AuthenticatedContext
      const tenantId = ctx.staff.tenantId ?? null
      if (!tenantId) {
        return c.json({ error: "Tu cuenta no tiene productora asignada." }, 400)
      }
      const body = c.req.valid("json")
      const [ev] = await db
        .select()
        .from(events)
        .where(and(eq(events.id, body.eventId), eq(events.tenantId, tenantId)))
        .limit(1)
      if (!ev) {
        return c.json({ error: "Evento no encontrado" }, 404)
      }
      let barId: string | null = null
      let barName: string | null = null
      if (body.barId) {
        const [bar] = await db
          .select()
          .from(bars)
          .where(
            and(
              eq(bars.id, body.barId),
              eq(bars.eventId, body.eventId),
              eq(bars.tenantId, tenantId)
            )
          )
          .limit(1)
        if (!bar) {
          return c.json({ error: "Puesto no encontrado" }, 404)
        }
        barId = bar.id
        barName = bar.name
      }
      const id = uuidv4()
      const token = genToken()
      const label = body.label ?? barName ?? ev.name
      await db.insert(posSessions).values({
        id,
        tenantId,
        eventId: body.eventId,
        barId,
        token,
        label,
        isActive: true,
        createdBy: ctx.staff.id,
        createdAt: new Date(),
      })
      return c.json(
        {
          posSession: {
            id,
            token,
            eventId: body.eventId,
            barId,
            label,
            url: `${ADMIN_URL}/pos/sesion/${token}`,
          },
        },
        201
      )
    }
  )
  .get("/pos-sessions", authMiddleware, adminOnly, async (c) => {
    const db = drizzle(pool)
    const ctx = c as AuthenticatedContext
    const tenantId = ctx.staff.tenantId ?? null
    if (!tenantId) {
      return c.json({ posSessions: [] })
    }
    const eventId = c.req.query("eventId")
    const where = eventId
      ? and(
          eq(posSessions.tenantId, tenantId),
          eq(posSessions.isActive, true),
          eq(posSessions.eventId, eventId)
        )
      : and(eq(posSessions.tenantId, tenantId), eq(posSessions.isActive, true))
    const rows = await db
      .select()
      .from(posSessions)
      .where(where)
      .orderBy(desc(posSessions.createdAt))
    return c.json({
      posSessions: rows.map((r) => ({
        id: r.id,
        token: r.token,
        eventId: r.eventId,
        barId: r.barId,
        label: r.label,
        lastUsedAt: r.lastUsedAt,
        createdAt: r.createdAt,
      })),
    })
  })
  .post("/pos-sessions/:id/close", authMiddleware, adminOnly, async (c) => {
    const db = drizzle(pool)
    const ctx = c as AuthenticatedContext
    const tenantId = ctx.staff.tenantId ?? null
    const id = c.req.param("id")
    const [sess] = await db
      .select()
      .from(posSessions)
      .where(eq(posSessions.id, id))
      .limit(1)
    if (!sess || !tenantMatches(tenantId, sess.tenantId)) {
      return c.json({ error: "Sesión no encontrada" }, 404)
    }
    await db.update(posSessions).set({ isActive: false }).where(eq(posSessions.id, id))
    return c.json({ ok: true })
  })
  // Público (sin auth): el dispositivo lee su contexto y el personal entra por PIN.
  .get("/pos-sessions/:token", async (c) => {
    const db = drizzle(pool)
    const token = c.req.param("token")
    const [sess] = await db
      .select()
      .from(posSessions)
      .where(and(eq(posSessions.token, token), eq(posSessions.isActive, true)))
      .limit(1)
    if (!sess) {
      return c.json({ error: "Sesión no encontrada o cerrada" }, 404)
    }
    const [ev] = await db
      .select({ name: events.name })
      .from(events)
      .where(eq(events.id, sess.eventId))
      .limit(1)
    let barName: string | null = null
    if (sess.barId) {
      const [bar] = await db
        .select({ name: bars.name })
        .from(bars)
        .where(eq(bars.id, sess.barId))
        .limit(1)
      barName = bar?.name ?? null
    }
    return c.json({
      session: {
        label: sess.label,
        eventId: sess.eventId,
        eventName: ev?.name ?? "",
        barId: sess.barId,
        barName,
      },
    })
  })
  .post(
    "/pos-sessions/:token/pin",
    zValidator("json", posPinSchema),
    async (c) => {
      const db = drizzle(pool)
      const token = c.req.param("token")
      const { pin } = c.req.valid("json")
      const [sess] = await db
        .select()
        .from(posSessions)
        .where(and(eq(posSessions.token, token), eq(posSessions.isActive, true)))
        .limit(1)
      if (!sess) {
        return c.json({ error: "Sesión no encontrada o cerrada" }, 404)
      }
      const matches = await db
        .select()
        .from(staff)
        .where(
          and(
            staffTenantScope(sess.tenantId),
            eq(staff.pinCode, pin),
            eq(staff.isActive, true)
          )
        )
      if (matches.length === 0) {
        return c.json({ error: "PIN incorrecto" }, 401)
      }
      if (matches.length > 1) {
        return c.json(
          { error: "Ese PIN está duplicado. Avisá a un administrador." },
          409
        )
      }
      const row = matches[0]
      await db
        .update(posSessions)
        .set({ lastUsedAt: new Date() })
        .where(eq(posSessions.id, sess.id))
      const jwt = await createAccessToken(row.id, "staff")
      return c.json({
        token: jwt,
        staff: await staffPayloadForClient(db, row),
        shift: {
          eventId: sess.eventId,
          barId: sess.barId,
          label: sess.label,
        },
      })
    }
  )
  .post("/register-admin", zValidator("json", signupStaffSchema), async (c) => {
    const db = drizzle(pool)
    const body = c.req.valid("json")

    const existingStaff = await db.select().from(staff).where(eq(staff.email, body.email))
    if (existingStaff.length) {
      return c.json({ error: "Email ya utilizado" }, 409)
    }

    const passwordHash = await bcrypt.hash(body.password, 10)
    const id = uuidv4()
    await db.insert(staff).values({
      id,
      name: body.name,
      email: body.email,
      passwordHash,
      role: "ADMIN",
      isActive: true,
      createdAt: new Date(),
    })

    const [row] = await db.select().from(staff).where(eq(staff.id, id)).limit(1)
    const token = await createAccessToken(row.id, "staff")

    setCookie(c, "token", token, cookieOptions(c))

    return c.json(
      {
        message: "Administrador registrado correctamente",
        token,
        staff: await staffPayloadForClient(db, row),
      },
      201
    )
  })
  .post("/login", zValidator("json", loginStaffSchema), async (c) => {
    const db = drizzle(pool)
    const body = c.req.valid("json")

    // If staffId is provided (tenant selection step), authenticate against that specific record
    if (body.staffId) {
      const [target] = await db
        .select()
        .from(staff)
        .where(and(eq(staff.id, body.staffId), eq(staff.email, body.email)))
        .limit(1)
      if (!target) {
        return c.json({ error: "Email o contraseña incorrectos" }, 401)
      }
      if (!target.isActive) {
        return c.json({ error: "Cuenta desactivada. Contactá a un administrador." }, 403)
      }
      const passwordMatch = await bcrypt.compare(body.password, target.passwordHash)
      if (!passwordMatch) {
        return c.json({ error: "Email o contraseña incorrectos" }, 401)
      }
      const token = await createAccessToken(target.id, "staff")
      setCookie(c, "token", token, cookieOptions(c))
      return c.json({
        message: "Inicio de sesión exitoso",
        token,
        staff: await staffPayloadForClient(db, target),
      })
    }

    // Find all active staff records with this email
    const candidates = await db
      .select()
      .from(staff)
      .where(and(eq(staff.email, body.email), eq(staff.isActive, true)))

    if (!candidates.length) {
      return c.json({ error: "Email o contraseña incorrectos" }, 401)
    }

    // Verify password against all matching records
    const matched: typeof candidates = []
    for (const row of candidates) {
      const ok = await bcrypt.compare(body.password, row.passwordHash)
      if (ok) matched.push(row)
    }

    if (matched.length === 0) {
      return c.json({ error: "Email o contraseña incorrectos" }, 401)
    }

    // Single match: proceed normally
    if (matched.length === 1) {
      const row = matched[0]
      const token = await createAccessToken(row.id, "staff")
      setCookie(c, "token", token, cookieOptions(c))
      return c.json({
        message: "Inicio de sesión exitoso",
        token,
        staff: await staffPayloadForClient(db, row),
      })
    }

    // Multiple matches: ask the client to select a tenant
    const options = await Promise.all(
      matched.map(async (row) => {
        let tenantName: string | null = null
        if (row.tenantId) {
          const [t] = await db
            .select({ name: tenants.name })
            .from(tenants)
            .where(eq(tenants.id, row.tenantId))
            .limit(1)
          tenantName = t?.name ?? null
        }
        return { staffId: row.id, tenantName: tenantName ?? "Sin productora" }
      })
    )

    return c.json({ requiresTenantSelection: true as const, options })
  })
  .post("/logout", (c) => {
    setCookie(c, "token", "", {
      path: "/",
      sameSite: "Lax",
      maxAge: 0,
      httpOnly: true,
    })
    return c.json({ message: "Sesión cerrada" })
  })
