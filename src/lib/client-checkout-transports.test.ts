import { describe, expect, test } from "bun:test"
import { getTableName } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import { executeTicketPurchase } from "./ticket-purchase"
import {
  executeClientCheckout,
  fulfillPendingGuestCheckout
} from "./client-checkout"

type Row = Record<string, any>
function fixture() {
  const rows: Record<string, Row[]> = {
    events: [
      {
        id: "event-a",
        tenantId: "tenant-a",
        status: "on_sale",
        ticketsAvailableFrom: null,
        consumptionsAvailableFrom: null
      }
    ],
    customers: [{ id: "buyer-a", name: "Ana", dni: "12345678" }],
    ticket_types: [{ id: "ticket-a", price: "10000.00", stockLimit: null }],
    event_transports: [
      {
        id: "transport-a",
        eventId: "event-a",
        tenantId: "tenant-a",
        name: "Desde Santo Tomé",
        address: "Av. 7 de Marzo 1800",
        price: "18000.00",
        latitude: "-31.6630000",
        longitude: "-60.7650000",
        isActive: true
      }
    ],
    customer_balances: [{ id: "balance-a", amount: "100000.00" }],
    sales: [],
    sale_transports: [],
    tickets: [],
    balance_movements: []
  }
  const queries: { table: string; params: unknown[] }[] = []
  const locks: string[] = []
  const db = {
    select: (shape?: Row) => {
      let table = ""
      let condition: never
      const chain: Row = {
        from: (source: never) => {
          table = getTableName(source)
          return chain
        },
        where: (where: never) => {
          condition = where
          return chain
        },
        limit: () => chain,
        orderBy: () => chain,
        for: () => {
          locks.push(table)
          return chain
        },
        then: (
          resolve: (rows: Row[]) => unknown,
          reject: (error: unknown) => unknown
        ) => {
          const query = new MySqlDialect().sqlToQuery(condition)
          queries.push({ table, params: query.params })
          const result =
            table === "tickets" && shape?.n
              ? [{ n: rows.tickets.length }]
              : (rows[table] ?? [])
          return Promise.resolve(result).then(resolve, reject)
        }
      }
      return chain
    },
    insert: (source: never) => ({
      values: async (value: Row) => {
        const table = getTableName(source)
        ;(rows[table] ??= []).push({ ...value })
      }
    }),
    update: (source: never) => ({
      set: (values: Row) => ({
        where: async () => {
          for (const row of rows[getTableName(source)] ?? [])
            Object.assign(row, values)
        }
      })
    })
  }
  return { db: db as never, rows, queries, locks }
}
const params = {
  eventId: "event-a",
  contact: {
    name: "Ana",
    email: "ana@example.com",
    phone: "1155550000",
    dni: "12345678"
  },
  clientTotal: "28000.00",
  ticketLines: [{ ticketTypeId: "ticket-a", quantity: 1 }],
  drinkLines: [],
  transportLines: [{ transportId: "transport-a", quantity: 1 }]
}
describe("checkout con transporte", () => {
  for (const paymentMethod of ["TRANSFER", "CARD", "MERCADOPAGO"] as const) {
    test(`${paymentMethod}: cobra el total, conserva la salida y cumple una sola vez`, async () => {
      const { db, rows, queries, locks } = fixture()
      const result = await executeClientCheckout(db, {
        ...params,
        paymentMethod
      })
      expect(rows.sales[0].totalAmount).toBe("28000.00")
      expect(rows.sales[0].status).toBe("PENDING")
      expect(rows.tickets).toHaveLength(0)
      expect(rows.sale_transports).toHaveLength(1)
      expect(rows.sale_transports[0]).toMatchObject({
        priceAtTime: "18000.00",
        name: "Desde Santo Tomé",
        address: "Av. 7 de Marzo 1800"
      })
      expect(
        queries.find((q) => q.table === "event_transports")?.params
      ).toEqual(["transport-a", "event-a", "tenant-a", true])
      // A delayed approved payment honors the purchased snapshot even if the route changes.
      rows.event_transports[0] = {
        ...rows.event_transports[0],
        price: "99999.00",
        address: "Otro lugar",
        isActive: false
      }
      await fulfillPendingGuestCheckout(db, result.saleId)
      await fulfillPendingGuestCheckout(db, result.saleId)
      expect(locks).toEqual(["sales", "sales"])
      expect(rows.sales[0].paid).toBe(true)
      expect(rows.sales[0].status).toBe("COMPLETED")
      expect(rows.tickets).toHaveLength(1)
      expect(rows.transport_tickets).toHaveLength(1)
      expect(rows.transport_tickets[0].ticketId).toBe(rows.tickets[0].id)
      expect(rows.transport_tickets[0].qrHash).not.toBe(rows.tickets[0].qrHash)
      expect(rows.sale_transports).toHaveLength(1)
      expect(rows.sale_transports[0].address).toBe("Av. 7 de Marzo 1800")
    })
  }
  test("saldo debita entradas y transporte juntos", async () => {
    const { db, rows } = fixture()
    const result = await executeClientCheckout(db, {
      ...params,
      paymentMethod: "SALDO"
    })
    expect(result.balance).toBe("72000.00")
    expect(rows.transport_tickets).toHaveLength(1)
    expect(rows.balance_movements[0].amount).toBe("28000.00")
    expect(rows.sales[0].paid).toBe(true)
    expect(rows.sale_transports).toHaveLength(1)
  })
  test("rechaza total adulterado y transporte ajeno o deshabilitado", async () => {
    const wrongTotal = fixture()
    await expect(
      executeClientCheckout(wrongTotal.db, {
        ...params,
        paymentMethod: "TRANSFER",
        clientTotal: "10000.00"
      })
    ).rejects.toThrow("CHECKOUT_TOTAL_MISMATCH")
    expect(wrongTotal.rows.sales).toHaveLength(0)
    const unavailable = fixture()
    unavailable.rows.event_transports = []
    await expect(
      executeClientCheckout(unavailable.db, {
        ...params,
        paymentMethod: "TRANSFER"
      })
    ).rejects.toThrow("TRANSPORT_NOT_FOUND")
    expect(unavailable.rows.sale_transports).toHaveLength(0)
  })
})

describe("operación con estados históricos", () => {
  test.each(["draft", "on_sale", "live", "closed"])("%s: el checkout cobra y emite sin cambiar el evento", async (status: string) => {
    const { db, rows } = fixture()
    rows.events[0].status = status
    const eventBefore = { ...rows.events[0] }
    await executeClientCheckout(db, { ...params, paymentMethod: "SALDO" })
    expect(rows.sales[0]).toMatchObject({ status: "COMPLETED", totalAmount: "28000.00" })
    expect(rows.tickets).toHaveLength(1)
    expect(rows.events[0]).toEqual(eventBefore)
  })

  test.each(["draft", "on_sale", "live", "closed"])("%s: emite entradas conservando tenant, cupo y horario", async (status: string) => {
    const { db, rows, queries } = fixture()
    rows.events[0].status = status
    rows.ticket_types[0] = { ...rows.ticket_types[0], tenantId: "tenant-a", eventId: "event-a", name: "General" }
    const result = await executeTicketPurchase(db, { eventId: "event-a", ticketTypeId: "ticket-a", buyerName: "Ana", buyerEmail: null, enforceTenantId: "tenant-a" })
    expect(result.ticket.tenantId).toBe("tenant-a")
    expect(rows.tickets).toHaveLength(1)
    expect(queries.find((q) => q.table === "ticket_types")?.params).toContain("tenant-a")
    expect(rows.events[0].status).toBe(status)
  })
})
