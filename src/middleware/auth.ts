import { Context, Next } from "hono"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { staff as StaffTable } from "../db/schema"
import { eq } from "drizzle-orm"
import { verifyToken } from "../lib/jwt"

export interface AuthenticatedContext extends Context {
  staff: {
    id: string
    email: string
    name: string
    role: string
    tenantId?: string
    isActive: boolean
  }
}

export const authMiddleware = async (c: Context, next: Next) => {
  const authHeader = c.req.header("Authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Se requiere encabezado Authorization" }, 401)
  }

  const token = authHeader.slice(7)

  try {
    const payload = await verifyToken(token)
    if (payload.aud !== "staff") {
      return c.json({ error: "Token inválido para panel de staff" }, 401)
    }
    const staffId = payload.sub
    const db = drizzle(pool)
    const staffResult = await db
      .select()
      .from(StaffTable)
      .where(eq(StaffTable.id, staffId))
      .limit(1)

    if (!staffResult.length) {
      return c.json({ error: "Usuario no encontrado" }, 401)
    }

    const staff = staffResult[0]
    if (!staff.isActive) {
      return c.json({ error: "Cuenta desactivada" }, 401)
    }

    // A transport session can only access its own profile and assigned boarding operations.
    if (staff.role === "TRANSPORTER" &&
      !c.req.path.startsWith("/transport-tickets/") &&
      c.req.path !== "/staff/me" && c.req.path !== "/staff/me/shift" &&
      !/^\/staff\/device-links\/[^/]+\/approve$/.test(c.req.path)) {
      return c.json({ error: "No tenés permiso para esta operación" }, 403)
    }

    ;(c as AuthenticatedContext).staff = {
      id: staff.id,
      email: staff.email,
      name: staff.name,
      role: staff.role,
      tenantId: staff.tenantId ?? undefined,
      isActive: staff.isActive,
    }

    await next()
  } catch {
    return c.json({ error: "Token inválido" }, 401)
  }
}
