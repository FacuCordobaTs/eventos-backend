import { beforeEach, describe, expect, mock, test } from "bun:test"
import { getTableName, type SQL } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import type { Context, Next } from "hono"

type Row = Record<string, unknown>
let role = "ADMIN"
let row: Row
let writes: Row[] = []
let reads: { table: string; params: unknown[] }[] = []
const db = {
  select: (shape?: Row) => {
    let table = ""
    let where: SQL
    const q = {
      from: (source: never) => {
        table = getTableName(source)
        return q
      },
      where: (condition: SQL) => {
        where = condition
        return q
      },
      innerJoin: () => q,
      limit: () => q,
      then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) => {
        const params = new MySqlDialect().sqlToQuery(where).params
        reads.push({ table, params })
        const matches =
          !params.includes("foreign-event") &&
          !params.includes("foreign-type") &&
          !params.includes("foreign-tenant")
        const rows = !matches
          ? []
          : shape?.n
            ? [{ n: 0 }]
            : table === "ticket_types"
              ? [row]
              : table === "events"
                ? [{ id: "event", tenantId: "tenant" }]
                : []
        return Promise.resolve(rows).then(resolve, reject)
      }
    }
    return q
  },
  update: () => ({
    set: (patch: Row) => ({
      where: async (condition: SQL) => {
        const params = new MySqlDialect().sqlToQuery(condition).params
        expect(params).toContain("tenant")
        writes.push(patch)
        Object.assign(row, patch)
      }
    })
  }),
  insert: () => ({
    values: async (value: Row) => {
      writes.push(value)
      row = value
    }
  })
}
mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: () => db }))
mock.module("../middleware/auth", () => ({
  authMiddleware: async (c: Context, next: Next) => {
    Object.assign(c, { staff: { id: "staff", tenantId: "tenant", role } })
    await next()
  }
}))
// @ts-expect-error Bun permite aislar la instancia de la ruta entre archivos de prueba.
const { eventsRoute } = await import("./events?ticket-types")
const patch = (body: Row, eventId = "event", typeId = "type") =>
  eventsRoute.request(`/${eventId}/ticket-types/${typeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
beforeEach(() => {
  role = "ADMIN"
  writes = []
  reads = []
  row = {
    id: "type",
    eventId: "event",
    tenantId: "tenant",
    name: "General",
    price: "12000.00",
    stockLimit: 100,
    isActive: true,
    validFrom: null,
    validUntil: null
  }
})
describe("administración de tipos de entrada", () => {
  test("desactiva y reactiva sin modificar precio, cupo ni entradas emitidas", async () => {
    expect((await patch({ isActive: false })).status).toBe(200)
    expect(row).toMatchObject({ isActive: false, price: "12000.00", stockLimit: 100 })
    role = "MANAGER"
    const res = await patch({ isActive: true })
    expect(res.status).toBe(200)
    expect((await res.json()).ticketType.isActive).toBe(true)
    expect(writes).toEqual([{ isActive: false }, { isActive: true }])
    expect(reads.find((r) => r.table === "ticket_types")?.params).toEqual([
      "type",
      "event",
      "tenant"
    ])
  })
  test.each(["BARTENDER", "SECURITY", "PROMOTER", "GENERAL_PROMOTER"])(
    "%s no administra tipos",
    async (value: string) => {
      role = value
      expect((await patch({ isActive: false })).status).toBe(403)
      const create = await eventsRoute.request("/event/ticket-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "VIP", price: "10.10" })
      })
      expect(create.status).toBe(403)
      expect(
        (await eventsRoute.request("/event/ticket-types/type", { method: "DELETE" })).status
      ).toBe(403)
      expect(reads).toEqual([])
      expect(writes).toEqual([])
    }
  )
  test("no actualiza un tipo de otro evento", async () => {
    expect((await patch({ isActive: false }, "foreign-event")).status).toBe(404)
    expect(writes).toEqual([])
  })
  test("no actualiza un id ajeno", async () => {
    expect((await patch({ isActive: false }, "event", "foreign-type")).status).toBe(404)
    expect(writes).toEqual([])
  })
  test("guarda precio decimal, promoción y ventana en una sola actualización", async () => {
    const res = await patch({
      name: "VIP",
      price: "12345.67",
      promoBuy: 2,
      promoPay: 1,
      validFrom: "2026-11-22T21:00:00-03:00",
      validUntil: "2026-11-23T02:00:00-03:00"
    })
    expect(res.status).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ name: "VIP", price: "12345.67", promoBuy: 2, promoPay: 1 })
    expect((await res.json()).ticketType.validUntil).toBe("2026-11-23T05:00:00.000Z")
  })
  test("rechaza importes inválidos y ventanas invertidas sin escribir", async () => {
    expect((await patch({ price: "123.456" })).status).toBe(400)
    expect(
      (
        await patch({
          validFrom: "2026-11-22T22:00:00-03:00",
          validUntil: "2026-11-22T21:00:00-03:00"
        })
      ).status
    ).toBe(400)
    expect(writes).toEqual([])
  })
  test("el listado ya no consulta tandas ni devuelve precios alternativos", async () => {
    const res = await eventsRoute.request("/event/ticket-types")
    expect(res.status).toBe(200)
    const type = (await res.json()).ticketTypes[0]
    expect(type.price).toBe("12000.00")
    expect(type).not.toHaveProperty("tiers")
    expect(type).not.toHaveProperty("effectivePrice")
    expect(reads.map((r) => r.table)).not.toContain("ticket_tiers")
  })
  test("el endpoint retirado de tandas devuelve 404", async () => {
    expect(
      (
        await eventsRoute.request("/event/ticket-types/type/tiers", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tiers: [] })
        })
      ).status
    ).toBe(404)
    expect(writes).toEqual([])
  })
})
