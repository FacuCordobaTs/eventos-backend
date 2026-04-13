import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import {
  customers,
  digitalConsumptions,
  events,
  products,
  tenants,
  ticketTypes,
  tickets,
} from "../db/schema"
import { and, desc, eq, inArray, ne, or } from "drizzle-orm"
import { clientAuthMiddleware, type ClientAuthContext } from "../middleware/client-auth"
import {
  executeClientCheckout,
  type ClientCheckoutDrinkLine,
  type ClientCheckoutTicketLine,
} from "../lib/client-checkout"
import { PurchaseError, purchaseErrorStatus } from "../lib/ticket-purchase"

const checkoutSchema = z.object({
  eventId: z.string().min(1),
  ticketLines: z
    .array(
      z.object({
        ticketTypeId: z.string().min(1),
        quantity: z.number().int().positive(),
      })
    )
    .min(1),
  drinkLines: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().positive(),
      })
    )
    .optional()
    .default([]),
})

export const meRoute = new Hono()
  .use(clientAuthMiddleware)
  .get("/profile", async (c) => {
    const ctx = c as ClientAuthContext
    const db = drizzle(pool)

    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, ctx.customer.id))
      .limit(1)

    if (!row) {
      return c.json({ error: "Usuario no encontrado" }, 404)
    }

    return c.json({
      customer: {
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        createdAt: row.createdAt,
      },
    })
  })
  .get("/wallet/tickets", async (c) => {
    const ctx = c as ClientAuthContext
    const db = drizzle(pool)

    const rows = await db
      .select({
        ticket: tickets,
        ticketTypeName: ticketTypes.name,
        ticketTypePrice: ticketTypes.price,
        eventName: events.name,
        eventDate: events.date,
        eventLocation: events.location,
        productoraName: tenants.name,
      })
      .from(tickets)
      .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
      .innerJoin(events, eq(tickets.eventId, events.id))
      .innerJoin(tenants, eq(tickets.tenantId, tenants.id))
      .where(
        and(
          eq(tickets.customerId, ctx.customer.id),
          ne(tickets.status, "CANCELLED"),
          or(eq(tickets.status, "PENDING"), eq(tickets.status, "USED"))
        )
      )
      .orderBy(desc(events.date), desc(tickets.createdAt))

    return c.json({
      tickets: rows.map((r) => ({
        id: r.ticket.id,
        qrHash: r.ticket.qrHash,
        status: r.ticket.status,
        scannedAt: r.ticket.scannedAt,
        createdAt: r.ticket.createdAt,
        ticketType: {
          name: r.ticketTypeName,
          price: r.ticketTypePrice,
        },
        event: {
          id: r.ticket.eventId,
          name: r.eventName,
          date: r.eventDate,
          location: r.eventLocation,
        },
        productora: { name: r.productoraName },
      })),
    })
  })
  .get("/wallet/consumptions", async (c) => {
    const ctx = c as ClientAuthContext
    const db = drizzle(pool)

    const rows = await db
      .select({
        consumption: digitalConsumptions,
        productName: products.name,
        productPrice: products.price,
        eventName: events.name,
        eventDate: events.date,
        productoraName: tenants.name,
      })
      .from(digitalConsumptions)
      .innerJoin(products, eq(digitalConsumptions.productId, products.id))
      .innerJoin(events, eq(digitalConsumptions.eventId, events.id))
      .innerJoin(tenants, eq(digitalConsumptions.tenantId, tenants.id))
      .where(
        and(
          eq(digitalConsumptions.customerId, ctx.customer.id),
          ne(digitalConsumptions.status, "CANCELLED"),
          or(
            eq(digitalConsumptions.status, "PENDING"),
            eq(digitalConsumptions.status, "REDEEMED")
          )
        )
      )
      .orderBy(desc(events.date), desc(digitalConsumptions.createdAt))

    return c.json({
      consumptions: rows.map((r) => ({
        id: r.consumption.id,
        qrHash: r.consumption.qrHash,
        status: r.consumption.status,
        redeemedAt: r.consumption.redeemedAt,
        createdAt: r.consumption.createdAt,
        product: {
          id: r.consumption.productId,
          name: r.productName,
          price: r.productPrice,
        },
        event: {
          id: r.consumption.eventId,
          name: r.eventName,
          date: r.eventDate,
        },
        productora: { name: r.productoraName },
      })),
    })
  })
  .post("/checkout", zValidator("json", checkoutSchema), async (c) => {
    const ctx = c as ClientAuthContext
    const body = c.req.valid("json")
    const db = drizzle(pool)

    try {
      const result = await db.transaction(async (tx) =>
        executeClientCheckout(tx, {
          eventId: body.eventId,
          customerId: ctx.customer.id,
          customerName: ctx.customer.name,
          customerEmail: ctx.customer.email,
          ticketLines: body.ticketLines as ClientCheckoutTicketLine[],
          drinkLines: (body.drinkLines ?? []) as ClientCheckoutDrinkLine[],
        })
      )

      const ticketRows =
        result.ticketIds.length > 0
          ? await db.select().from(tickets).where(inArray(tickets.id, result.ticketIds))
          : []

      return c.json(
        {
          message: "Compra registrada",
          saleId: result.saleId,
          ticketIds: result.ticketIds,
          consumptionIds: result.consumptionIds,
          tickets: ticketRows.map((t) => ({
            id: t.id,
            qrHash: t.qrHash,
            status: t.status,
            eventId: t.eventId,
          })),
        },
        201
      )
    } catch (e) {
      if (e instanceof PurchaseError) {
        const { status, body: errBody } = purchaseErrorStatus(e.code)
        return c.json(errBody, status)
      }
      throw e
    }
  })
