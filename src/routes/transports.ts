import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import { randomBytes, randomUUID } from "node:crypto"
import { pool } from "../db"
import { events, eventTransports } from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { transportPassengerList, transportSchema } from "../lib/transports"
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
    const bookings = await transportPassengerList(db, { tenantId, eventId })
    return c.json({ transports, bookings })
  })
  .post("/:eventId/:transportId/driver-link", async (c) => {
    const tenantId = (c as unknown as AuthenticatedContext).staff.tenantId!
    const eventId = c.req.param("eventId")
    const transportId = c.req.param("transportId")
    const db = drizzle(pool)
    const token = await db.transaction(async (tx) => {
      const scope = and(
        eq(eventTransports.id, transportId),
        eq(eventTransports.eventId, eventId),
        eq(eventTransports.tenantId, tenantId)
      )
      const [transport] = await tx
        .select()
        .from(eventTransports)
        .where(scope)
        .limit(1)
        .for("update")
      if (!transport) return null
      if (transport.driverManifestToken) return transport.driverManifestToken
      const token = randomBytes(32).toString("hex")
      await tx
        .update(eventTransports)
        .set({ driverManifestToken: token })
        .where(scope)
      return token
    })
    if (!token) return c.json({ error: "Transporte no encontrado" }, 404)
    c.header("Cache-Control", "no-store")
    return c.json({ token })
  })
  .delete("/:eventId/:transportId/driver-link", async (c) => {
    const tenantId = (c as unknown as AuthenticatedContext).staff.tenantId!
    const eventId = c.req.param("eventId")
    const transportId = c.req.param("transportId")
    const db = drizzle(pool)
    const found = await db.transaction(async (tx) => {
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
        .for("update")
      if (!transport) return false
      await tx
        .update(eventTransports)
        .set({ driverManifestToken: null })
        .where(scope)
      return true
    })
    if (!found) return c.json({ error: "Transporte no encontrado" }, 404)
    return c.json({ disabled: true })
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
      const id = randomUUID()
      await tx.insert(eventTransports).values({
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
      return c.json({ id: transportId })
    }
  )
