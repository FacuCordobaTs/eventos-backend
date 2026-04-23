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
import { mpCreateCheckoutPreference } from "../lib/mp-checkout-api"
import { obtenerTokenValido } from "../lib/mercadopago-utils"
import { sendGuestCheckoutReceiptEmail } from "../lib/send-checkout-receipt-email"
import { PurchaseError, purchaseErrorStatus } from "../lib/ticket-purchase"
import { decFromDb } from "../lib/decimal-money"

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
  paymentMethod: z.enum(["CASH", "CARD", "MERCADOPAGO", "TRANSFER"]),
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

    if (body.paymentMethod === "MERCADOPAGO" || body.paymentMethod === "CARD") {
      const [evRow] = await db
        .select({ tenantId: events.tenantId })
        .from(events)
        .where(eq(events.id, body.eventId))
        .limit(1)
      if (!evRow) {
        return c.json({ error: "Evento no encontrado" }, 404)
      }
      const [tenantRow] = await db
        .select({ mpConnected: tenants.mpConnected })
        .from(tenants)
        .where(eq(tenants.id, evRow.tenantId))
        .limit(1)
      if (!tenantRow?.mpConnected) {
        return c.json(
          { error: "Mercado Pago no está conectado para esta productora." },
          400
        )
      }
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

      if (result.payOnReceipt) {
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

      if (result.pendingMercadoPago) {
        const accessToken = await obtenerTokenValido(result.tenantId)
        if (!accessToken) {
          await db
            .update(sales)
            .set({ status: "PAYMENT_FAILED" })
            .where(eq(sales.id, result.saleId))
          return c.json(
            { error: "No se pudo iniciar el pago con Mercado Pago." },
            502
          )
        }

        const [evName] = await db
          .select({ name: events.name })
          .from(events)
          .where(eq(events.id, body.eventId))
          .limit(1)
        const [saleRow] = await db
          .select({
            totalAmount: sales.totalAmount,
            receiptToken: sales.receiptToken,
          })
          .from(sales)
          .where(eq(sales.id, result.saleId))
          .limit(1)

        const notificationUrl =
          process.env.MP_NOTIFICATION_URL ?? "https://api.totem.uno/api/mp/webhook"
        const base = (
          process.env.CLIENT_APP_URL ??
          process.env.FRONTEND_URL ??
          "https://totem.uno"
        ).replace(/\/$/, "")
        const receiptUrl = `${base}/receipt/${saleRow?.receiptToken ?? result.receiptToken}`

        const unitPrice = decFromDb(saleRow?.totalAmount ?? "0").toNumber()
        const pref = await mpCreateCheckoutPreference({
          accessToken,
          items: [
            {
              title: `Totem · ${evName?.name ?? "Evento"}`,
              quantity: 1,
              unit_price: unitPrice,
              currency_id: "ARS",
            },
          ],
          externalReference: `totem-sale-${result.saleId}`,
          notificationUrl,
          marketplaceFee: 0,
          backUrls: {
            success: receiptUrl,
            failure: receiptUrl,
            pending: receiptUrl,
          },
        })

        if (!pref) {
          await db
            .update(sales)
            .set({ status: "PAYMENT_FAILED" })
            .where(eq(sales.id, result.saleId))
          return c.json(
            { error: "No se pudo crear la preferencia de pago en Mercado Pago." },
            502
          )
        }

        await db
          .update(sales)
          .set({ mpPreferenceId: pref.id })
          .where(eq(sales.id, result.saleId))

        return c.json(
          {
            message: "Redirigiendo a Mercado Pago",
            receiptToken: result.receiptToken,
            saleId: result.saleId,
            initPoint: pref.init_point,
            preferenceId: pref.id,
            mercadoPago: true,
          },
          201
        )
      }

      void sendGuestCheckoutReceiptEmail({
        db,
        eventId: body.eventId,
        saleId: result.saleId,
        receiptToken: result.receiptToken,
        contact: {
          name: body.contact.name,
          email: body.contact.email,
        },
      }).catch((err) => {
        console.error("[checkout-email] Failed to send receipt email:", err)
      })

      return c.json(
        {
          message: "Compra registrada",
          receiptToken: result.receiptToken,
          saleId: result.saleId,
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
