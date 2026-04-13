import { Context, Next } from "hono"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { customers } from "../db/schema"
import { eq } from "drizzle-orm"
import { verifyToken } from "../lib/jwt"

export interface ClientAuthContext extends Context {
  customer: {
    id: string
    email: string
    name: string
    phone: string | null
    isActive: boolean | null
  }
}

export const clientAuthMiddleware = async (c: Context, next: Next) => {
  const authHeader = c.req.header("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Se requiere encabezado Authorization" }, 401)
  }

  const token = authHeader.slice(7)

  try {
    const payload = await verifyToken(token)
    if (payload.aud !== "customer") {
      return c.json({ error: "Token inválido para la app de asistentes" }, 401)
    }

    const db = drizzle(pool)
    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, payload.sub))
      .limit(1)

    if (!row) {
      return c.json({ error: "Usuario no encontrado" }, 401)
    }

    if (row.isActive === false) {
      return c.json({ error: "Cuenta desactivada" }, 401)
    }

    ;(c as ClientAuthContext).customer = {
      id: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone ?? null,
      isActive: row.isActive,
    }

    await next()
  } catch {
    return c.json({ error: "Token inválido" }, 401)
  }
}
