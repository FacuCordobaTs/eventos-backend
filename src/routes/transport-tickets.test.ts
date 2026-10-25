import { beforeEach, expect, mock, test } from "bun:test"
import { getTableName } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import type { Context, Next } from "hono"

const eventId = "11111111-1111-4111-8111-111111111111"
const transportId = "22222222-2222-4222-8222-222222222222"
let role = "TRANSPORTER", assigned = true, closed = false, payment = "COMPLETED"
let pass = { id: "pass-1", customerId: "buyer", buyerName: "Ana", buyerDni: "30123456", qrHash: "bus-qr", status: "PENDING" }
const reads: { table: string; params: unknown[]; locked: boolean }[] = []
const writes: Record<string, unknown>[] = []
const db = {
  selectDistinct: () => chain(true), select: () => chain(),
  transaction: async (run: (tx: unknown) => unknown) => run(db),
  update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { writes.push(values); Object.assign(pass, values); return [{ affectedRows: 1 }] } }) })
}
function chain(empty = false) {
  let table = "", params: unknown[] = [], locked = false
  const query = {
    from: (source: never) => { table = getTableName(source); return query }, innerJoin: () => query,
    where: (where: never) => { params = new MySqlDialect().sqlToQuery(where).params; return query }, limit: () => query, orderBy: () => query,
    for: () => { locked = true; return query },
    then: (resolve: (rows: unknown[]) => unknown) => {
      reads.push({ table, params, locked })
      let rows: unknown[] = []
      if (!empty) {
        if (table === "events" && params[0] === eventId && params[1] === "tenant-a" && (role !== "TRANSPORTER" || assigned)) rows = [{ id: eventId, status: closed ? "closed" : "live" }]
        if (table === "event_staff" && assigned) rows = [{ id: "assignment" }]
        if (table === "transport_tickets" && params.includes(transportId) && params.includes(eventId) && params.includes("tenant-a") && (params.includes(pass.qrHash) || (params.includes(pass.buyerDni) && pass.status === "PENDING"))) rows = [{ pass: { ...pass }, booking: { transportId, name: "Desde Santo Tomé" }, saleStatus: payment, receiptToken: "receipt" }]
      }
      return Promise.resolve(rows).then(resolve)
    }
  }
  return query
}
mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: () => db }))
mock.module("../middleware/auth", () => ({ authMiddleware: async (c: Context, next: Next) => { Object.assign(c, { staff: { id: "driver", role, tenantId: "tenant-a" } }); await next() } }))
// @ts-expect-error Bun isolates the route fixture by query string.
const { transportTicketsRoute } = await import("./transport-tickets?boarding-tests")
beforeEach(() => { role = "TRANSPORTER"; assigned = true; closed = false; payment = "COMPLETED"; pass = { id: "pass-1", customerId: "buyer", buyerName: "Ana", buyerDni: "30123456", qrHash: "bus-qr", status: "PENDING" }; reads.length = 0; writes.length = 0 })
const scan = (body: Record<string, unknown> = {}, path = "/validate") => transportTicketsRoute.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId, transportId, qrHash: "bus-qr", ...body }) })
test("QR de colectivo registra una subida con empleado y fecha, bajo lock", async () => {
  const response = await scan()
  expect(response.status).toBe(200)
  expect((await response.json()).ticketTypeName).toBe("Desde Santo Tomé")
  expect(writes[0]).toMatchObject({ status: "USED", boardedBy: "driver" })
  expect(writes[0].boardedAt).toBeInstanceOf(Date)
  expect(reads.filter((r) => r.locked).map((r) => r.table)).toEqual(["event_staff", "events", "transport_tickets"])
})
test("el mismo QR se consume una sola vez, incluso desde otro teléfono", async () => {
  expect((await scan()).status).toBe(200)
  expect((await scan()).status).toBe(409)
  expect(writes).toHaveLength(1)
})
test("DNI usa únicamente pasajes pendientes de la salida seleccionada", async () => {
  expect((await scan({ dni: "30123456", qrHash: undefined }, "/validate-by-dni")).status).toBe(200)
  expect((await scan({ dni: "30123456", qrHash: undefined }, "/validate-by-dni")).status).toBe(404)
})
test("no sirve un QR de entrada, otra salida ni otro evento", async () => {
  expect((await scan({ qrHash: "entry-qr" })).status).toBe(404)
  expect((await scan({ transportId: "33333333-3333-4333-8333-333333333333" })).status).toBe(404)
  expect((await scan({ eventId: "33333333-3333-4333-8333-333333333333" })).status).toBe(403)
  expect(writes).toHaveLength(0)
})
test("requiere rol autorizado y asignación vigente en el evento", async () => {
  role = "SECURITY"; expect((await scan()).status).toBe(403)
  role = "TRANSPORTER"; assigned = false; expect((await scan()).status).toBe(403)
  expect(writes).toHaveLength(0)
})
test("pasaje cancelado y pago pendiente no registran subidas", async () => {
  pass.status = "CANCELLED"; expect((await scan()).status).toBe(409)
  pass.status = "PENDING"; payment = "PENDING"; expect((await scan()).status).toBe(409)
  expect(writes).toHaveLength(0)
})

test("un evento con estado histórico cerrado permite subir un pasaje pagado", async () => {
  closed = true
  expect((await scan()).status).toBe(200)
  expect(writes).toHaveLength(1)
})
