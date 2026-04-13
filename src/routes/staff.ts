import { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { staff, tenants } from "../db/schema"
import { v4 as uuidv4 } from "uuid"
import { setCookie } from "hono/cookie"
import { and, eq, isNull, type SQL } from "drizzle-orm"
import { createAccessToken } from "../lib/jwt"
import * as bcrypt from "bcrypt"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { sanitizeStaff, type StaffRow } from "../lib/staff-dto"

const signupStaffSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
})

const loginStaffSchema = z.object({
  email: z.string().email(),
  password: z.string(),
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
  })
  .refine((b) => b.name !== undefined || b.role !== undefined || b.password !== undefined, {
    message: "Al menos un campo para actualizar",
  })

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

export const staffRoute = new Hono()
  .get("/", (c) => {
    return c.json({ message: "Staff API" })
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

      const existing = await db.select().from(staff).where(eq(staff.email, body.email))
      if (existing.length) {
        return c.json({ error: "Email ya utilizado" }, 409)
      }

      const passwordHash = await bcrypt.hash(body.password, 10)
      const id = uuidv4()
      await db.insert(staff).values({
        id,
        tenantId: ctx.staff.tenantId ?? null,
        name: body.name,
        email: body.email,
        passwordHash,
        role: body.role,
        isActive: true,
        createdAt: new Date(),
      })

      const inserted = await db.select().from(staff).where(eq(staff.id, id))
      return c.json({ staff: sanitizeStaff(inserted[0]) }, 201)
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

      await db
        .update(staff)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(passwordHash !== undefined ? { passwordHash } : {}),
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

    const rows = await db.select().from(staff).where(eq(staff.email, body.email))
    const row = rows[0]
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

    const existingStaff = await db.select().from(staff).where(eq(staff.email, body.email))
    if (!existingStaff.length) {
      return c.json({ error: "Email o contraseña incorrectos" }, 401)
    }

    const row = existingStaff[0]
    if (!row.isActive) {
      return c.json({ error: "Cuenta desactivada. Contactá a un administrador." }, 403)
    }

    const passwordMatch = await bcrypt.compare(body.password, row.passwordHash)
    if (!passwordMatch) {
      return c.json({ error: "Email o contraseña incorrectos" }, 401)
    }

    const token = await createAccessToken(row.id, "staff")
    setCookie(c, "token", token, cookieOptions(c))

    return c.json({
      message: "Inicio de sesión exitoso",
      token,
      staff: await staffPayloadForClient(db, row),
    })
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
