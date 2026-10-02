import { beforeEach, describe, expect, mock, test } from "bun:test"
import { getTableName, type SQL } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import type { Context, Next } from "hono"

// Endpoints reales, sin credenciales ni DB. Se evalúan los filtros SQL sencillos del flujo
// (tenant, evento, producto, activo) y se registran las escrituras de la transacción.
type Row = Record<string, any>
const dialect = new MySqlDialect()
let tables: Record<string, Row[]>
let staff: Row
let writes: { table: string; values: Row }[]
let transactionTail: Promise<unknown> = Promise.resolve()
let debits = 0
let credits = 0
let failingTable: string | null = null
let queries: { table: string; sql: string; params: unknown[] }[]
const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

function matching(table: string, row: Row, condition?: SQL): boolean {
  if (!condition) return true
  const query = dialect.sqlToQuery(condition)
  // Los joins se proyectan abajo; acá sólo se filtran columnas de la tabla fuente.
  const pattern = /`([^`]+)`\.`([^`]+)` (= \?|in \([^)]*\))/g
  for (const match of query.sql.matchAll(pattern)) {
    if (match[1] !== table) continue
    const firstParam = (query.sql.slice(0, match.index).match(/\?/g) ?? []).length
    const count = (match[3].match(/\?/g) ?? []).length
    const allowed = query.params.slice(firstParam, firstParam + count)
    const value = row[camel(match[2])]
    if (!allowed.some((param) => param === value || (typeof value === "boolean" && Number(value) === param))) return false
  }
  return true
}

function fakeDb() {
  const db: any = {
    select: (fields?: Row) => {
      let table = ""
      let condition: SQL | undefined
      const chain: Row = {}
      chain.from = (source: never) => { table = getTableName(source); return chain }
      chain.where = (sql: SQL) => { condition = sql; return chain }
      for (const method of ["innerJoin", "leftJoin", "orderBy", "limit", "for"]) chain[method] = () => chain
      chain.then = (resolve: (rows: Row[]) => unknown, reject: (e: unknown) => unknown) => {
        const query = condition ? dialect.sqlToQuery(condition) : { sql: "", params: [] }
        queries.push({ table, ...query })
        const rows = (tables[table] ?? []).filter((row) => matching(table, row, condition))
        const projected = rows.map((row) => {
          if (!fields) return { ...row }
          const result: Row = {}
          for (const [alias, field] of Object.entries(fields)) {
            if (field?.name && field?.table) {
              const fieldTable = getTableName(field.table)
              const source = fieldTable === table ? row : (tables[fieldTable] ?? []).find((joined) =>
                fieldTable === "event_products" ? joined.productId === row.id :
                fieldTable === "product_categories" ? joined.id === row.categoryId : false
              )
              result[alias] = source?.[camel(field.name)] ?? null
            } else if (alias === "m") result[alias] = Math.max(0, ...rows.map((r) => Number(r.sortOrder)))
            else if (alias === "price") {
              const sql = dialect.sqlToQuery(field).sql
              expect(sql).toContain("coalesce")
              result[alias] = tables.event_products.find((p) => p.productId === row.id)?.priceOverride ?? row.price
            }
          }
          return result
        })
        return Promise.resolve(projected).then(resolve, reject)
      }
      return chain
    },
    insert: (source: never) => ({ values: (values: Row | Row[]) => {
      const table = getTableName(source)
      const commit = () => {
        if (table === failingTable) throw new Error("Simulated transaction failure")
        for (const row of Array.isArray(values) ? values : [values]) {
          writes.push({ table, values: row }); (tables[table] ??= []).push({ ...row })
        }
      }
      return {
        then: (resolve: any, reject: any) => Promise.resolve().then(commit).then(resolve, reject),
        onDuplicateKeyUpdate: () => Promise.resolve().then(() => {
          if (!(tables[table] ?? []).some((row) => row.id === (values as Row).id)) commit()
        }),
      }
    } }),
    update: (source: never) => ({ set: (values: Row) => ({ where: async (condition: SQL) => {
      const table = getTableName(source)
      writes.push({ table, values })
      for (const row of tables[table] ?? []) if (matching(table, row, condition)) Object.assign(row, values)
    } }) }),
    delete: (source: never) => ({ where: async (condition: SQL) => {
      const table = getTableName(source)
      tables[table] = (tables[table] ?? []).filter((r) => !matching(table, r, condition))
    } }),
    transaction: (run: (tx: any) => unknown): Promise<any> => {
      const result = transactionTail.then(async () => {
        const snapshot = structuredClone(tables)
        const priorWrites = writes.length
        try { return await run(db) } catch (error) { tables = snapshot; writes.length = priorWrites; throw error }
      })
      transactionTail = result.catch(() => {})
      return result
    },
  }
  return db
}

mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: fakeDb }))
mock.module("../middleware/auth", () => ({ authMiddleware: async (c: Context, next: Next) => { Object.assign(c, { staff }); await next() } }))
mock.module("../lib/client-checkout", () => ({ findOrCreateCustomer: async () => "customer-1" }))
mock.module("../lib/balance", () => ({
  getBalance: async () => "100.00",
  debitBalance: async () => { debits++; return "99.70" },
  creditBalance: async () => { credits++; return "110.00" },
}))
// @ts-expect-error Isolated instance with this test's middleware and database.
const { inventoryRoute } = await import("./inventory?offline-pos")
const request = (body: unknown) => inventoryRoute.request("/sales", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
})
const baseSale = () => ({
  requestId: crypto.randomUUID(), eventId: "event-1", barId: "bar-1", allowNegativeStock: true,
  paymentMethod: "CASH", items: [{ productId: "water", quantity: 3 }],
  clientSale: {
    receiptToken: crypto.randomUUID(), createdAt: "2026-01-01T22:00:00.000Z",
    lines: [{ productId: "water", priceAtTime: "0.10", qrHashes: Array.from({ length: 3 }, () => crypto.randomUUID()) }],
  },
})
beforeEach(() => {
  staff = { id: "staff-1", tenantId: "tenant-1", role: "BARTENDER" }
  writes = []; queries = []; debits = 0; credits = 0; failingTable = null; transactionTail = Promise.resolve()
  tables = {
    events: [{ id: "event-1", tenantId: "tenant-1", operationMode: "FULL_OPERATION" }],
    bars: [{ id: "bar-1", eventId: "event-1", tenantId: "tenant-1" }],
    products: [{ id: "water", tenantId: "tenant-1", name: "Agua", price: "0.10", saleType: "GLASS", isActive: true }],
    event_products: [{ id: "ep-water", tenantId: "tenant-1", eventId: "event-1", productId: "water", isActive: true, priceOverride: null, directStock: "10.00" }],
  }
})

describe("POST /inventory/sales: cola POS e idempotencia", () => {
  test("registra los mismos tokens y fecha que ya se imprimieron, con Decimal", async () => {
    const body = baseSale()
    const res = await request(body)
    expect(res.status).toBe(201)
    const response = await res.json() as any
    expect(response).toMatchObject({ saleId: body.requestId, receiptToken: body.clientSale.receiptToken, totalAmount: "0.30" })
    expect(response.consumptions.map((line: any) => line.qrHash)).toEqual(body.clientSale.lines[0].qrHashes)
    expect(tables.sales[0].createdAt.toISOString()).toBe(body.clientSale.createdAt)
    expect(tables.event_products[0].directStock).toBe("7.00")
    expect(tables.pos_sale_requests[0].response).toEqual(response)
  })
  test("reintentar tras perder la respuesta no duplica venta, QR ni stock", async () => {
    const body = baseSale()
    const first = await request(body)
    const payload = await first.json()
    const writesAfterFirst = writes.length
    const second = await request(body)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual(payload)
    expect(writes.length).toBe(writesAfterFirst)
    expect(tables.sales).toHaveLength(1)
    expect(tables.digital_consumptions).toHaveLength(3)
    expect(tables.event_products[0].directStock).toBe("7.00")
  })
  test("dos envíos simultáneos de la misma venta retornan una sola operación", async () => {
    const body = baseSale()
    const responses = await Promise.all([request(body), request(body)])
    expect(responses.map((res) => res.status).sort()).toEqual([200, 201])
    expect(tables.sales).toHaveLength(1)
    expect(tables.event_products[0].directStock).toBe("7.00")
  })
  test("cambiar la carga útil de un identificador usado responde 409", async () => {
    const body = baseSale()
    await request(body)
    expect((await request({ ...body, paymentMethod: "CARD" })).status).toBe(409)
    expect(tables.sales).toHaveLength(1)
  })
  test("otro tenant o empleado no puede reutilizar ni ver la respuesta", async () => {
    const body = baseSale()
    await request(body)
    staff.id = "staff-2"
    expect((await request(body)).status).toBe(409)
    staff.tenantId = "tenant-2"
    expect((await request(body)).status).toBe(409)
    expect(tables.sales).toHaveLength(1)
  })
  test("un cambio de precio deja el ticket para revisión sin alterar el importe cobrado", async () => {
    const body = baseSale()
    tables.event_products[0].priceOverride = "0.20"
    expect((await request(body)).status).toBe(409)
    expect(tables.sales ?? []).toHaveLength(0)
    expect(tables.event_products[0].directStock).toBe("10.00")
  })
  test("saldo online se debita una única vez incluso al reintentar", async () => {
    const { clientSale, ...body } = baseSale()
    const saldo = { ...body, paymentMethod: "SALDO", customerDni: "12345678" }
    expect((await request(saldo)).status).toBe(201)
    expect((await request(saldo)).status).toBe(200)
    expect(debits).toBe(1)
    expect(tables.sales).toHaveLength(1)
  })
  test("saldo no debita un importe distinto del que aceptó el operador", async () => {
    const { clientSale, ...body } = baseSale()
    const saldo = { ...body, paymentMethod: "SALDO", customerDni: "12345678", expectedTotalAmount: "0.20" }
    expect((await request(saldo)).status).toBe(409)
    expect(debits).toBe(0)
    expect(tables.sales ?? []).toHaveLength(0)
  })
  test("carga de saldo offline y productos se confirman una vez juntos", async () => {
    const body = { ...baseSale(), balanceCharge: "10.00", customerDni: "12345678" }
    const first = await request(body)
    expect(first.status).toBe(201)
    expect((await first.json() as any).totalAmount).toBe("10.30")
    expect((await request(body)).status).toBe(200)
    expect(credits).toBe(1)
    expect(tables.sales).toHaveLength(2)
    expect(tables.sales[0].barId).toBe("bar-1")
  })
  test("carga sola conserva el token impreso y no inventa consumiciones", async () => {
    const body = baseSale()
    body.items = []
    body.clientSale.lines = []
    const deposit = { ...body, balanceCharge: "10.00", customerDni: "12345678" }
    const first = await request(deposit)
    expect(first.status).toBe(201)
    expect(await first.json()).toMatchObject({ saleId: body.requestId, receiptToken: body.clientSale.receiptToken, totalAmount: "10.00", consumptions: [] })
    await request(deposit)
    expect(credits).toBe(1)
  })
  test("rechaza saldo offline, QR faltantes o repetidos y productos de otro evento", async () => {
    const body = baseSale()
    expect((await request({ ...body, paymentMethod: "SALDO", customerDni: "12345678" })).status).toBe(400)
    body.clientSale.lines[0].qrHashes.pop()
    expect((await request(body)).status).toBe(400)
    body.clientSale.lines[0].qrHashes = Array(3).fill(crypto.randomUUID())
    expect((await request(body)).status).toBe(400)
    expect(tables.sales ?? []).toHaveLength(0)
    const foreign = baseSale()
    tables.event_products[0].eventId = "other-event"
    expect((await request(foreign)).status).toBe(400)
    expect(tables.sales ?? []).toHaveLength(0)
  })
  test("roles ajenos al POS no pueden registrar ni reproducir ventas", async () => {
    staff.role = "SECURITY"
    expect((await request(baseSale())).status).toBe(403)
    expect(writes).toHaveLength(0)
  })
  test("un fallo de fulfillment revierte la reserva y las ventas antes de reintentar", async () => {
    const body = baseSale()
    failingTable = "digital_consumptions"
    expect((await request(body)).status).toBe(500)
    expect(tables.sales ?? []).toHaveLength(0)
    expect(tables.pos_sale_requests ?? []).toHaveLength(0)
    expect(tables.event_products[0].directStock).toBe("10.00")
    failingTable = null
    expect((await request(body)).status).toBe(201)
    expect(tables.sales).toHaveLength(1)
    expect(tables.event_products[0].directStock).toBe("7.00")
  })
})
