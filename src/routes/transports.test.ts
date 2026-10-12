import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Context, Next } from "hono"
import { getTableName } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"

let role = "ADMIN"
let closed = false
let inserted: Record<string, unknown>[] = []
let queryParams: unknown[][] = []
const db = {
  select: () => {
    let table = ""
    let params: unknown[] = []
    const chain = {
      from: (source: never) => {
        table = getTableName(source)
        return chain
      },
      innerJoin: () => chain,
      where: (where: never) => {
        params = new MySqlDialect().sqlToQuery(where).params
        queryParams.push(params)
        return chain
      },
      orderBy: () => chain,
      limit: () => chain,
      for: () => chain,
      then: (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(
          table === "events" &&
            params[0] === "event-a" &&
            params[1] === "tenant-a"
            ? [{ id: "event-a", status: closed ? "closed" : "on_sale" }]
            : table === "event_transports" && params[0] === "transport-a"
              ? [{ id: "transport-a" }]
              : []
        ).then(resolve)
    }
    return chain
  },
  insert: () => ({
    values: async (row: Record<string, unknown>) => {
      inserted.push(row)
    }
  }),
  update: () => ({
    set: (row: Record<string, unknown>) => ({
      where: async () => {
        inserted.push(row)
      }
    })
  }),
  transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db)
}
mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: () => db }))
mock.module("../middleware/auth", () => ({
  authMiddleware: async (c: Context, next: Next) => {
    Object.assign(c, { staff: { tenantId: "tenant-a", role } })
    await next()
  }
}))
// @ts-expect-error Bun supports a query string to isolate mocked routes.
const { transportsRoute } = await import("./transports?transport-tests")
const body = {
  name: "Desde Santo Tomé",
  address: "Av. 7 de Marzo 1800",
  price: "18000.00",
  latitude: -31.663,
  longitude: -60.765
}
const request = (path = "/event-a", method = "POST", input = body) =>
  transportsRoute.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  })
beforeEach(() => {
  role = "ADMIN"
  closed = false
  inserted = []
  queryParams = []
})
describe("administración de transporte", () => {
  test("solamente ADMIN y MANAGER pueden leer o modificar", async () => {
    for (const denied of [
      "BARTENDER",
      "SECURITY",
      "PROMOTER",
      "GENERAL_PROMOTER"
    ]) {
      role = denied
      expect((await request()).status).toBe(403)
      expect((await transportsRoute.request("/event-a")).status).toBe(403)
    }
    expect(inserted).toHaveLength(0)
    role = "MANAGER"
    expect((await request()).status).toBe(201)
  })
  test("crea una salida asignada al evento y al tenant autenticado", async () => {
    expect((await request()).status).toBe(201)
    expect(inserted[0]).toMatchObject({
      tenantId: "tenant-a",
      eventId: "event-a",
      price: "18000.00",
      latitude: "-31.6630000",
      longitude: "-60.7650000",
      isActive: true
    })
    expect(queryParams[0]).toEqual(["event-a", "tenant-a"])
  })
  test("rechaza eventos ajenos, cerrados y ubicación inválida sin escribir", async () => {
    expect((await request("/event-other-tenant")).status).toBe(404)
    closed = true
    expect((await request()).status).toBe(409)
    expect(
      (await request("/event-a", "POST", { ...body, latitude: 91 })).status
    ).toBe(400)
    expect(inserted).toHaveLength(0)
  })
  test("la edición valida el transporte dentro del evento y tenant", async () => {
    expect((await request("/event-a/transport-a", "PUT")).status).toBe(200)
    expect(queryParams[1]).toEqual(["transport-a", "event-a", "tenant-a"])
    expect((await request("/event-a/transport-other", "PUT")).status).toBe(404)
  })
})
