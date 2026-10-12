import { Hono } from "hono"
import { drizzle } from "drizzle-orm/mysql2"
import { and, eq } from "drizzle-orm"
import { pool } from "../db"
import { events, eventTransports } from "../db/schema"
import { transportPassengerList } from "../lib/transports"

export const transportManifestsRoute = new Hono()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store")
    c.header("X-Robots-Tag", "noindex, nofollow")
    c.header("Referrer-Policy", "no-referrer")
    await next()
  })
  .get("/:token", async (c) => {
    const token = c.req.param("token")
    if (!/^[a-f0-9]{64}$/.test(token))
      return c.json({ error: "Este link no está disponible" }, 404)
    try {
      const db = drizzle(pool)
      const [row] = await db
        .select({
          id: eventTransports.id,
          eventId: eventTransports.eventId,
          tenantId: eventTransports.tenantId,
          name: eventTransports.name,
          address: eventTransports.address,
          latitude: eventTransports.latitude,
          longitude: eventTransports.longitude,
          eventName: events.name,
          eventDate: events.date
        })
        .from(eventTransports)
        .innerJoin(
          events,
          and(
            eq(events.id, eventTransports.eventId),
            eq(events.tenantId, eventTransports.tenantId)
          )
        )
        .where(eq(eventTransports.driverManifestToken, token))
        .limit(1)
      if (!row) return c.json({ error: "Este link no está disponible" }, 404)
      const bookings = await transportPassengerList(db, {
        tenantId: row.tenantId,
        eventId: row.eventId,
        transportId: row.id
      })
      return c.json({
        event: { id: row.eventId, name: row.eventName, date: row.eventDate },
        transport: {
          id: row.id,
          name: row.name,
          address: row.address,
          latitude: row.latitude,
          longitude: row.longitude
        },
        passengers: bookings.map((booking) => ({
          id: booking.id,
          name: booking.customerName,
          dni: booking.customerDni,
          phone: booking.customerPhone,
          quantity: booking.quantity,
          status: booking.status,
          boardedAt: booking.boardedAt
        }))
      })
    } catch {
      // Database diagnostics can contain the capability in query parameters.
      return c.json(
        { error: "No pudimos actualizar la lista de pasajeros" },
        503
      )
    }
  })
