import { Hono } from 'hono'
import { pool } from '../db'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, ne, or } from 'drizzle-orm'
import { sendGuestCheckoutReceiptEmail } from "../lib/send-checkout-receipt-email"
import  { accountPool as AccountPoolTable, sales as SalesTable, customers as CustomersTable } from '../db/schema'

export const webhookRoute = new Hono()


webhookRoute.get('/', async (c) => {
  return c.json({ message: 'Webhook get received' }, 200)
})

webhookRoute.post('/', async (c) => {
  return c.json({ message: 'Webhook received' }, 200)
})

const cucuruWebhookHandler = async (c: any) => {
  try {
    let body;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ status: 'ok' }, 200);
    }


    const amount = body.amount;
    const customerIdStr = body.customer_id;
    const collectionId = body.collection_id;
    const collectionAccount = body.collection_account;

    if (amount === 0) {
      return c.json({ status: 'ok' }, 200);
    }

    if (!customerIdStr || amount === undefined) {
      return c.json({ status: 'ignored' }, 200);
    }

    const tenantId = customerIdStr;
    const db = drizzle(pool);

    let assignedSaleId: string | null = null;
    let poolTenantId: string | null = null;

    // Cucuru puede enviar collection_account como account_number (22 dígitos) o como alias (ej: piru.alfajor.171)
    if (collectionAccount) {
      const poolRecords = await db.select()
        .from(AccountPoolTable)
        .where(or(
          eq(AccountPoolTable.accountNumber, collectionAccount),
          eq(AccountPoolTable.alias, collectionAccount)
        ))
        .limit(1);

      if (poolRecords.length > 0 && poolRecords[0].saleIdAssigned) {
        assignedSaleId = poolRecords[0].saleIdAssigned;
        poolTenantId = poolRecords[0].tenantId;
      }
    }

    if (!assignedSaleId) {
      return c.json({ status: 'ignored_no_sale_assigned' }, 200);
    }

    const sales = await db.select()
      .from(SalesTable)
      .where(eq(SalesTable.id, assignedSaleId));

    if (sales.length > 0) {
      const sale = sales[0];

      if (Number(amount) < Number(sale.totalAmount)) {
        console.warn(`⚠️ [Cucuru] Pago insuficiente para ${sale.id}. Pagado: $${amount}, Esperado: $${sale.totalAmount}`);
        return c.json({ status: 'ignored_insufficient' }, 200);
      }

      await db.update(SalesTable).set({
        paid: true,
        paidAt: new Date(),
      }).where(eq(SalesTable.id, sale.id));

      const customer = await db.select()
        .from(CustomersTable)
        .where(eq(CustomersTable.id, sale.customerId ?? ''))
        .limit(1);


      if (customer.length > 0) {
        try {
          await sendGuestCheckoutReceiptEmail({
            db,
            eventId: sale.eventId,
            saleId: sale.id,
            receiptToken: sale.receiptToken,
            contact: {
              name: customer[0].name,
              email: customer[0].email,
            },
          });
        } catch (error) {
          console.error("❌ Error enviando email de recepción de pago:", error);
        }
      }

      return c.json({ status: 'received' }, 200);
    }

 } catch (error) {
  console.error("❌ Error procesando webhook:", error);
  return c.json({ status: 'error' }, 500);
 }
}

// Rutas para abarcar todas las posibles URL's a las que puede estar pegando el PING de Cucuru:
webhookRoute.post('/cucuru/collection_received', cucuruWebhookHandler);
webhookRoute.get('/cucuru/collection_received', (c) => c.json({ status: 'ok' }, 200));

webhookRoute.post('/cucuru/collection_received/collection_received', cucuruWebhookHandler);
webhookRoute.get('/cucuru/collection_received/collection_received', (c) => c.json({ status: 'ok' }, 200));

webhookRoute.post('/cucuru', cucuruWebhookHandler);
webhookRoute.get('/cucuru', (c) => c.json({ status: 'ok' }, 200));