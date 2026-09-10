import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test"
import type { Context, Next } from "hono"

// No DB ni servicios externos: ejercita los endpoints reales y detecta cualquier escritura
// antes de rechazar un ingreso fuera de horario (incluidos reingresos).
let rows: Record<string, unknown>[] = []
let writes = 0
const query = {
  from: () => query, innerJoin: () => query, where: () => query,
  limit: async () => rows, orderBy: async () => rows,
}
const tx = {
  select: () => query,
  update: () => { writes++; throw new Error("No debe modificar tickets") },
  insert: () => { writes++; throw new Error("No debe registrar un pase") },
}
mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: () => ({
  transaction: async (callback: (db: typeof tx) => unknown) => callback(tx),
}) }))
mock.module("../middleware/auth", () => ({ authMiddleware: async (c: Context, next: Next) => {
  Object.assign(c, { staff: { id: "staff", tenantId: "tenant", role: "SECURITY" } })
  await next()
} }))

const { ticketsRoute } = await import("./tickets")
const base = {
  id: "ticket", eventId: "event", typeEventId: "event", saleId: null,
  buyerDni: null, qrHash: "qr", ticketTypeId: "general", ticketTypeName: "General",
  validFrom: null, validUntil: new Date("2026-09-10T22:00:00-03:00"),
}

beforeEach(() => {
  writes = 0
  setSystemTime(new Date("2026-09-10T22:00:00-03:00"))
})
afterEach(() => setSystemTime())

describe("Puerta rechaza fuera de horario sin consumir la entrada", () => {
  for (const endpoint of ["/validate", "/validate-by-dni"]) {
    for (const status of ["PENDING", "USED"]) {
      test(`${endpoint} bloquea ${status} al cierre sin registrar ingresos`, async () => {
        rows = [{ ...base, status }]
        const res = await ticketsRoute.request(endpoint, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId: "event", qrHash: "qr", dni: "12345678" }),
        })
        expect(res.status).toBe(403)
        const body = await res.json()
        expect(body.code).toBe("TICKET_OUTSIDE_ADMISSION_WINDOW")
        expect(body.error).toContain("22:00")
        expect(writes).toBe(0)
        expect(rows[0]!.status).toBe(status)
      })
    }
  }
  test("el QR de otro evento sigue rechazándose antes del horario", async () => {
    rows = [{ ...base, eventId: "another-event", status: "PENDING" }]
    const res = await ticketsRoute.request("/validate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "event", qrHash: "qr" }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Ticket para otro evento")
    expect(writes).toBe(0)
  })
})
