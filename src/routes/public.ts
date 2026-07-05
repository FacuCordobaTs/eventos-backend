import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import {
  digitalConsumptions,
  eventProducts,
  events,
  productCategories,
  products,
  sales,
  tenants,
  ticketTypes,
  tickets,
} from "../db/schema"
import { SQL, and, asc, count, eq, gte, inArray, ne, or } from "drizzle-orm"
import { executeClientCheckout } from "../lib/client-checkout"
import { asignarAliasASale } from "../lib/cucuru-service"
import { PurchaseError, purchaseErrorStatus } from "../lib/ticket-purchase"
import { obtenerTokenValido } from "../lib/mercadopago-utils"

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
    const slugOrId = c.req.param("id")
    const db = drizzle(pool)

    console.log("slugOrId")
    console.log(slugOrId)

    const [ev] = await db
      .select()
      .from(events)
      .where(or(eq(events.id, slugOrId), eq(events.slug, slugOrId)))
      .limit(1)

    console.log("ev")
    console.log(ev)

    if (!ev || ev.isActive === false) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const [productoraRow] = await db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, ev.tenantId))
      .limit(1)

    console.log("productoraRow")
    console.log(productoraRow)

    const types = await db
      .select()
      .from(ticketTypes)
      .where(
        and(eq(ticketTypes.eventId, ev.id), eq(ticketTypes.tenantId, ev.tenantId))
      )

    console.log("types")
    console.log(types)

    const consumptionRows = await db
      .select({
        id: products.id,
        name: products.name,
        saleType: products.saleType,
        productImageUrl: products.imageUrl,
        priceOverride: eventProducts.priceOverride,
        basePrice: products.price,
        categoryId: products.categoryId,
        categoryName: productCategories.name,
        categorySortOrder: productCategories.sortOrder,
      })
      .from(eventProducts)
      .innerJoin(products, eq(eventProducts.productId, products.id))
      .leftJoin(
        productCategories,
        and(
          eq(productCategories.id, products.categoryId),
          eq(productCategories.isActive, true)
        )
      )
      .where(
        and(
          eq(eventProducts.eventId, ev.id),
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

    console.log("ticketTypesOut")
    console.log(ticketTypesOut)

    const drinkProducts = consumptionRows.map((r) => ({
      id: r.id,
      name: r.name,
      saleType: r.saleType,
      imageUrl: r.productImageUrl ?? null,
      categoryId: r.categoryId ?? null,
      categoryName: r.categoryName ?? null,
      price:
        r.priceOverride != null && r.priceOverride !== ""
          ? r.priceOverride
          : r.basePrice,
    }))

    // Categorías presentes entre los productos del evento, ordenadas.
    const categoryMap = new Map<
      string,
      { id: string; name: string; sortOrder: number }
    >()
    for (const r of consumptionRows) {
      if (r.categoryId && r.categoryName && !categoryMap.has(r.categoryId)) {
        categoryMap.set(r.categoryId, {
          id: r.categoryId,
          name: r.categoryName,
          sortOrder: r.categorySortOrder ?? 0,
        })
      }
    }
    const productCategoriesOut = [...categoryMap.values()].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
    )

    console.log("drinkProducts")
    console.log(drinkProducts)

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
        designType: ev.designType ?? "GLASS",
        ticketsAvailableFrom: ev.ticketsAvailableFrom ?? null,
        consumptionsAvailableFrom: ev.consumptionsAvailableFrom ?? null,
      },
      ticketTypes: ticketTypesOut,
      drinkProducts,
      productCategories: productCategoriesOut,
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
          transfer: { alias, accountNumber },
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

    const consumptionShape = {
      id: digitalConsumptions.id,
      qrHash: digitalConsumptions.qrHash,
      status: digitalConsumptions.status,
      productId: digitalConsumptions.productId,
      productName: products.name,
      productPrice: products.price,
    }

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
        .select(consumptionShape)
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

    // Addon consumptions: other paid sales for same customer+event
    let addonConsumptionRows: typeof consumptionRows = []
    if (header.sale.customerId) {
      const addonSaleIds = (
        await db
          .select({ id: sales.id })
          .from(sales)
          .where(
            and(
              eq(sales.customerId, header.sale.customerId),
              eq(sales.eventId, header.sale.eventId),
              eq(sales.status, "COMPLETED"),
              ne(sales.id, saleId)
            )
          )
      ).map((r) => r.id)

      if (addonSaleIds.length > 0) {
        addonConsumptionRows = await db
          .select(consumptionShape)
          .from(digitalConsumptions)
          .innerJoin(products, eq(digitalConsumptions.productId, products.id))
          .where(
            and(
              inArray(digitalConsumptions.saleId, addonSaleIds),
              eq(digitalConsumptions.tenantId, header.sale.tenantId)
            )
          )
          .orderBy(digitalConsumptions.createdAt)
      }
    }

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
      consumptions: [
        ...addonConsumptionRows.map((r) => ({
          id: r.id,
          qrHash: r.qrHash,
          status: r.status,
          product: { id: r.productId, name: r.productName, price: r.productPrice },
          isAddon: true as const,
        })),
        ...consumptionRows.map((r) => ({
          id: r.id,
          qrHash: r.qrHash,
          status: r.status,
          product: { id: r.productId, name: r.productName, price: r.productPrice },
          isAddon: false as const,
        })),
      ],
    })
  })
  .post("/receipts/:token/consumptions-checkout", async (c) => {
    const token = c.req.param("token")
    const db = drizzle(pool)

    let body: { drinkLines: { productId: string; quantity: number }[]; clientTotal: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "JSON inválido" }, 400)
    }

    if (!body.drinkLines?.length || !body.clientTotal) {
      return c.json({ error: "Datos incompletos" }, 400)
    }

    const [saleRow] = await db
      .select()
      .from(sales)
      .where(eq(sales.receiptToken, token))
      .limit(1)

    if (!saleRow) return c.json({ error: "Comprobante no encontrado" }, 404)
    if (!saleRow.paid) return c.json({ error: "La compra original no está confirmada" }, 400)

    const snap = saleRow.guestCheckoutSnapshot
    if (!snap?.contact) {
      return c.json({ error: "No hay datos de contacto en esta compra" }, 400)
    }

    const [tenant] = await db
      .select({ mpConnected: tenants.mpConnected })
      .from(tenants)
      .where(eq(tenants.id, saleRow.tenantId))
      .limit(1)

    if (!tenant?.mpConnected) {
      return c.json({ error: "Mercado Pago no está habilitado para este evento" }, 400)
    }

    let result: Awaited<ReturnType<typeof executeClientCheckout>>
    try {
      result = await db.transaction(async (tx) =>
        executeClientCheckout(tx, {
          eventId: saleRow.eventId,
          contact: snap.contact,
          paymentMethod: "MERCADOPAGO",
          clientTotal: body.clientTotal.trim(),
          ticketLines: [],
          drinkLines: body.drinkLines,
        })
      )
    } catch (e) {
      if (e instanceof PurchaseError) {
        const { status, body: errBody } = purchaseErrorStatus(e.code)
        return c.json(errBody, status)
      }
      throw e
    }

    const mpAccessToken = await obtenerTokenValido(saleRow.tenantId)
    if (!mpAccessToken) {
      return c.json({ error: "No se pudo conectar con Mercado Pago" }, 502)
    }

    const total = parseFloat(body.clientTotal)
    const fee = Math.round(total * 0.01 * 100) / 100

    const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mpAccessToken}`,
      },
      body: JSON.stringify({
        items: [{ title: "Consumos", quantity: 1, currency_id: "ARS", unit_price: total }],
        marketplace_fee: fee,
        back_urls: {
          success: `https://totem.uno/receipt/${token}`,
          failure: `https://totem.uno/receipt/${token}`,
          pending: `https://totem.uno/receipt/${token}`,
        },
        auto_return: "approved",
        external_reference: `totem-sale-${result.saleId}`,
        notification_url: "https://api.totem.uno/api/mp/webhook",
        statement_descriptor: "TOTEM",
        expires: true,
        expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    })

    if (!mpRes.ok) {
      return c.json({ error: "No se pudo crear la preferencia de Mercado Pago" }, 500)
    }

    const preference = (await mpRes.json()) as { init_point?: string }
    if (!preference.init_point) {
      return c.json({ error: "No se pudo obtener el link de pago" }, 500)
    }

    return c.json({ success: true, url_pago: preference.init_point })
  })
