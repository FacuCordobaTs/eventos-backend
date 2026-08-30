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
  staff,
  staffInvitations,
  tenants,
} from "../db/schema"
import { v4 as uuidv4 } from "uuid"
import { randomBytes } from "crypto"
import { setCookie } from "hono/cookie"
import { and, desc, eq, gt, isNull, ne, type SQL } from "drizzle-orm"
import { createAccessToken } from "../lib/jwt"
import * as bcrypt from "bcrypt"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { sanitizeStaff, type StaffRow } from "../lib/staff-dto"
import { sendMagicLinkEmail } from "../lib/send-magic-link-email"
import { sendWhatsAppTemplateMessage } from "../lib/whatsapp-service"

const ADMIN_URL = (process.env.ADMIN_URL ?? "https://admin.crow.ar").replace(/\/$/, "")

/** Token URL-safe (hex) para links de invitación, magic links y sesiones de puesto. */
function genToken(): string {
  return randomBytes(24).toString("hex")
}

const roleEnum = z.enum(["ADMIN", "MANAGER", "BARTENDER", "SECURITY"])
const pinSchema = z.string().regex(/^\d{4,6}$/, "El PIN debe tener entre 4 y 6 dígitos")

const createInvitationSchema = z.object({
  name: z.string().trim().min(1).max(255),
  role: roleEnum,
  expiresInDays: z.number().int().positive().max(365).optional(),
})

const acceptInvitationSchema = z.object({
  name: z.string().min(1),
  pin: pinSchema,
})

const magicLinkRequestSchema = z.object({ email: z.string().email() })
const magicLinkConsumeSchema = z.object({
  token: z.string().min(1),
  staffId: z.string().optional(),
})

const createPosSessionSchema = z.object({
  eventId: z.string().min(1),
  barId: z.string().optional(),
  label: z.string().min(1).optional(),
})
const posPinSchema = z.object({ pin: pinSchema })

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000
const STAFF_INVITATION_TEMPLATE = "crow_invitacion_staff"

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
  role: z.enum(["ADMIN", "MANAGER", "BARTENDER", "SECURITY"]),
})

const updateTeamMemberSchema = z
  .object({
    name: z.string().min(1).optional(),
    role: z.enum(["ADMIN", "MANAGER", "BARTENDER", "SECURITY"]).optional(),
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

const cookieOptions = (c: { req: { header: (name: string) => string | undefined } }) => {
  const isHttps =
    c.req.header("x-forwarded-proto") === "https" || process.env.NODE_ENV === "production"
  return {
    path: "/",
    sameSite: "Lax" as const,
    secure: isHttps,
    maxAge: 365 * 24 * 60 * 60,
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

function sanitizeInvitation(row: typeof staffInvitations.$inferSelect) {
  return {
    id: row.id,
    name: row.inviteeName ?? "Nuevo empleado",
    phone: row.inviteePhone ?? "",
    role: row.role,
    token: row.token,
    url: `${ADMIN_URL}/unirse/${row.token}`,
    status: row.status,
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
      const token = genToken()
      const expiresAt = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
        : null
      await db.insert(staffInvitations).values({
        id,
        tenantId,
        inviteeName: body.name,
        role: body.role,
        token,
        status: "PENDING",
        expiresAt,
        createdBy: ctx.staff.id,
        createdAt: new Date(),
      })
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
          eq(staffInvitations.status, "PENDING")
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
    if (inv.status !== "PENDING") {
      return c.json({ error: "La invitación ya no está pendiente" }, 400)
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
    const [tenant] = await db
      .select({
        whatsappEnabled: tenants.whatsappEnabled,
        whatsappToken: tenants.whatsappToken,
        whatsappPhoneNumberId: tenants.whatsappPhoneNumberId,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId!))
      .limit(1)
    if (!tenant?.whatsappEnabled || !tenant.whatsappToken || !tenant.whatsappPhoneNumberId) {
      return c.json({ error: "Configurá WhatsApp en la productora antes de enviar invitaciones." }, 400)
    }
    const result = await sendWhatsAppTemplateMessage({
      token: tenant.whatsappToken,
      phoneNumberId: tenant.whatsappPhoneNumberId,
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
  // Público (sin auth): la persona abre el link para ver e aceptar la invitación.
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
    const expired = inv.expiresAt != null && inv.expiresAt.getTime() < Date.now()
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
      const body = c.req.valid("json")
      const [inv] = await db
        .select()
        .from(staffInvitations)
        .where(eq(staffInvitations.token, token))
        .limit(1)
      if (!inv) {
        return c.json({ error: "Invitación no encontrada" }, 404)
      }
      if (inv.status !== "PENDING") {
        return c.json({ error: "Esta invitación ya no está disponible" }, 410)
      }
      if (inv.expiresAt != null && inv.expiresAt.getTime() < Date.now()) {
        return c.json({ error: "La invitación venció" }, 410)
      }
      if (await pinTaken(db, inv.tenantId, body.pin)) {
        return c.json(
          { error: "Ese PIN ya lo usa otra persona del equipo. Probá otro." },
          409
        )
      }
      // Alta por PIN: sin email/contraseña reales. Email sintético + hash random para
      // respetar los NOT NULL de `staff` sin habilitar login por contraseña.
      const staffId = uuidv4()
      const syntheticEmail = `pin-${staffId}@staff.local`
      const passwordHash = await bcrypt.hash(genToken(), 10)
      await db.insert(staff).values({
        id: staffId,
        tenantId: inv.tenantId,
        name: body.name,
        email: syntheticEmail,
        passwordHash,
        role: inv.role,
        pinCode: body.pin,
        isActive: true,
        createdAt: new Date(),
      })
      await db
        .update(staffInvitations)
        .set({
          status: "ACCEPTED",
          acceptedStaffId: staffId,
          acceptedAt: new Date(),
        })
        .where(eq(staffInvitations.id, inv.id))
      const [row] = await db.select().from(staff).where(eq(staff.id, staffId)).limit(1)
      const jwt = await createAccessToken(row.id, "staff")
      setCookie(c, "token", jwt, cookieOptions(c))
      return c.json(
        {
          message: "Cuenta creada",
          token: jwt,
          staff: await staffPayloadForClient(db, row),
        },
        201
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
