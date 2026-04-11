import { Hono } from "hono";
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { staff, tenants } from '../db/schema'
import { v4 as uuidv4 } from 'uuid'
import { setCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { createAccessToken } from '../lib/jwt'
import * as bcrypt from 'bcrypt'

const signupStaffSchema = z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    password: z.string(),
})

const loginStaffSchema = z.object({
  email: z.string(),
  password: z.string()
})

const newStaffSchema = z.object({
  
})

export const staffRoute = new Hono()
.get("/", (c) => {
    return c.json({
        message: "Hello World"
    })
})
.post("/register-admin", zValidator('json', signupStaffSchema), async (c) => {
    const db = drizzle(pool)
    const newStaff = c.req.valid('json')

    const existingStaff = await db.select().from(staff).where(eq(staff.email, newStaff.email))

    if (existingStaff.length) {
      return c.json({ error: 'Email ya utilizado' }, 409);
  }

    const passwordHash = await bcrypt.hash(newStaff.password, 10)
    const result = await db.insert(staff).values({
        id: uuidv4(),
        name: newStaff.name,
        email: newStaff.email,
        passwordHash: passwordHash,
        role: 'ADMIN',
        createdAt: new Date(),
    })

    const newStaffResult = await db.select().from(staff).where(eq(staff.email, newStaff.email))
    const token = await createAccessToken({ id: newStaffResult[0].id })

    setCookie(c, 'token', token as string, {
      path: '/',
      sameSite: 'None',
      secure: true,
      maxAge: 365 * 24 * 60 * 60,
  });
    return c.json({ message: 'Administrador registrado correctamente', staff: newStaffResult[0] }, 201);
})

.post("/login", zValidator('json', loginStaffSchema), async (c) => {
  const db = drizzle(pool)
  const loginStaff = c.req.valid('json')

  const existingStaff = await db.select().from(staff).where(eq(staff.email, loginStaff.email))

  if (!existingStaff.length) {
    return c.json({ error: 'Email o contraseña incorrectos' }, 401);
  }

  const passwordMatch = await bcrypt.compare(loginStaff.password, existingStaff[0].passwordHash)
  if (!passwordMatch) {
    return c.json({ error: 'Email o contraseña incorrectos' }, 401);
  }
  const token = await createAccessToken({ id: existingStaff[0].id })
  setCookie(c, 'token', token as string, {
    path: '/',
    sameSite: 'None',
    secure: true,
    maxAge: 365 * 24 * 60 * 60,
  });
  return c.json({ message: 'Inicio de sesión exitoso', staff: existingStaff[0] }, 200);
})

.post("/new")