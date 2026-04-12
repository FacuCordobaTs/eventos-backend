import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import { staff, tenants } from "../db/schema"
import { eq } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { sanitizeStaff } from "../lib/staff-dto"

const setupSchema = z.object({
  name: z.string().min(1).max(255),
})

export const tenantsRoute = new Hono()
  .get("/", (c) => {
    return c.json({ message: "Tenants API" })
  })
  .post("/setup", authMiddleware, zValidator("json", setupSchema), async (c) => {
    const ctx = c as AuthenticatedContext
    if (ctx.staff.role !== "ADMIN") {
      return c.json(
        { error: "Solo administradores pueden configurar la productora." },
        403
      )
    }

    const body = c.req.valid("json")
    const db = drizzle(pool)
    const trimmedName = body.name.trim()

    try {
      const out = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(staff)
          .where(eq(staff.id, ctx.staff.id))
          .limit(1)
        if (!current) {
          throw new Error("STAFF_NOT_FOUND")
        }
        if (current.tenantId != null && current.tenantId !== "") {
          throw new Error("ALREADY_CONFIGURED")
        }

        const tenantId = uuidv4()
        await tx.insert(tenants).values({
          id: tenantId,
          name: trimmedName,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })

        await tx
          .update(staff)
          .set({ tenantId })
          .where(eq(staff.id, ctx.staff.id))

        const [updated] = await tx
          .select()
          .from(staff)
          .where(eq(staff.id, ctx.staff.id))
          .limit(1)
        if (!updated) {
          throw new Error("STAFF_NOT_FOUND")
        }

        return { tenantId, staffRow: updated }
      })

      return c.json(
        {
          staff: { ...sanitizeStaff(out.staffRow), tenantName: trimmedName },
          tenant: { id: out.tenantId, name: trimmedName },
        },
        201
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : ""
      if (msg === "ALREADY_CONFIGURED") {
        return c.json({ error: "Ya tienes una productora configurada" }, 400)
      }
      if (msg === "STAFF_NOT_FOUND") {
        return c.json({ error: "Usuario no encontrado" }, 404)
      }
      throw e
    }
  })
