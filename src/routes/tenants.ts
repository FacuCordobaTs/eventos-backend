import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { tenants } from '../db/schema'
import { v4 as uuidv4 } from 'uuid'


const tenantSchema = z.object({
    id: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
})

export const tenantsRoute = new Hono()
.get("/", (c) => {
    return c.json({
        message: "Hello World"
    })
})

.post("/", zValidator('json', tenantSchema), async (c) => {
    const db = drizzle(pool)
    const tenant = c.req.valid('json')
    const result = await db.insert(tenants).values({
        id: uuidv4(),
        name: tenant.name,
        isActive: tenant.isActive,
        createdAt: new Date(),
        updatedAt: new Date(),
    })
    return c.json(result)
})