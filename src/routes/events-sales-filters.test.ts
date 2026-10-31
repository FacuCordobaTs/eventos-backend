import { beforeEach, expect, mock, test } from "bun:test"
import type { Context, Next } from "hono"
import { getTableName } from "drizzle-orm"

let queried: string[] = []
const fakeDb = () => ({
  select: () => {
    let table = ""
    const chain: Record<string, unknown> = {}
    for (const method of ["where", "limit", "offset", "orderBy", "leftJoin", "innerJoin"]) chain[method] = () => chain
    chain.from = (source: unknown) => { table = getTableName(source as never); return chain }
    chain.then = (resolve: (rows: unknown[]) => unknown) => {
      queried.push(table)
      return Promise.resolve(table === "events" ? [{ id: "event-a", tenantId: "tenant-a" }] : []).then(resolve)
    }
    return chain
  },
})
mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: () => fakeDb() }))
mock.module("../middleware/auth", () => ({ authMiddleware: async (c: Context, next: Next) => {
  Object.assign(c, { staff: { id: "staff-a", role: "ADMIN", tenantId: "tenant-a" } })
  await next()
} }))
// @ts-expect-error Bun supports a separate module instance for the route mocks.
const { eventsRoute } = await import("./events?sales-filters")
const get = (query: string) => eventsRoute.request(`/event-a/sales?${query}`)
beforeEach(() => { queried = [] })

test.each(["source=WEB", "source=POS", "source=WEB&status=PENDING", "status=COMPLETED", ""])("acepta el filtro '%s'", async (query: string) => {
  expect((await get(query)).status).toBe(200)
  expect(queried).toContain("sales")
})
test.each(["source=OTRO", "status=REFUNDED", "status=PAYMENT_FAILED"])("rechaza '%s' sin consultar", async (query: string) => {
  expect((await get(query)).status).toBe(400)
  expect(queried).toEqual([])
})
