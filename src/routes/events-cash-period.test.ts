import { beforeEach, expect, mock, test } from "bun:test"
import type { Context, Next } from "hono"
import { getTableName } from "drizzle-orm"

let role = "ADMIN"
let tenantId: string | undefined = "tenant-a"
let eventExists = true
let queried: string[] = []
const fakeDb = () => ({
  select: () => {
    let table = ""
    const chain: Record<string, unknown> = {}
    for (const method of ["where", "limit", "groupBy"]) chain[method] = () => chain
    chain.from = (source: unknown) => { table = getTableName(source as never); return chain }
    chain.then = (resolve: (rows: unknown[]) => unknown) => {
      queried.push(table)
      const rows = table === "events" ? (eventExists ? [{ id: "event-a", tenantId: "tenant-a", status: "live" }] : []) : []
      return Promise.resolve(rows).then(resolve)
    }
    return chain
  },
})
mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: () => fakeDb() }))
mock.module("../middleware/auth", () => ({ authMiddleware: async (c: Context, next: Next) => {
  Object.assign(c, { staff: { id: "staff-a", role, tenantId } })
  await next()
} }))
// @ts-expect-error Bun supports a separate module instance for the route mocks.
const { eventsRoute } = await import("./events?cash-period")
const get = (query = "from=2026-10-09&to=2026-10-10") => eventsRoute.request(`/event-a/cash-period?${query}`)
beforeEach(() => { role = "ADMIN"; tenantId = "tenant-a"; eventExists = true; queried = [] })

test.each(["ADMIN", "MANAGER"])("%s puede consultar sin modificar el evento", async (staffRole: string) => {
  role = staffRole
  const response = await get()
  expect(response.status).toBe(200)
  expect((await response.json()).period).toEqual({ from: "2026-10-09", to: "2026-10-10", timezone: "America/Argentina/Buenos_Aires" })
  expect(queried).toContain("events")
  // The fake DB has no insert/update/delete methods: this request must only read.
})
test.each(["BARTENDER", "SECURITY", "PROMOTER", "GENERAL_PROMOTER", "TRANSPORTER"])("%s no accede a caja", async (staffRole: string) => {
  role = staffRole
  expect((await get()).status).toBe(403)
  expect(queried).toEqual([])
})
test("evento inexistente o fuera del tenant no entrega métricas", async () => {
  eventExists = false
  expect((await get()).status).toBe(404)
  expect(queried).toEqual(["events"])
})
test("sin tenant rechaza antes de consultar", async () => {
  tenantId = undefined
  expect((await get()).status).toBe(400)
  expect(queried).toEqual([])
})
test.each(["", "from=2026-10-12&to=2026-10-09", "from=2026-02-30&to=2026-03-02"])("fechas inválidas: %s", async (query: string) => {
  expect((await get(query)).status).toBe(400)
  expect(queried).toEqual([])
})
