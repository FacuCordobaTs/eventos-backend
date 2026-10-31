import { Context, Next } from "hono"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { staff as StaffTable } from "../db/schema"
import { eq } from "drizzle-orm"
import { verifyToken } from "../lib/jwt"
import { resolveStaffRole } from "../lib/staff-roles"

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

    const activeRole = resolveStaffRole(staff, payload.activeRole)
    // A transport session can only access its own profile and assigned boarding operations.
    if (activeRole === "TRANSPORTER" &&
      !c.req.path.startsWith("/transport-tickets/") &&
      c.req.path !== "/staff/me" && c.req.path !== "/staff/me/shift" && c.req.path !== "/staff/me/role" &&
      !/^\/staff\/device-links\/[^/]+\/approve$/.test(c.req.path)) {
      return c.json({ error: "No tenés permiso para esta operación" }, 403)
    }
    // El depósito sólo entra a sus eventos asignados y a las rutas de stock. El resto del panel
    // de la productora (ventas, entradas, equipo, caja) queda fuera del alcance de esta sesión.
    if (activeRole === "DEPOSIT") {
      const method = c.req.method
      const path = c.req.path
      const allowed =
        path === "/staff/me" ||
        path === "/staff/me/role" ||
        (path === "/events" && method === "GET") ||
        (/^\/events\/[^/]+$/.test(path) && method === "GET") ||
        /^\/events\/[^/]+\/deposit(?:\/.*)?$/.test(path) ||
        (/^\/events\/[^/]+\/stock-snapshot$/.test(path) && method === "GET") ||
        (path === "/inventory/items" && (method === "GET" || method === "POST"))
      if (!allowed) {
        return c.json({ error: "No tenés permiso para esta operación" }, 403)
      }
    }

    ;(c as AuthenticatedContext).staff = {
      id: staff.id,
      email: staff.email,
      name: staff.name,
      role: activeRole,
      tenantId: staff.tenantId ?? undefined,
      isActive: staff.isActive,
    }

    await next()
  } catch {
    return c.json({ error: "Token inválido" }, 401)
  }
}
