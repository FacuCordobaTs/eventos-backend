import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import { randomUUID } from "node:crypto"
import { pool } from "../db"
import {
  customers,
  events,
  eventTransports,
  sales,
  saleTransports
} from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { transportSchema } from "../lib/transports"
import { decToDb, dec } from "../lib/decimal-money"

export const transportsRoute = new Hono()
  .use("*", authMiddleware)
  .use("*", async (c, next) => {
    const { staff } = c as unknown as AuthenticatedContext
    if (!staff.tenantId || !["ADMIN", "MANAGER"].includes(staff.role)) {
      return c.json(
        { error: "No tenés permiso para administrar transportes" },
        403
      )
    }
    await next()
  })
  .get("/:eventId", async (c) => {
    const tenantId = (c as unknown as AuthenticatedContext).staff.tenantId!
    const eventId = c.req.param("eventId")
    const db = drizzle(pool)
    const [event] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
      .limit(1)
    if (!event) return c.json({ error: "Evento no encontrado" }, 404)
    const transports = await db
      .select()
      .from(eventTransports)
      .where(
        and(
          eq(eventTransports.eventId, eventId),
          eq(eventTransports.tenantId, tenantId)
        )
      )
      .orderBy(eventTransports.createdAt)
    const bookings = await db
      .select({
        id: saleTransports.id,
        transportId: saleTransports.transportId,
        name: saleTransports.name,
        quantity: saleTransports.quantity,
        price: saleTransports.priceAtTime,
        customerName: customers.name,
        customerDni: customers.dni,
        customerPhone: customers.phone
      })
      .from(saleTransports)
      .innerJoin(sales, eq(sales.id, saleTransports.saleId))
      .innerJoin(customers, eq(customers.id, sales.customerId))
      .where(
        and(
          eq(saleTransports.tenantId, tenantId),
          eq(saleTransports.eventId, eventId),
          eq(sales.tenantId, tenantId),
          eq(sales.eventId, eventId),
          eq(sales.status, "COMPLETED")
        )
      )
    return c.json({ transports, bookings })
  })
  .post("/:eventId", zValidator("json", transportSchema), async (c) => {
    const tenantId = (c as unknown as AuthenticatedContext).staff.tenantId!
    const eventId = c.req.param("eventId")
    const input = c.req.valid("json")
    const db = drizzle(pool)
    const outcome = await db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(events)
        .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
        .limit(1)
        .for("update")
      if (!event) return "missing" as const
      if (event.status === "closed") return "closed" as const
      const id = randomUUID()
      await tx
        .insert(eventTransports)
        .values({
          ...input,
          id,
          tenantId,
          eventId,
          price: decToDb(dec(input.price)),
          latitude: input.latitude.toFixed(7),
          longitude: input.longitude.toFixed(7)
        })
      return { id }
    })
    if (outcome === "missing")
      return c.json({ error: "Evento no encontrado" }, 404)
    if (outcome === "closed")
      return c.json({ error: "El evento ya está cerrado" }, 409)
    return c.json(outcome, 201)
  })
  .put(
    "/:eventId/:transportId",
    zValidator("json", transportSchema),
    async (c) => {
      const tenantId = (c as unknown as AuthenticatedContext).staff.tenantId!
      const eventId = c.req.param("eventId")
      const transportId = c.req.param("transportId")
      const input = c.req.valid("json")
      const db = drizzle(pool)
      const outcome = await db.transaction(async (tx) => {
        const [event] = await tx
          .select()
          .from(events)
          .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
          .limit(1)
          .for("update")
        if (!event) return "missing"
        if (event.status === "closed") return "closed"
        const scope = and(
          eq(eventTransports.id, transportId),
          eq(eventTransports.eventId, eventId),
          eq(eventTransports.tenantId, tenantId)
        )
        const [transport] = await tx
          .select({ id: eventTransports.id })
          .from(eventTransports)
          .where(scope)
          .limit(1)
        if (!transport) return "missing"
        await tx
          .update(eventTransports)
          .set({
            ...input,
            price: decToDb(dec(input.price)),
            latitude: input.latitude.toFixed(7),
            longitude: input.longitude.toFixed(7)
          })
          .where(scope)
        return "ok"
      })
      if (outcome === "missing")
        return c.json({ error: "Transporte o evento no encontrado" }, 404)
      if (outcome === "closed")
        return c.json({ error: "El evento ya está cerrado" }, 409)
      return c.json({ id: transportId })
    }
  )
