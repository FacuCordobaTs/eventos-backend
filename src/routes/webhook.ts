import { Hono } from "hono"
import { pool } from "../db"
import { drizzle } from "drizzle-orm/mysql2"
import { eq, and, or } from "drizzle-orm"
import { sendGuestCheckoutReceiptEmail } from "../lib/send-checkout-receipt-email"
import { fulfillPendingGuestCheckout } from "../lib/client-checkout"
import { dec, decFromDb } from "../lib/decimal-money"
import {
  accountPool as AccountPoolTable,
  sales as SalesTable,
  customers as CustomersTable,
} from "../db/schema"

export const webhookRoute = new Hono()


webhookRoute.get('/', async (c) => {
  return c.json({ message: 'Webhook get received' }, 200)
})

webhookRoute.post('/', async (c) => {
  return c.json({ message: 'Webhook received' }, 200)
})

const cucuruWebhookHandler = async (c: {
  req: { json: () => Promise<unknown> }
  json: (body: unknown, status?: number) => Response
}) => {
  try {
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ status: "ok" }, 200)
    }

    const amount = body.amount
    const customerIdStr = body.customer_id
    const collectionAccount = body.collection_account

    if (!customerIdStr || amount === undefined || amount === null) {
      return c.json({ status: "ignored" }, 200)
    }

    const paidAmtProbe = dec(String(amount))
    if (paidAmtProbe.lte(0)) {
      return c.json({ status: "ok" }, 200)
    }

    const db = drizzle(pool)

    let assignedSaleId: string | null = null
    let poolTenantId: string | null = null

    if (collectionAccount != null && String(collectionAccount) !== "") {
      const acct = String(collectionAccount)
      const poolRecords = await db
        .select()
        .from(AccountPoolTable)
        .where(
          or(
            eq(AccountPoolTable.accountNumber, acct),
            eq(AccountPoolTable.alias, acct)
          )
        )
        .limit(1)

      if (poolRecords.length > 0 && poolRecords[0].saleIdAssigned) {
        assignedSaleId = poolRecords[0].saleIdAssigned
        poolTenantId = poolRecords[0].tenantId ?? null
      }
    }

    if (!assignedSaleId || !poolTenantId) {
      return c.json({ status: "ignored_no_sale_assigned" }, 200)
    }

    const paidAmt = paidAmtProbe
    const [sale] = await db
      .select()
      .from(SalesTable)
      .where(
        and(eq(SalesTable.id, assignedSaleId), eq(SalesTable.tenantId, poolTenantId))
      )
      .limit(1)

    if (!sale) {
      return c.json({ status: "ignored_no_sale" }, 200)
    }

    if (sale.paid) {
      return c.json({ status: "ok" }, 200)
    }

    const expected = decFromDb(sale.totalAmount)
    if (paidAmt.lt(expected)) {
      console.warn(
        `[Cucuru] Pago insuficiente para ${sale.id}. Pagado: ${paidAmt.toFixed(2)}, Esperado: ${expected.toFixed(2)}`
      )
      return c.json({ status: "ignored_insufficient" }, 200)
    }

    await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(SalesTable)
        .where(
          and(eq(SalesTable.id, assignedSaleId), eq(SalesTable.tenantId, poolTenantId))
        )
        .limit(1)

      if (!current || current.paid) {
        return
      }

      if (current.status === "PENDING" && current.guestCheckoutSnapshot != null) {
        await fulfillPendingGuestCheckout(tx, current.id)
      } else {
        await tx
          .update(SalesTable)
          .set({ paid: true, paidAt: new Date() })
          .where(
            and(eq(SalesTable.id, current.id), eq(SalesTable.tenantId, poolTenantId))
          )
      }
    })

    const [after] = await db
      .select()
      .from(SalesTable)
      .where(eq(SalesTable.id, sale.id))
      .limit(1)

    if (!after?.paid) {
      return c.json({ status: "ignored_not_marked_paid" }, 200)
    }

    const customer =
      after.customerId != null && after.customerId !== ""
        ? await db
            .select()
            .from(CustomersTable)
            .where(eq(CustomersTable.id, after.customerId))
            .limit(1)
        : []

    if (customer.length > 0) {
      try {
        await sendGuestCheckoutReceiptEmail({
          db,
          eventId: after.eventId,
          saleId: after.id,
          receiptToken: after.receiptToken,
          contact: {
            name: customer[0].name,
            email: customer[0].email,
          },
        })
      } catch (error) {
        console.error("Error enviando email de recepción de pago:", error)
      }
    }

    return c.json({ status: "received" }, 200)
  } catch (error) {
    console.error("Error procesando webhook:", error)
    return c.json({ status: "error" }, 500)
  }
}

// Rutas para abarcar todas las posibles URL's a las que puede estar pegando el PING de Cucuru:
webhookRoute.post('/cucuru/collection_received', cucuruWebhookHandler);
webhookRoute.get('/cucuru/collection_received', (c) => c.json({ status: 'ok' }, 200));

webhookRoute.post('/cucuru/collection_received/collection_received', cucuruWebhookHandler);
webhookRoute.get('/cucuru/collection_received/collection_received', (c) => c.json({ status: 'ok' }, 200));

webhookRoute.post('/cucuru', cucuruWebhookHandler);
webhookRoute.get('/cucuru', (c) => c.json({ status: 'ok' }, 200));