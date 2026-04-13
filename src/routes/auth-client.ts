import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { customers } from "../db/schema"
import { eq } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import * as bcrypt from "bcrypt"
import { createAccessToken } from "../lib/jwt"

const registerSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
  password: z.string().min(8),
  phone: z.string().max(50).optional(),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
})

function customerPublic(row: typeof customers.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    createdAt: row.createdAt,
  }
}

export const authClientRoute = new Hono()
  .post("/register", zValidator("json", registerSchema), async (c) => {
    const db = drizzle(pool)
    const body = c.req.valid("json")

    const existing = await db
      .select()
      .from(customers)
      .where(eq(customers.email, body.email.toLowerCase().trim()))
      .limit(1)

    if (existing.length) {
      return c.json({ error: "Este email ya está registrado" }, 409)
    }

    const passwordHash = await bcrypt.hash(body.password, 10)
    const id = uuidv4()
    const email = body.email.toLowerCase().trim()

    await db.insert(customers).values({
      id,
      name: body.name.trim(),
      email,
      passwordHash,
      phone: body.phone?.trim() || null,
      isActive: true,
      createdAt: new Date(),
    })

    const [row] = await db.select().from(customers).where(eq(customers.id, id)).limit(1)
    if (!row) {
      return c.json({ error: "No se pudo crear la cuenta" }, 500)
    }

    const token = await createAccessToken(row.id, "customer")

    return c.json(
      {
        message: "Cuenta creada",
        token,
        customer: customerPublic(row),
      },
      201
    )
  })
  .post("/login", zValidator("json", loginSchema), async (c) => {
    const db = drizzle(pool)
    const body = c.req.valid("json")
    const email = body.email.toLowerCase().trim()

    const [row] = await db.select().from(customers).where(eq(customers.email, email)).limit(1)

    if (!row) {
      return c.json({ error: "Email o contraseña incorrectos" }, 401)
    }

    if (row.isActive === false) {
      return c.json({ error: "Cuenta desactivada" }, 403)
    }

    if (!row.passwordHash) {
      return c.json({ error: "Configurá una contraseña para esta cuenta" }, 401)
    }

    const ok = await bcrypt.compare(body.password, row.passwordHash)
    if (!ok) {
      return c.json({ error: "Email o contraseña incorrectos" }, 401)
    }

    const token = await createAccessToken(row.id, "customer")

    return c.json({
      message: "Sesión iniciada",
      token,
      customer: customerPublic(row),
    })
  })
