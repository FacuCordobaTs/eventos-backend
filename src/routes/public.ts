import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { drizzle } from "drizzle-orm/mysql2"
import { pool } from "../db"
import {
  courtesies,
  customers,
  digitalConsumptions,
  eventProducts,
  events,
  pickupOrders,
  productCategories,
  products,
  sales,
  tenants,
  ticketTypes,
  tickets,
} from "../db/schema"
import type { PickupItemsJson } from "../db/schema"
import { SQL, and, asc, count, desc, eq, gte, inArray, ne, or } from "drizzle-orm"
import { executeClientCheckout, findOrCreateCustomer } from "../lib/client-checkout"
import { asignarAliasASale } from "../lib/cucuru-service"
import { getBalance } from "../lib/balance"
import { pickupItemsWithNames } from "../lib/pickup-items"
import { PurchaseError, purchaseErrorStatus } from "../lib/ticket-purchase"
import { dec, decToDb } from "../lib/decimal-money"
import { obtenerTokenValido } from "../lib/mercadopago-utils"
import { qrCodeDataUrl } from "../lib/qr"
import { v4 as uuidv4 } from "uuid"
import { randomUUID } from "node:crypto"
import { sendCustomerProfileEmail } from "../lib/send-customer-profile-email"
import { broadcastReceiptUpdate } from "../lib/public-qr-broadcast"
import {
  CUSTOMER_PROFILE_TEMPLATE,
  normalizeWhatsAppPhone,
  sendWhatsAppTemplateMessage,
} from "../lib/whatsapp-service"
import { eventSupportsConsumptions } from "../lib/event-operation-mode"

const customerAccessSchema = z.object({
  type: z.enum(["email", "phone", "dni"]),
  value: z.string().trim().min(1).max(255),
})

const CLIENT_URL = (process.env.FRONTEND_URL ?? "https://crow.ar").replace(/\/$/, "")

function isDeliverableEmail(email: string): boolean {
  return !email.toLowerCase().endsWith("@crow.local")
}

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

/**
 * Tarea 7.1 — Los QRs de los tragos de regalo de una cortesía (consumiciones emitidas por el
 * canje, ancladas a su sale de $0). Usado por el GET (volver a ver tras canjear) y por el
 * redeem (resultado del canje). Una fila por unidad canjeable, como en el comprobante.
 */
async function courtesyDrinkQrs(
  db: ReturnType<typeof drizzle>,
  saleId: string,
  tenantId: string
): Promise<
  { id: string; qrHash: string; qrDataUrl: string; productName: string }[]
> {
  const rows = await db
    .select({
      id: digitalConsumptions.id,
      qrHash: digitalConsumptions.qrHash,
      productName: products.name,
    })
    .from(digitalConsumptions)
    .innerJoin(products, eq(digitalConsumptions.productId, products.id))
    .where(
      and(
        eq(digitalConsumptions.saleId, saleId),
        eq(digitalConsumptions.tenantId, tenantId)
      )
    )
    .orderBy(products.name, digitalConsumptions.createdAt)
  return Promise.all(
    rows.map(async (r) => ({ ...r, qrDataUrl: await qrCodeDataUrl(r.qrHash) }))
  )
}

/** Pedido de retiro (tarea 4.1): qué consumiciones PENDING del comprobante se llevan ahora. */
const pickupCreateSchema = z.object({
  receiptToken: z.string().min(1),
  consumptionIds: z.array(z.string().min(1)).min(1),
})

/**
 * Tarea 6.1 — Carga de saldo desde el celular (visión §2.7). La sale queda PENDING hasta que el
 * webhook acredita el pago (MP/transferencia); recién ahí se acredita `customer_balances`
 * (mismo camino de dedupe que el checkout, despachado por `snapshot.kind === "deposit"`).
 */
const balanceDepositSchema = z.object({
  amount: z.string().min(1).regex(/^\d+(\.\d{1,2})?$/),
  paymentMethod: z.enum(["MERCADOPAGO", "TRANSFER"]),
  /**
   * Tarea 6.2 — Cuando viene `receiptToken`, el contacto se reusa del snapshot de esa
   * compra (el cliente ya está identificado): cargar saldo desde el comprobante no vuelve
   * a pedir nombre/mail/teléfono. `contact` es entonces opcional.
   */
  receiptToken: z.string().min(1).optional(),
  contact: z
    .object({
      name: z.string().min(1).max(255),
      email: z.string().email(),
      phone: z.string().min(1).max(255),
      /** DNI del titular: si viene, el saldo queda atado a esa identidad (una persona = un saldo). */
      dni: z.string().regex(/^\d{6,9}$/).optional(),
    })
    .optional(),
})

const guestCheckoutSchema = z.object({
  eventId: z.string().min(1),
  /** Tarea 6.1 — SALDO: pago con el saldo cargado del cliente (visión §2.7). Requiere DNI en el contacto. */
  paymentMethod: z.enum(["TRANSFER", "CARD", "MERCADOPAGO", "SALDO"]),
  clientTotal: z.string().min(1),
  contact: z.object({
    name: z.string().min(1).max(255),
    email: z.string().email(),
    phone: z.string().min(1).max(255),
    /**
     * Tarea 2.1 — DNI del comprador (la identidad dentro del evento: puerta, caja, saldo).
     * Opcional en el schema: el client lo manda siempre, pero el endpoint no debe romper
     * pedidos que no lo traigan. Valida el formato de DNI argentino (6–9 dígitos).
     */
    dni: z.string().regex(/^\d{6,9}$/).optional(),
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
  .post("/customers/access", zValidator("json", customerAccessSchema), async (c) => {
    const { type, value } = c.req.valid("json")
    const db = drizzle(pool)
    const cleanValue = value.trim()

    let customer: typeof customers.$inferSelect | undefined
    if (type === "email") {
      ;[customer] = await db
        .select()
        .from(customers)
        .where(eq(customers.email, cleanValue.toLowerCase()))
        .limit(1)
    } else if (type === "dni") {
      ;[customer] = await db
        .select()
        .from(customers)
        .where(eq(customers.dni, cleanValue.replace(/\D/g, "")))
        .limit(1)
    } else {
      const normalized = normalizeWhatsAppPhone(cleanValue)
      const candidates = [...new Set([cleanValue, cleanValue.replace(/\D/g, ""), normalized].filter(Boolean))] as string[]
      ;[customer] = await db
        .select()
        .from(customers)
        .where(inArray(customers.phone, candidates))
        .limit(1)
    }

    // Respuesta uniforme para impedir que este formulario permita enumerar clientes.
    if (!customer?.isActive) return c.json({ ok: true })

    const [latest] = await db
      .select({
        saleId: sales.id,
        receiptToken: sales.receiptToken,
        whatsappEnabled: tenants.whatsappEnabled,
        whatsappToken: tenants.whatsappToken,
        whatsappPhoneNumberId: tenants.whatsappPhoneNumberId,
      })
      .from(sales)
      .innerJoin(tenants, eq(sales.tenantId, tenants.id))
      .where(and(eq(sales.customerId, customer.id), eq(sales.status, "COMPLETED")))
      .orderBy(desc(sales.createdAt))
      .limit(1)

    if (!latest) return c.json({ ok: true })
    const profileUrl = `${CLIENT_URL}/mi-cuenta/${encodeURIComponent(latest.receiptToken)}`
    const canWhatsApp = Boolean(
      customer.phone && latest.whatsappEnabled && latest.whatsappToken && latest.whatsappPhoneNumberId
    )
    const preferWhatsApp = type === "phone" || (type === "dni" && canWhatsApp)

    let deliveredByWhatsApp = false
    if (preferWhatsApp && canWhatsApp) {
      try {
        const result = await sendWhatsAppTemplateMessage({
          token: latest.whatsappToken!,
          phoneNumberId: latest.whatsappPhoneNumberId!,
          to: customer.phone!,
          templateName: CUSTOMER_PROFILE_TEMPLATE,
          bodyParameters: [customer.name],
          urlButton: { parameter: `mi-cuenta/${latest.receiptToken}` },
        })
        deliveredByWhatsApp = result.ok
        if (!result.ok) console.error("[customer-profile] WhatsApp rechazó el mensaje", result.error)
      } catch (error) {
        console.error("[customer-profile] no se pudo enviar por WhatsApp", error)
      }
    }
    if (!deliveredByWhatsApp && isDeliverableEmail(customer.email)) {
      try {
        await sendCustomerProfileEmail({ to: customer.email, name: customer.name, url: profileUrl })
      } catch (error) {
        console.error("[customer-profile] no se pudo enviar por email", error)
      }
    }
    return c.json({ ok: true })
  })
  .get("/customers/profile/:token", async (c) => {
    const db = drizzle(pool)
    const [credential] = await db
      .select({ customerId: sales.customerId })
      .from(sales)
      .where(eq(sales.receiptToken, c.req.param("token")))
      .limit(1)

    if (!credential?.customerId) return c.json({ error: "El enlace no es válido" }, 404)
    const [customer] = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(and(eq(customers.id, credential.customerId), eq(customers.isActive, true)))
      .limit(1)
    if (!customer) return c.json({ error: "El enlace no es válido" }, 404)

    const saleRows = await db
      .select({
        saleId: sales.id,
        eventId: events.id,
        eventName: events.name,
        eventDate: events.date,
        eventVenue: events.venue,
        eventLocation: events.location,
        eventImageUrl: events.imageUrl,
        eventStatus: events.status,
        productoraName: tenants.name,
        receiptToken: sales.receiptToken,
        snapshot: sales.guestCheckoutSnapshot,
        createdAt: sales.createdAt,
      })
      .from(sales)
      .innerJoin(events, eq(sales.eventId, events.id))
      .innerJoin(tenants, eq(sales.tenantId, tenants.id))
      .where(and(eq(sales.customerId, customer.id), eq(sales.status, "COMPLETED")))
      .orderBy(desc(events.date), desc(sales.createdAt))

    const ticketRows = await db
      .select({ eventId: tickets.eventId, saleId: tickets.saleId, status: tickets.status })
      .from(tickets)
      .where(eq(tickets.customerId, customer.id))
    const consumptionRows = await db
      .select({ eventId: digitalConsumptions.eventId, status: digitalConsumptions.status })
      .from(digitalConsumptions)
      .where(eq(digitalConsumptions.customerId, customer.id))

    const ticketSaleIds = new Set(ticketRows.map((row) => row.saleId).filter(Boolean))
    const grouped = new Map<string, (typeof saleRows)[number]>()
    for (const row of saleRows) {
      const current = grouped.get(row.eventId)
      const useful = ticketSaleIds.has(row.saleId) || row.snapshot?.kind !== "deposit"
      if (!current || (current.snapshot?.kind === "deposit" && useful)) grouped.set(row.eventId, row)
    }

    return c.json({
      customer: { name: customer.name },
      events: [...grouped.values()].map((row) => ({
        id: row.eventId,
        name: row.eventName,
        date: row.eventDate,
        venue: row.eventVenue,
        location: row.eventLocation,
        imageUrl: row.eventImageUrl,
        status: row.eventStatus,
        productoraName: row.productoraName,
        receiptToken: row.receiptToken,
        tickets: ticketRows.filter((item) => item.eventId === row.eventId && item.status !== "CANCELLED").length,
        pendingConsumptions: consumptionRows.filter((item) => item.eventId === row.eventId && item.status === "PENDING").length,
      })),
    })
  })
  .get("/events", async (c) => {
    const db = drizzle(pool)
    const tenantFilter = c.req.query("productoraId")

    const filters: SQL[] = [
      // Tarea 11.3 — `isActive` retirado: la visibilidad pública vive en `status`
      // (el viejo sync de transición hacía `isActive = status !== "closed"`).
      ne(events.status, "closed"),
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
        venue: events.venue,
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
        venue: r.venue,
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

    if (!ev || ev.status === "closed") {
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

    const consumptionRows = eventSupportsConsumptions(
      ev.operationMode ?? "FULL_OPERATION"
    ) ? await db
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
      : []

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
        // Tarea 2.2 — la slug para navegar "Volver" al evento desde el checkout.
        slug: ev.slug ?? null,
        name: ev.name,
        date: ev.date,
        venue: ev.venue ?? null,
        location: ev.location,
        imageUrl: ev.imageUrl ?? null,
        designType: ev.designType ?? "MINIMAL",
        operationMode: ev.operationMode ?? "FULL_OPERATION",
        ticketsAvailableFrom: ev.ticketsAvailableFrom ?? null,
        consumptionsAvailableFrom: ev.consumptionsAvailableFrom ?? null,
      },
      ticketTypes: ticketTypesOut,
      drinkProducts,
      productCategories: productCategoriesOut,
    })
  })
  // Reporte de cierre público y de solo lectura (tarea 4.5 / spec §5 "Cerrado": compartible por
  // link). Solo responde para eventos ya cerrados con su liquidación congelada; los eventos
  // cerrados tienen `status = "closed"`, por eso NO reusamos el filtro de `/events/:id`.
  .get("/events/:id/report", async (c) => {
    const slugOrId = c.req.param("id")
    const db = drizzle(pool)

    const [ev] = await db
      .select()
      .from(events)
      .where(or(eq(events.id, slugOrId), eq(events.slug, slugOrId)))
      .limit(1)

    if (!ev || ev.status !== "closed" || !ev.closingReport) {
      return c.json({ error: "Reporte no disponible" }, 404)
    }

    const [productoraRow] = await db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, ev.tenantId))
      .limit(1)

    return c.json({
      productora: { name: productoraRow?.name ?? "Productora" },
      event: {
        id: ev.id,
        name: ev.name,
        date: ev.date,
        venue: ev.venue ?? null,
        location: ev.location,
      },
      report: ev.closingReport,
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
        mpPublicKey: tenants.mpPublicKey,
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
            // Tarea 2.1 — el DNI viaja al checkout: `findOrCreateCustomer` lo persiste y
            // `executeTicketPurchase` lo snapshotea en `tickets.buyer_dni` (lookup en puerta).
            ...(body.contact.dni ? { dni: body.contact.dni } : {}),
          },
          paymentMethod: body.paymentMethod,
          clientTotal: body.clientTotal.trim(),
          ticketLines: body.ticketLines ?? [],
          drinkLines: body.drinkLines ?? [],
        })
      )

      if (body.paymentMethod === "SALDO") {
        // Tarea 6.1 — El pago con saldo se completa al instante (no hay nada que acreditar):
        // `executeClientCheckout` ya dejó la sale COMPLETED y debitó el saldo (movimiento
        // CONSUMO). Sin redirección: el client navega directo al comprobante.
        return c.json(
          {
            message: "Compra confirmada",
            receiptToken: result.receiptToken,
            saleId: result.saleId,
            ...(result.balance != null ? { balance: result.balance } : {}),
          },
          201
        )
      }

      if (body.paymentMethod === "MERCADOPAGO") {
        // Tarea 2.2 — Checkout Pro: creamos la preferencia y el client redirige al link de
        // pago (mismo patrón que el addon de consumos). Sin link, la sale queda huérfana:
        // se marca PAYMENT_FAILED.
        const mpAccessToken = await obtenerTokenValido(result.tenantId)
        if (!mpAccessToken) {
          await db
            .update(sales)
            .set({ status: "PAYMENT_FAILED" })
            .where(
              and(eq(sales.id, result.saleId), eq(sales.tenantId, result.tenantId))
            )
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
            items: [
              {
                title: "Compra en el evento",
                quantity: 1,
                currency_id: "ARS",
                unit_price: total,
              },
            ],
            marketplace_fee: fee,
            back_urls: {
              success: `https://crow.ar/receipt/${result.receiptToken}`,
              failure: `https://crow.ar/receipt/${result.receiptToken}`,
              pending: `https://crow.ar/receipt/${result.receiptToken}`,
            },
            auto_return: "approved",
            external_reference: `totem-sale-${result.saleId}`,
            notification_url: "https://api.crow.ar/api/mp/webhook",
            statement_descriptor: "TOTEM",
            expires: true,
            expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          }),
        })

        if (!mpRes.ok) {
          await db
            .update(sales)
            .set({ status: "PAYMENT_FAILED" })
            .where(
              and(eq(sales.id, result.saleId), eq(sales.tenantId, result.tenantId))
            )
          return c.json({ error: "No se pudo crear el link de pago" }, 500)
        }

        const preference = (await mpRes.json()) as { init_point?: string }
        if (!preference.init_point) {
          await db
            .update(sales)
            .set({ status: "PAYMENT_FAILED" })
            .where(
              and(eq(sales.id, result.saleId), eq(sales.tenantId, result.tenantId))
            )
          return c.json({ error: "No se pudo obtener el link de pago" }, 500)
        }

        return c.json(
          {
            message: "Pendiente de pago",
            receiptToken: result.receiptToken,
            saleId: result.saleId,
            payOnReceipt: true,
            redirectUrl: preference.init_point,
          },
          201
        )
      }

      if (body.paymentMethod === "CARD") {
        // Tarea 2.2 — el client monta el CardPayment Brick con la public key del tenant.
        return c.json(
          {
            message: "Pendiente de pago",
            receiptToken: result.receiptToken,
            saleId: result.saleId,
            payOnReceipt: true,
            card: { publicKey: paymentCtx.mpPublicKey ?? null },
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
  // ─── Saldo: consulta por DNI (tarea 6.2) ──────────────────────────────────────────
  // El checkout consulta acá para ofrecer "Saldo disponible" solo cuando hay fondos
  // (visión §2.7). El DNI es la identidad dentro del evento; sin cliente o sin saldo → "0.00".
  .get("/events/:id/balance", async (c) => {
    const eventId = c.req.param("id")
    const dni = c.req.query("dni")
    const db = drizzle(pool)

    if (!dni || !/^\d{6,9}$/.test(dni)) {
      return c.json({ amount: "0.00" })
    }

    const [ev] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), ne(events.status, "closed")))
      .limit(1)
    if (!ev) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }

    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.dni, dni))
      .limit(1)
    if (!customer) {
      return c.json({ amount: "0.00" })
    }

    const amount = await getBalance(db, customer.id, eventId)
    return c.json({ amount })
  })
  // ─── Saldo: carga desde el celular (tarea 6.1, visión §2.7) ──────────────────────
  // Crea una sale PENDING con snapshot `kind: "deposit"` (sin items). El webhook existente
  // (MP/Cucuru) la cumple como cualquier otra: `fulfillPendingGuestCheckout` despacha por el
  // snapshot y acredita `customer_balances` en vez de emitir tickets/consumos.
  .post("/events/:id/balance/deposit", zValidator("json", balanceDepositSchema), async (c) => {
    const eventId = c.req.param("id")
    const body = c.req.valid("json")
    const db = drizzle(pool)

    let amt
    try {
      amt = dec(body.amount)
    } catch {
      return c.json({ error: "Monto inválido" }, 400)
    }
    if (amt.isNaN() || !amt.isFinite() || amt.lte(0)) {
      return c.json({ error: "Monto inválido" }, 400)
    }
    const amountStr = decToDb(amt)

    const [paymentCtx] = await db
      .select({
        tenantId: events.tenantId,
        status: events.status,
        cucuruEnabled: tenants.cucuruEnabled,
        mpConnected: tenants.mpConnected,
        mpPublicKey: tenants.mpPublicKey,
      })
      .from(events)
      .innerJoin(tenants, eq(events.tenantId, tenants.id))
      .where(eq(events.id, eventId))
      .limit(1)

    if (!paymentCtx) {
      return c.json({ error: "Evento no encontrado" }, 404)
    }
    if (paymentCtx.status === "closed") {
      return c.json({ error: "Evento no disponible" }, 404)
    }
    if (body.paymentMethod === "TRANSFER" && !paymentCtx.cucuruEnabled) {
      return c.json(
        { error: "Los cobros por transferencia no están disponibles para este evento." },
        400
      )
    }
    if (body.paymentMethod === "MERCADOPAGO" && !paymentCtx.mpConnected) {
      return c.json(
        { error: "Mercado Pago no está habilitado para este evento" },
        400
      )
    }

    // Tarea 6.2 — Contacto explícito o, si viene `receiptToken`, el del snapshot de esa
    // compra (misma persona: el saldo queda atado a quien ya está identificado).
    let contact: { name: string; email: string; phone: string; dni?: string }
    if (body.contact) {
      contact = {
        name: body.contact.name,
        email: body.contact.email,
        phone: body.contact.phone,
        ...(body.contact.dni ? { dni: body.contact.dni } : {}),
      }
    } else if (body.receiptToken) {
      const [saleRow] = await db
        .select()
        .from(sales)
        .where(eq(sales.receiptToken, body.receiptToken))
        .limit(1)
      if (!saleRow || saleRow.eventId !== eventId) {
        return c.json({ error: "Comprobante no encontrado" }, 404)
      }
      if (!saleRow.paid) {
        return c.json({ error: "La compra original no está confirmada" }, 400)
      }
      const snap = saleRow.guestCheckoutSnapshot
      if (!snap?.contact) {
        return c.json({ error: "No hay datos de contacto en esta compra" }, 400)
      }
      contact = snap.contact
    } else {
      return c.json({ error: "Faltan los datos de contacto" }, 400)
    }

    const result = await db.transaction(async (tx) => {
      const customerId = await findOrCreateCustomer(tx, contact)
      const saleId = uuidv4()
      const receiptToken = randomUUID()
      await tx.insert(sales).values({
        id: saleId,
        eventId,
        tenantId: paymentCtx.tenantId,
        customerId,
        receiptToken,
        source: "WEB",
        totalAmount: amountStr,
        paymentMethod: body.paymentMethod,
        status: "PENDING",
        guestCheckoutSnapshot: {
          kind: "deposit",
          ticketLines: [],
          drinkLines: [],
          contact: {
            name: contact.name,
            email: contact.email.toLowerCase().trim(),
            phone: contact.phone,
            ...(contact.dni ? { dni: contact.dni } : {}),
          },
        },
        createdAt: new Date(),
      })
      return { saleId, receiptToken, tenantId: paymentCtx.tenantId }
    })

    if (body.paymentMethod === "MERCADOPAGO") {
      // Checkout Pro: mismo patrón que `/checkout` (link de pago + PAYMENT_FAILED si no sale).
      const mpAccessToken = await obtenerTokenValido(result.tenantId)
      if (!mpAccessToken) {
        await db
          .update(sales)
          .set({ status: "PAYMENT_FAILED" })
          .where(
            and(eq(sales.id, result.saleId), eq(sales.tenantId, result.tenantId))
          )
        return c.json({ error: "No se pudo conectar con Mercado Pago" }, 502)
      }

      const total = parseFloat(amountStr)
      const fee = Math.round(total * 0.01 * 100) / 100

      const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mpAccessToken}`,
        },
        body: JSON.stringify({
          items: [
            {
              title: "Carga de saldo",
              quantity: 1,
              currency_id: "ARS",
              unit_price: total,
            },
          ],
          marketplace_fee: fee,
          back_urls: {
            success: `https://crow.ar/receipt/${result.receiptToken}`,
            failure: `https://crow.ar/receipt/${result.receiptToken}`,
            pending: `https://crow.ar/receipt/${result.receiptToken}`,
          },
          auto_return: "approved",
          external_reference: `totem-sale-${result.saleId}`,
          notification_url: "https://api.crow.ar/api/mp/webhook",
          statement_descriptor: "TOTEM",
          expires: true,
          expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        }),
      })

      if (!mpRes.ok) {
        await db
          .update(sales)
          .set({ status: "PAYMENT_FAILED" })
          .where(
            and(eq(sales.id, result.saleId), eq(sales.tenantId, result.tenantId))
          )
        return c.json({ error: "No se pudo crear el link de pago" }, 500)
      }

      const preference = (await mpRes.json()) as { init_point?: string }
      if (!preference.init_point) {
        await db
          .update(sales)
          .set({ status: "PAYMENT_FAILED" })
          .where(
            and(eq(sales.id, result.saleId), eq(sales.tenantId, result.tenantId))
          )
        return c.json({ error: "No se pudo obtener el link de pago" }, 500)
      }

      return c.json(
        {
          message: "Pendiente de pago",
          receiptToken: result.receiptToken,
          saleId: result.saleId,
          payOnReceipt: true,
          redirectUrl: preference.init_point,
        },
        201
      )
    }

    // TRANSFER: alias/CVU de Cucuru, mismo patrón que `/checkout`.
    const [slugCtx] = await db
      .select({
        productoraName: tenants.name,
        eventName: events.name,
      })
      .from(events)
      .innerJoin(tenants, eq(events.tenantId, tenants.id))
      .where(and(eq(events.id, eventId), eq(tenants.id, result.tenantId)))
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
      return c.json({ error: mapAsignarAliasError(aliasRes.reason) }, 502)
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
  })
  .get("/receipts/:token", async (c) => {
    const token = c.req.param("token")
    const db = drizzle(pool)

    const [header] = await db
      .select({
        sale: sales,
        eventName: events.name,
        eventDate: events.date,
        eventVenue: events.venue,
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
    const checkoutSnapshot = header.sale.guestCheckoutSnapshot

    // Tarea 6.1 — Saldo del cliente en este evento (visión §2.7): "0.00" si nunca cargó.
    // El comprobante (y el client) lo muestran; la caja también lo lee por DNI (6.3).
    let balanceAmount = "0.00"
    if (header.sale.customerId) {
      balanceAmount = await getBalance(db, header.sale.customerId, header.sale.eventId)
    }

    const consumptionShape = {
      id: digitalConsumptions.id,
      qrHash: digitalConsumptions.qrHash,
      status: digitalConsumptions.status,
      productId: digitalConsumptions.productId,
      productName: products.name,
      productPrice: products.price,
    }

    const [ticketRows, consumptionRows, pickupRows] = await Promise.all([
      db
        .select({
          id: tickets.id,
          qrHash: tickets.qrHash,
          status: tickets.status,
          ticketTypeName: ticketTypes.name,
          ticketTypePrice: ticketTypes.price,
          buyerName: tickets.buyerName,
        })
        .from(tickets)
        .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
        .where(
          header.sale.customerId && header.sale.paid
            ? and(
                eq(tickets.customerId, header.sale.customerId),
                eq(tickets.eventId, header.sale.eventId),
                eq(tickets.tenantId, header.sale.tenantId)
              )
            : and(eq(tickets.saleId, saleId), eq(tickets.tenantId, header.sale.tenantId))
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
      header.sale.customerId
        ? db
            .select({
              token: pickupOrders.token,
              status: pickupOrders.status,
              createdAt: pickupOrders.createdAt,
              deliveredAt: pickupOrders.deliveredAt,
              itemsJson: pickupOrders.itemsJson,
            })
            .from(pickupOrders)
            .where(
              and(
                eq(pickupOrders.customerId, header.sale.customerId),
                eq(pickupOrders.eventId, header.sale.eventId),
                eq(pickupOrders.tenantId, header.sale.tenantId)
              )
            )
            .orderBy(desc(pickupOrders.createdAt))
        : Promise.resolve([]),
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

    const pickups = await Promise.all(
      pickupRows.map(async (pickup) => ({
        token: pickup.token,
        status: pickup.status,
        createdAt: pickup.createdAt ?? null,
        deliveredAt: pickup.deliveredAt ?? null,
        items: await pickupItemsWithNames(db, pickup.itemsJson),
      }))
    )

    return c.json({
      receiptToken: header.sale.receiptToken,
      customerName:
        checkoutSnapshot?.contact?.name?.trim() ||
        ticketRows.find((ticket) => ticket.buyerName?.trim())?.buyerName?.trim() ||
        "Invitado",
      balance: { amount: balanceAmount },
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
        venue: header.eventVenue,
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
      pickups,
    })
  })
  .post("/receipts/:token/consumptions-checkout", async (c) => {
    const token = c.req.param("token")
    const db = drizzle(pool)

    // Tarea 6.2 — `paymentMethod` opcional: "SALDO" paga con el saldo del cliente (completo
    // al instante, sin acreditar nada); por defecto (y back-compat) Mercado Pago.
    let body: {
      drinkLines: { productId: string; quantity: number }[]
      clientTotal: string
      paymentMethod?: string
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "JSON inválido" }, 400)
    }

    if (!body.drinkLines?.length || !body.clientTotal) {
      return c.json({ error: "Datos incompletos" }, 400)
    }

    const method = body.paymentMethod === "SALDO" ? "SALDO" : "MERCADOPAGO"

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

    if (method === "MERCADOPAGO" && !tenant?.mpConnected) {
      return c.json({ error: "Mercado Pago no está habilitado para este evento" }, 400)
    }

    // Tarea 6.2 — El pago con saldo exige DNI (el saldo está atado a la identidad). El
    // snapshot del comprador lo tiene si compró con DNI; si no, se resuelve del customer
    // (una carga de saldo en caja quedó registrada con DNI).
    let contact = snap.contact
    if (method === "SALDO" && !contact.dni) {
      const [customerRow] = saleRow.customerId
        ? await db
            .select({ dni: customers.dni })
            .from(customers)
            .where(eq(customers.id, saleRow.customerId))
            .limit(1)
        : []
      contact = { ...snap.contact, ...(customerRow?.dni ? { dni: customerRow.dni } : {}) }
    }

    let result: Awaited<ReturnType<typeof executeClientCheckout>>
    try {
      result = await db.transaction(async (tx) =>
        executeClientCheckout(tx, {
          eventId: saleRow.eventId,
          contact,
          paymentMethod: method,
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

    // Tarea 6.2 — SALDO: la sale quedó COMPLETED y el saldo debitado dentro de la
    // transacción. Sin preferencia que crear: el client refresca el comprobante.
    if (method === "SALDO") {
      return c.json({
        success: true,
        receiptToken: result.receiptToken,
        ...(result.balance != null ? { balance: result.balance } : {}),
      })
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
          success: `https://crow.ar/receipt/${token}`,
          failure: `https://crow.ar/receipt/${token}`,
          pending: `https://crow.ar/receipt/${token}`,
        },
        auto_return: "approved",
        external_reference: `totem-sale-${result.saleId}`,
        notification_url: "https://api.crow.ar/api/mp/webhook",
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
  // ─── Retiro en barra (tarea 4.1) — "¿Qué te llevás ahora?" ─────────────────────
  // El cliente elige tragos comprados y no canjeados y genera UN QR de pedido. Las
  // consumiciones NO se tocan acá: el pedido es una lista de intención; el canje real
  // (REDEEMED + stock) lo hace la barra con el token del QR (tarea 4.2/4.3). Lo no
  // retirado sigue PENDING en el comprobante.
  .post("/pickups", zValidator("json", pickupCreateSchema), async (c) => {
    const body = c.req.valid("json")
    const db = drizzle(pool)

    const [saleRow] = await db
      .select()
      .from(sales)
      .where(eq(sales.receiptToken, body.receiptToken))
      .limit(1)

    if (!saleRow) return c.json({ error: "Comprobante no encontrado" }, 404)
    if (!saleRow.paid) {
      return c.json({ error: "La compra original no está confirmada" }, 400)
    }
    if (!saleRow.customerId) {
      return c.json({ error: "Esta compra no tiene un cliente asociado" }, 400)
    }

    // Orden estable por consumptionId: sirve para detectar pedidos duplicados.
    const idsSorted = [...body.consumptionIds].sort()

    const consRows = await db
      .select()
      .from(digitalConsumptions)
      .where(inArray(digitalConsumptions.id, idsSorted))

    if (consRows.length !== idsSorted.length) {
      return c.json({ error: "Algunas consumiciones no existen" }, 400)
    }

    const scoped = consRows.every(
      (r) =>
        r.status === "PENDING" &&
        r.customerId === saleRow.customerId &&
        r.eventId === saleRow.eventId &&
        r.tenantId === saleRow.tenantId
    )
    if (!scoped) {
      return c.json(
        {
          error:
            "Algunas consumiciones ya fueron canjeadas o no pertenecen a esta compra",
        },
        409
      )
    }

    const itemsJson: PickupItemsJson = idsSorted.map((cid) => {
      const row = consRows.find((r) => r.id === cid)!
      return { consumptionId: cid, productId: row.productId, quantity: 1 }
    })

    // Idempotencia: si ya existe un pedido PENDING con exactamente este contenido, se
    // devuelve el mismo (un doble tap no puede generar dos pedidos → doble entrega).
    const existingRows = await db
      .select()
      .from(pickupOrders)
      .where(
        and(
          eq(pickupOrders.customerId, saleRow.customerId),
          eq(pickupOrders.eventId, saleRow.eventId),
          eq(pickupOrders.status, "PENDING")
        )
      )
      .orderBy(desc(pickupOrders.createdAt))
      .limit(20)
    const itemsKey = JSON.stringify(itemsJson)
    const duplicate = existingRows.find(
      (o) => JSON.stringify(o.itemsJson ?? []) === itemsKey
    )
    if (duplicate) {
      const items = await pickupItemsWithNames(db, duplicate.itemsJson)
      return c.json({ token: duplicate.token, status: duplicate.status, items })
    }

    const orderId = uuidv4()
    const token = randomUUID()
    await db.insert(pickupOrders).values({
      id: orderId,
      eventId: saleRow.eventId,
      tenantId: saleRow.tenantId,
      customerId: saleRow.customerId,
      token,
      status: "PENDING",
      itemsJson,
      createdAt: new Date(),
    })

    const items = await pickupItemsWithNames(db, itemsJson)
    broadcastReceiptUpdate(body.receiptToken)
    return c.json({ token, status: "PENDING", items }, 201)
  })
  // Vista del pedido para el QR del client (tarea 4.1). Sin auth — el token ES la credencial.
  .get("/pickups/:token", async (c) => {
    const token = c.req.param("token")
    const db = drizzle(pool)

    const [row] = await db
      .select()
      .from(pickupOrders)
      .where(eq(pickupOrders.token, token))
      .limit(1)

    if (!row) {
      return c.json({ error: "Pedido no encontrado" }, 404)
    }

    const items = await pickupItemsWithNames(db, row.itemsJson)
    return c.json({
      token: row.token,
      status: row.status,
      createdAt: row.createdAt ?? null,
      deliveredAt: row.deliveredAt ?? null,
      items,
    })
  })
  // Cortesía / invitación (spec §4.2): el invitado abre su link nominado.
  // Sin auth — el token ES la credencial.
  .get("/courtesies/:token", async (c) => {
    const token = c.req.param("token")
    const db = drizzle(pool)
    const [row] = await db
      .select({
        courtesy: courtesies,
        eventName: events.name,
        eventDate: events.date,
        eventVenue: events.venue,
        eventLocation: events.location,
        ticketTypeName: ticketTypes.name,
      })
      .from(courtesies)
      .innerJoin(events, eq(courtesies.eventId, events.id))
      .innerJoin(ticketTypes, eq(courtesies.ticketTypeId, ticketTypes.id))
      .where(eq(courtesies.token, token))
      .limit(1)

    if (!row) {
      return c.json({ error: "Invitación no encontrada" }, 404)
    }
    if (row.courtesy.status === "REVOKED") {
      return c.json({ error: "Esta invitación fue anulada" }, 410)
    }

    // Tragos de regalo (tarea 7.1): resumen [{productId, productName, quantity}] para que la
    // invitación muestre qué incluye antes de canjear.
    const drinkLines = Array.isArray(row.courtesy.drinkLines)
      ? row.courtesy.drinkLines
      : []
    let drinks: { productId: string; productName: string; quantity: number }[] = []
    if (drinkLines.length > 0) {
      const drinkIds = [...new Set(drinkLines.map((l) => l.productId))]
      const productRows = await db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(inArray(products.id, drinkIds))
      const byId = new Map(productRows.map((p) => [p.id, p.name]))
      drinks = drinkLines.map((l) => ({
        productId: l.productId,
        productName: byId.get(l.productId) ?? "—",
        quantity: l.quantity,
      }))
    }

    // Si ya se canjeó, exponemos los QRs de la entrada y de los tragos (idempotente).
    const drinkConsumptions =
      row.courtesy.status === "REDEEMED" && row.courtesy.drinkSaleId
        ? await courtesyDrinkQrs(db, row.courtesy.drinkSaleId, row.courtesy.tenantId)
        : null

    return c.json({
      guestName: row.courtesy.guestName,
      status: row.courtesy.status,
      event: {
        id: row.courtesy.eventId,
        name: row.eventName,
        date: row.eventDate,
        venue: row.eventVenue,
        location: row.eventLocation,
      },
      ticketTypeName: row.ticketTypeName,
      drinks,
      // Si ya se canjeó, exponemos el QR para que pueda volver a verlo.
      ticketId: row.courtesy.ticketId ?? null,
      drinkConsumptions,
    })
  })
  // Canje: emite UNA entrada real y la enlaza a la cortesía. Idempotente: si ya
  // está canjeada, devuelve la misma entrada. La cortesía NO consume cupo pago
  // (es un regalo "aparte" del productor), por eso emite sin chequear stockLimit.
  .post("/courtesies/:token/redeem", async (c) => {
    const token = c.req.param("token")
    const db = drizzle(pool)

    const outcome = await db.transaction(async (tx) => {
      const [cty] = await tx
        .select()
        .from(courtesies)
        .where(eq(courtesies.token, token))
        .limit(1)

      if (!cty) {
        return { kind: "err" as const, status: 404 as const, error: "Invitación no encontrada" }
      }
      if (cty.status === "REVOKED") {
        return { kind: "err" as const, status: 410 as const, error: "Esta invitación fue anulada" }
      }
      if (cty.status === "REDEEMED" && cty.ticketId != null) {
        // Ya canjeada: devolvemos la entrada existente y los tragos ya emitidos (idempotente).
        const [existing] = await tx
          .select()
          .from(tickets)
          .where(eq(tickets.id, cty.ticketId))
          .limit(1)
        if (existing) {
          const drinks = cty.drinkSaleId
            ? await courtesyDrinkQrs(tx, cty.drinkSaleId, cty.tenantId)
            : []
          return { kind: "ok" as const, ticket: existing, alreadyRedeemed: true, drinks }
        }
      }

      const [ev] = await tx
        .select()
        .from(events)
        .where(eq(events.id, cty.eventId))
        .limit(1)
      if (!ev || ev.status === "closed") {
        return { kind: "err" as const, status: 404 as const, error: "Evento no disponible" }
      }

      const [tt] = await tx
        .select()
        .from(ticketTypes)
        .where(
          and(
            eq(ticketTypes.id, cty.ticketTypeId),
            eq(ticketTypes.tenantId, cty.tenantId)
          )
        )
        .limit(1)
      if (!tt) {
        return { kind: "err" as const, status: 404 as const, error: "Tipo de entrada no disponible" }
      }

      const ticketId = uuidv4()
      const qrHash = randomUUID()
      await tx.insert(tickets).values({
        id: ticketId,
        ticketTypeId: cty.ticketTypeId,
        eventId: cty.eventId,
        tenantId: cty.tenantId,
        qrHash,
        status: "PENDING",
        buyerName: cty.guestName,
        buyerEmail: cty.guestEmail ?? null,
        buyerDni: cty.guestDni ?? null,
        createdAt: new Date(),
      })

      // Tragos de regalo (tarea 7.1): emite consumiciones PENDING canjeables en barra como
      // cualquier otra. Decisión de implementación (documentada en la migración 0047): se cuelgan
      // de una sale real de $0 (source WEB, sin sale_items) porque `digital_consumptions.sale_id`
      // es NOT NULL y el canje 1×1 en barra joinnea `sales`. La sale de $0 no aporta recaudación
      // (el cierre suma sale_items × precio y el total CASH). Solo se emiten los tragos que
      // siguen activos en el menú del evento: el menú puede cambiar entre que se crea la
      // invitación y que se canjea, y la invitación no puede fallar por eso.
      const drinkLines = Array.isArray(cty.drinkLines) ? cty.drinkLines : []
      let drinkSaleId: string | null = null
      if (drinkLines.length > 0) {
        const drinkIds = [...new Set(drinkLines.map((l) => l.productId))]
        const menu = await tx
          .select({ productId: eventProducts.productId })
          .from(eventProducts)
          .where(
            and(
              eq(eventProducts.eventId, cty.eventId),
              eq(eventProducts.tenantId, cty.tenantId),
              eq(eventProducts.isActive, true),
              inArray(eventProducts.productId, drinkIds)
            )
          )
        const available = new Set(menu.map((m) => m.productId))
        const activeLines = drinkLines.filter((l) => available.has(l.productId))

        if (activeLines.length > 0) {
          drinkSaleId = uuidv4()
          await tx.insert(sales).values({
            id: drinkSaleId,
            eventId: cty.eventId,
            tenantId: cty.tenantId,
            receiptToken: randomUUID(),
            source: "WEB",
            totalAmount: "0",
            paymentMethod: "CASH",
            status: "COMPLETED",
            createdAt: new Date(),
          })
          for (const line of activeLines) {
            for (let i = 0; i < line.quantity; i++) {
              await tx.insert(digitalConsumptions).values({
                id: uuidv4(),
                eventId: cty.eventId,
                tenantId: cty.tenantId,
                productId: line.productId,
                saleId: drinkSaleId,
                qrHash: randomUUID(),
                status: "PENDING",
                createdAt: new Date(),
              })
            }
          }
        }
      }

      await tx
        .update(courtesies)
        .set({ status: "REDEEMED", ticketId, drinkSaleId, redeemedAt: new Date() })
        .where(eq(courtesies.id, cty.id))

      const [row] = await tx
        .select()
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .limit(1)

      const drinks = drinkSaleId
        ? await courtesyDrinkQrs(tx, drinkSaleId, cty.tenantId)
        : []

      return { kind: "ok" as const, ticket: row!, alreadyRedeemed: false, drinks }
    })

    if (outcome.kind === "err") {
      return c.json({ error: outcome.error }, outcome.status)
    }

    const qrDataUrl = await qrCodeDataUrl(outcome.ticket.qrHash)
    return c.json({
      message: outcome.alreadyRedeemed ? "Invitación ya canjeada" : "Invitación canjeada",
      alreadyRedeemed: outcome.alreadyRedeemed,
      ticket: {
        id: outcome.ticket.id,
        eventId: outcome.ticket.eventId,
        qrHash: outcome.ticket.qrHash,
        status: outcome.ticket.status,
        buyerName: outcome.ticket.buyerName,
      },
      qrDataUrl,
      // Tragos de regalo emitidos (tarea 7.1): consumiciones PENDING con su QR, listas para
      // retirar en barra como cualquier otra. Vacío si la invitación no traía tragos.
      drinks: outcome.drinks,
    })
  })
