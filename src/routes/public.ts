import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import {
  digitalConsumptions,
  eventProducts,
  events,
  products,
  sales,
  tenants,
  ticketTypes,
  tickets,
} from "../db/schema"
import { SQL, and, asc, count, eq, gte, ne } from "drizzle-orm"
import { executeClientCheckout } from "../lib/client-checkout"
import { asignarAliasASale } from "../lib/cucuru-service"
import { PurchaseError, purchaseErrorStatus } from "../lib/ticket-purchase"

async function countIssued(
  db: ReturnType<typeof drizzle>,
  tenantId: string,
  ticketTypeId: string
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(tickets)
    .where(
      and(
        eq(tickets.tenantId, tenantId),
        eq(tickets.ticketTypeId, ticketTypeId),
        ne(tickets.status, "CANCELLED")
      )
    )
  return Number(row?.n ?? 0)
}

const guestCheckoutSchema = z.object({
  eventId: z.string().min(1),
  paymentMethod: z.enum(["TRANSFER", "CARD", "MERCADOPAGO"]),
  clientTotal: z.string().min(1),
  contact: z.object({
    name: z.string().min(1).max(255),
    email: z.string().email(),
    phone: z.string().min(1).max(255),
  }),
  ticketLines: z
    .array(
      z.object({
        ticketTypeId: z.string().min(1),
        quantity: z.number().int().positive(),
      })
    )
    .default([]),
  drinkLines: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().positive(),
      })
    )
    .default([]),
})

/** Segment for Cucuru alias (`totem.${slug}.${seq}`): ASCII a-z0-9 only, max 12 chars. */
function slugifyForCucuruAliasSegment(raw: string): string {
  const base = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 12)
  return base.length > 0 ? base : "x"
}

function mapAsignarAliasError(reason: string): string {
  switch (reason) {
    case "cucuru_disabled":
      return "Los cobros por transferencia no están habilitados para esta productora."
    case "missing_credentials":
      return "La productora no tiene configurado Cucuru."
    case "tenant_or_sale_not_found":
      return "No se pudo vincular la venta con Cucuru."
    default:
      return "No se pudo generar el alias de cobro. Intentá de nuevo más tarde."
  }
}

export const publicRoute = new Hono()
  .get("/events", async (c) => {
    const db = drizzle(pool)
    const tenantFilter = c.req.query("productoraId")

    const filters: SQL[] = [
      eq(events.isActive, true),
      eq(tenants.isActive, true),
      gte(events.date, new Date()),
    ]
    if (tenantFilter != null && tenantFilter !== "") {
      filters.push(eq(events.tenantId, tenantFilter))
    }

    const rows = await db
      .select({
        id: events.id,
        name: events.name,
        date: events.date,
        location: events.location,
        tenantId: events.tenantId,
        productoraName: tenants.name,
      })
      .from(events)
      .innerJoin(tenants, eq(events.tenantId, tenants.id))
      .where(and(...filters))
      .orderBy(asc(events.date))

    return c.json({
      events: rows.map((r) => ({
        id: r.id,
        name: r.name,
        date: r.date,
        location: r.location,
        productora: { id: r.tenantId, name: r.productoraName },
      })),
    })
  })
  .get("/events/:id", async (c) => {
    const eventId = c.req.param("id")
    const db = drizzle(pool)

    const [ev] = await db.select().from(events).where(eq(events.id, eventId)).limit(1)
    if (!ev || ev.isActive === false) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const [productoraRow] = await db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, ev.tenantId))
      .limit(1)

    const types = await db
      .select()
      .from(ticketTypes)
      .where(
        and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.tenantId, ev.tenantId))
      )

    const consumptionRows = await db
      .select({
        id: products.id,
        name: products.name,
        priceOverride: eventProducts.priceOverride,
        basePrice: products.price,
      })
      .from(eventProducts)
      .innerJoin(products, eq(eventProducts.productId, products.id))
      .where(
        and(
          eq(eventProducts.eventId, eventId),
          eq(eventProducts.tenantId, ev.tenantId),
          eq(eventProducts.isActive, true),
          eq(products.tenantId, ev.tenantId),
          eq(products.isActive, true)
        )
      )
      .orderBy(products.name)

    const ticketTypesOut = []
    for (const t of types) {
      const sold = await countIssued(db, ev.tenantId, t.id)
      const limit = t.stockLimit
      const remaining = limit == null ? null : Math.max(0, limit - sold)
      ticketTypesOut.push({
        id: t.id,
        name: t.name,
        price: t.price,
        stockLimit: t.stockLimit,
        sold,
        remaining,
        availableForPurchase: limit == null || sold < limit,
      })
    }

    const drinkProducts = consumptionRows.map((r) => ({
      id: r.id,
      name: r.name,
      price:
        r.priceOverride != null && r.priceOverride !== ""
          ? r.priceOverride
          : r.basePrice,
    }))

    return c.json({
      productora: {
        id: ev.tenantId,
        name: productoraRow?.name ?? "Productora",
      },
      event: {
        id: ev.id,
        name: ev.name,
        date: ev.date,
        location: ev.location,
        imageUrl: ev.imageUrl ?? null,
        ticketsAvailableFrom: ev.ticketsAvailableFrom ?? null,
        consumptionsAvailableFrom: ev.consumptionsAvailableFrom ?? null,
      },
      ticketTypes: ticketTypesOut,
      drinkProducts,
    })
  })
  .post("/checkout", zValidator("json", guestCheckoutSchema), async (c) => {
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const [paymentCtx] = await db
      .select({
        tenantId: events.tenantId,
        cucuruEnabled: tenants.cucuruEnabled,
        mpConnected: tenants.mpConnected,
      })
      .from(events)
      .innerJoin(tenants, eq(events.tenantId, tenants.id))
      .where(eq(events.id, body.eventId))
      .limit(1)

    if (!paymentCtx) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }
    if (body.paymentMethod === "TRANSFER" && !paymentCtx.cucuruEnabled) {
      return c.json(
        { error: "Los cobros por transferencia no están disponibles para este evento." },
        400
      )
    }
    if (
      (body.paymentMethod === "CARD" || body.paymentMethod === "MERCADOPAGO") &&
      !paymentCtx.mpConnected
    ) {
      return c.json(
        { error: "Mercado Pago no está habilitado para este evento" },
        400
      )
    }

    try {
      const result = await db.transaction(async (tx) =>
        executeClientCheckout(tx, {
          eventId: body.eventId,
          contact: {
            name: body.contact.name,
            email: body.contact.email,
            phone: body.contact.phone,
          },
          paymentMethod: body.paymentMethod,
          clientTotal: body.clientTotal.trim(),
          ticketLines: body.ticketLines ?? [],
          drinkLines: body.drinkLines ?? [],
        })
      )

      if (body.paymentMethod === "CARD" || body.paymentMethod === "MERCADOPAGO") {
        return c.json(
          {
            message: "Pendiente de pago",
            receiptToken: result.receiptToken,
            saleId: result.saleId,
            payOnReceipt: true,
          },
          201
        )
      }

      if (!result.payOnReceipt) {
        return c.json({ error: "No se pudo iniciar el checkout." }, 500)
      }

      const [slugCtx] = await db
        .select({
          productoraName: tenants.name,
          eventName: events.name,
        })
        .from(events)
        .innerJoin(tenants, eq(events.tenantId, tenants.id))
        .where(
          and(eq(events.id, body.eventId), eq(tenants.id, result.tenantId))
        )
        .limit(1)

      const slugSource = (slugCtx?.productoraName ?? slugCtx?.eventName ?? "tenant").trim()
      const tenantSlug = slugifyForCucuruAliasSegment(slugSource)

      const aliasRes = await asignarAliasASale(result.saleId, result.tenantId, tenantSlug)
      if ("ok" in aliasRes && aliasRes.ok === false) {
        await db
          .update(sales)
          .set({ status: "PAYMENT_FAILED" })
          .where(
            and(eq(sales.id, result.saleId), eq(sales.tenantId, result.tenantId))
          )
        return c.json(
          { error: mapAsignarAliasError(aliasRes.reason) },
          502
        )
      }

      const { alias, accountNumber } = aliasRes

      await db
        .update(sales)
        .set({
          cucuruAlias: alias,
          cucuruCvu: accountNumber,
        })
        .where(
          and(eq(sales.id, result.saleId), eq(sales.tenantId, result.tenantId))
        )

      return c.json(
        {
          message: "Pendiente de pago",
          receiptToken: result.receiptToken,
          saleId: result.saleId,
          payOnReceipt: true,
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
  .get("/receipts/:token", async (c) => {
    const token = c.req.param("token")
    const db = drizzle(pool)

    const [header] = await db
      .select({
        sale: sales,
        eventName: events.name,
        eventDate: events.date,
        eventLocation: events.location,
        productoraName: tenants.name,
        mpPublicKey: tenants.mpPublicKey,
      })
      .from(sales)
      .innerJoin(events, eq(sales.eventId, events.id))
      .innerJoin(tenants, eq(sales.tenantId, tenants.id))
      .where(eq(sales.receiptToken, token))
      .limit(1)

    if (!header) {
      return c.json({ error: "Comprobante no encontrado" }, 404)
    }

    const saleId = header.sale.id

    const [ticketRows, consumptionRows] = await Promise.all([
      db
        .select({
          id: tickets.id,
          qrHash: tickets.qrHash,
          status: tickets.status,
          ticketTypeName: ticketTypes.name,
          ticketTypePrice: ticketTypes.price,
        })
        .from(tickets)
        .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
        .where(
          and(eq(tickets.saleId, saleId), eq(tickets.tenantId, header.sale.tenantId))
        )
        .orderBy(ticketTypes.name, tickets.createdAt),
      db
        .select({
          id: digitalConsumptions.id,
          qrHash: digitalConsumptions.qrHash,
          status: digitalConsumptions.status,
          productId: digitalConsumptions.productId,
          productName: products.name,
          productPrice: products.price,
        })
        .from(digitalConsumptions)
        .innerJoin(products, eq(digitalConsumptions.productId, products.id))
        .where(
          and(
            eq(digitalConsumptions.saleId, saleId),
            eq(digitalConsumptions.tenantId, header.sale.tenantId)
          )
        )
        .orderBy(products.name, digitalConsumptions.createdAt),
    ])

    return c.json({
      receiptToken: header.sale.receiptToken,
      sale: {
        id: header.sale.id,
        totalAmount: header.sale.totalAmount,
        paymentMethod: header.sale.paymentMethod,
        status: header.sale.status,
        createdAt: header.sale.createdAt,
        paid: Boolean(header.sale.paid),
        paidAt: header.sale.paidAt ?? null,
        cucuruAlias: header.sale.cucuruAlias ?? null,
        cucuruCvu: header.sale.cucuruCvu ?? null,
      },
      event: {
        id: header.sale.eventId,
        name: header.eventName,
        date: header.eventDate,
        location: header.eventLocation,
      },
      productora: {
        name: header.productoraName,
        mpPublicKey: header.mpPublicKey ?? null,
      },
      tickets: ticketRows.map((r) => ({
        id: r.id,
        qrHash: r.qrHash,
        status: r.status,
        ticketType: { name: r.ticketTypeName, price: r.ticketTypePrice },
      })),
      consumptions: consumptionRows.map((r) => ({
        id: r.id,
        qrHash: r.qrHash,
        status: r.status,
        product: { id: r.productId, name: r.productName, price: r.productPrice },
      })),
    })
  })
