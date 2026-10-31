import { beforeEach, describe, expect, mock, test } from "bun:test"
import { getTableName, type SQL } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import { Hono } from "hono"
import { createAccessToken } from "../lib/jwt"

type Row = Record<string, any>
const dialect = new MySqlDialect()
let tables: Record<string, Row[]>
let writes: { table: string; values: Row }[]

const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())

function matching(table: string, row: Row, condition?: SQL): boolean {
  if (!condition) return true
  const query = dialect.sqlToQuery(condition)
  const pattern = /`([^`]+)`\.`([^`]+)` (= \?|<> \?|in \([^)]*\))/g
  for (const match of query.sql.matchAll(pattern)) {
    if (match[1] !== table) continue
    const firstParam = (query.sql.slice(0, match.index).match(/\?/g) ?? []).length
    const count = (match[3].match(/\?/g) ?? []).length
    const allowed = query.params.slice(firstParam, firstParam + count)
    const value = row[camel(match[2])]
    if (match[3].startsWith("<>") && !allowed.includes(value)) continue
    if (match[3].startsWith("<>")) return false
    if (!allowed.some((param) => param === value)) return false
  }
  return true
}

function fakeDb() {
  return {
    select: (fields?: Row) => {
      let table = ""
      let condition: SQL | undefined
      const chain: Row = {}
      chain.from = (source: never) => {
        table = getTableName(source)
        return chain
      }
      chain.where = (sql: SQL) => {
        condition = sql
        return chain
      }
      for (const method of [
        "innerJoin",
        "leftJoin",
        "orderBy",
        "limit",
        "for",
        "groupBy",
      ])
        chain[method] = () => chain
      chain.then = (resolve: (rows: Row[]) => unknown, reject: (e: unknown) => unknown) => {
        const rows = (tables[table] ?? []).filter((row) => matching(table, row, condition))
        const projected = rows.map((row) => {
          if (!fields) return { ...row }
          const result: Row = {}
          for (const [alias, field] of Object.entries(fields)) {
            if (field?.name && field?.table) {
              const fieldTable = getTableName(field.table)
              result[alias] = fieldTable === table ? row[camel(field.name)] : null
            } else {
              result[alias] = row[alias]
            }
          }
          return result
        })
        return Promise.resolve(projected).then(resolve, reject)
      }
      return chain
    },
    insert: (source: never) => ({
      values: async (values: Row | Row[]) => {
        const table = getTableName(source)
        for (const row of Array.isArray(values) ? values : [values]) {
          writes.push({ table, values: row })
          ;(tables[table] ??= []).push({ ...row })
        }
      },
    }),
    update: (source: never) => ({
      set: (values: Row) => ({
        where: async (condition: SQL) => {
          const table = getTableName(source)
          writes.push({ table, values })
          for (const row of tables[table] ?? [])
            if (matching(table, row, condition)) Object.assign(row, values)
        },
      }),
    }),
    transaction: async (run: (tx: any) => unknown): Promise<any> => {
      const snapshot = structuredClone(tables)
      const count = writes.length
      try {
        return await run(fakeDb())
      } catch (error) {
        tables = snapshot
        writes.length = count
        throw error
      }
    },
  }
}

mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: () => fakeDb() }))

const { depositRoute } = await import("./deposit")
const app = new Hono().route("/events", depositRoute)

beforeEach(() => {
  writes = []
  tables = {
    staff: [
      {
        id: "worker",
        tenantId: "tenant-a",
        name: "Encargado",
        email: "dep@example.test",
        role: "DEPOSIT",
        roles: null,
        isActive: true,
      },
    ],
    events: [
      {
        id: "event-a",
        tenantId: "tenant-a",
        name: "Evento",
        operationMode: "FULL_OPERATION",
      },
    ],
    inventory_items: [
      {
        id: "item-1",
        tenantId: "tenant-a",
        name: "Fernet",
        isActive: true,
        baseUnit: "UNIT",
        packageSize: "1.00",
        countingUnit: "unidades",
      },
    ],
    bars: [
      {
        id: "bar-a",
        eventId: "event-a",
        tenantId: "tenant-a",
        name: "Barra 1",
        isActive: true,
      },
    ],
    event_staff: [
      {
        id: "assignment-1",
        eventId: "event-a",
        tenantId: "tenant-a",
        staffId: "worker",
      },
    ],
    event_inventory: [],
    bar_inventory: [],
    event_stock_movements: [],
    purchases: [],
    event_expenses: [],
  }
})

async function request(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await createAccessToken("worker")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

const stockBody = {
  inventoryItemId: "item-1",
  mode: "add" as const,
  quantity: "10",
  expectedDepositStock: "0",
}

describe("deposit stock", () => {
  test("rejects a deposit account that is not assigned to the event", async () => {
    tables.event_staff = []
    const response = await request("/events/event-a/deposit/stock", stockBody)
    expect(response.status).toBe(403)
    expect(tables.event_inventory).toHaveLength(0)
  })

  test("loads stock once and replays the same request without duplicating it", async () => {
    expect((await request("/events/event-a/deposit/stock", stockBody)).status).toBe(200)
    expect(tables.event_inventory[0].stockAllocated).toBe("10.000000")
    expect(tables.event_stock_movements).toHaveLength(1)
    expect(tables.event_stock_movements[0].depositAfter).toBe("10.000000")

    expect((await request("/events/event-a/deposit/stock", stockBody)).status).toBe(200)
    expect(tables.event_inventory[0].stockAllocated).toBe("10.000000")
    expect(tables.event_stock_movements).toHaveLength(1)
  })

  test("counts the deposit against the stock already in bars", async () => {
    tables.event_inventory = [
      {
        id: "ev-1",
        eventId: "event-a",
        tenantId: "tenant-a",
        inventoryItemId: "item-1",
        stockAllocated: "10.000000",
      },
    ]
    tables.bar_inventory = [
      {
        id: "bi-1",
        barId: "bar-a",
        tenantId: "tenant-a",
        inventoryItemId: "item-1",
        currentStock: "4.000000",
      },
    ]
    const response = await request("/events/event-a/deposit/stock", {
      inventoryItemId: "item-1",
      mode: "count",
      quantity: "3",
      expectedDepositStock: "6",
    })
    expect(response.status).toBe(200)
    expect(tables.event_inventory[0].stockAllocated).toBe("7.000000")
    expect(tables.event_stock_movements[0].type).toBe("DEPOSIT_COUNT")
    expect(tables.event_stock_movements[0].depositAfter).toBe("3.000000")
  })
})

describe("deposit transfers", () => {
  beforeEach(() => {
    tables.event_inventory = [
      {
        id: "ev-1",
        eventId: "event-a",
        tenantId: "tenant-a",
        inventoryItemId: "item-1",
        stockAllocated: "10.000000",
      },
    ]
  })

  test("sends stock to a bar, records it and replays safely", async () => {
    const body = {
      inventoryItemId: "item-1",
      barId: "bar-a",
      quantity: "6",
      expectedDepositStock: "10",
      expectedBarStock: "0",
    }
    expect((await request("/events/event-a/deposit/transfers", body)).status).toBe(200)
    expect(tables.bar_inventory[0].currentStock).toBe("6.000000")
    expect(tables.event_inventory[0].stockAllocated).toBe("10.000000")
    expect(tables.event_stock_movements).toHaveLength(1)
    expect(tables.event_stock_movements[0].type).toBe("SEND_TO_BAR")
    expect(tables.event_stock_movements[0].depositAfter).toBe("4.000000")

    expect((await request("/events/event-a/deposit/transfers", body)).status).toBe(200)
    expect(tables.bar_inventory[0].currentStock).toBe("6.000000")
    expect(tables.event_stock_movements).toHaveLength(1)
  })

  test("rejects sending more than the deposit has without writing", async () => {
    const response = await request("/events/event-a/deposit/transfers", {
      inventoryItemId: "item-1",
      barId: "bar-a",
      quantity: "11",
      expectedDepositStock: "10",
      expectedBarStock: "0",
    })
    expect(response.status).toBe(409)
    expect(tables.bar_inventory).toHaveLength(0)
    expect(tables.event_stock_movements).toHaveLength(0)
  })

  test("rejects a stale deposit snapshot", async () => {
    const response = await request("/events/event-a/deposit/transfers", {
      inventoryItemId: "item-1",
      barId: "bar-a",
      quantity: "5",
      expectedDepositStock: "8",
      expectedBarStock: "0",
    })
    expect(response.status).toBe(409)
    expect(tables.bar_inventory).toHaveLength(0)
  })
})
