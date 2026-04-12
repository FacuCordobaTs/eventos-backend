import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { staff } from "../db/schema"
import { v4 as uuidv4 } from "uuid"
import { setCookie } from "hono/cookie"
import { eq } from "drizzle-orm"
import { createAccessToken } from "../lib/jwt"
import * as bcrypt from "bcrypt"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"

const signupStaffSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
})

const loginStaffSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

const newStaffSchema = z.object({
  name: z.string(),
  email: z.string(),
  passwordHash: z.string(),
  role: z.enum(["ADMIN", "MANAGER", "BARTENDER", "SECURITY"]),
})

type StaffRow = typeof staff.$inferSelect

function sanitizeStaff(row: StaffRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt,
  }
}

const cookieOptions = (c: { req: { header: (name: string) => string | undefined } }) => {
  const isHttps = c.req.header("x-forwarded-proto") === "https" || process.env.NODE_ENV === "production"
  return {
    path: "/",
    sameSite: "Lax" as const,
    secure: isHttps,
    maxAge: 365 * 24 * 60 * 60,
    httpOnly: true,
  }
}

export const staffRoute = new Hono()
  .get("/", (c) => {
    return c.json({ message: "Staff API" })
  })
  .get("/me", authMiddleware, (c) => {
    const ctx = c as AuthenticatedContext
    return c.json({ staff: ctx.staff })
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
      createdAt: new Date(),
    })

    const rows = await db.select().from(staff).where(eq(staff.email, body.email))
    const row = rows[0]
    const token = await createAccessToken({ sub: row.id })

    setCookie(c, "token", token, cookieOptions(c))

    return c.json(
      {
        message: "Administrador registrado correctamente",
        token,
        staff: sanitizeStaff(row),
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

    const passwordMatch = await bcrypt.compare(body.password, existingStaff[0].passwordHash)
    if (!passwordMatch) {
      return c.json({ error: "Email o contraseña incorrectos" }, 401)
    }

    const row = existingStaff[0]
    const token = await createAccessToken({ sub: row.id })
    setCookie(c, "token", token, cookieOptions(c))

    return c.json({
      message: "Inicio de sesión exitoso",
      token,
      staff: sanitizeStaff(row),
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
  .post("/new-staff", zValidator("json", newStaffSchema), async (c) => {
    const db = drizzle(pool)
    const newStaff = c.req.valid("json")
    await db.insert(staff).values({
      id: uuidv4(),
      name: newStaff.name,
      email: newStaff.email,
      passwordHash: newStaff.passwordHash,
      role: newStaff.role,
      createdAt: new Date(),
    })
    return c.json({ ok: true })
  })
