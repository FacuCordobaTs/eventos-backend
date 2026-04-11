import { Context, Next } from 'hono'
import * as jwt from 'jsonwebtoken'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { staff as StaffTable } from '../db/schema'
import { eq } from 'drizzle-orm'

export interface AuthenticatedContext extends Context {
  staff: {
    id: string
    email: string
    name: string
    role: string
    tenantId?: string
  }
}

export const authMiddleware = async (c: Context, next: Next) => {
  // For React Native apps, we only use Authorization header
  const authHeader = c.req.header('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization header required' }, 401)
  }

  const token = authHeader.substring(7) // Remove 'Bearer ' prefix

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret') as { email: string }

    const db = drizzle(pool)
    const staffResult = await db.select().from(StaffTable).where(eq(StaffTable.email, decoded.email)).limit(1)

    if (!staffResult.length) {
      return c.json({ error: 'Restaurante no encontrado' }, 401)
    }

    const staff = staffResult[0]

      ; (c as AuthenticatedContext).staff = {
        id: staff.id,
        email: staff.email,
        name: staff.name,
        role: staff.role,
        tenantId: staff.tenantId ?? undefined,
      }

    await next()
  } catch (error) {
    return c.json({ error: 'Token inválido' }, 401)
  }
}
