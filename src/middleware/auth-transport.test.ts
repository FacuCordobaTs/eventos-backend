import { beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { createAccessToken } from "../lib/jwt"

let role = "TRANSPORTER"
const staff = () => ({ id: "driver", tenantId: "tenant-a", email: "driver@example.com", name: "Chofer", role, isActive: true })
mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [staff()] }) }) }) }) }))
// @ts-expect-error Query string isolates this fixture from route-level middleware mocks.
const { authMiddleware } = await import("./auth?transport-permission-tests")
const app = new Hono().use("*", authMiddleware).all("*", (c) => c.json({ ok: true }))
beforeEach(() => { role = "TRANSPORTER" })
const request = async (path: string) => app.request(path, { headers: { Authorization: `Bearer ${await createAccessToken("driver", "staff")}` } })
test("la sesión transportista no puede operar puerta, POS, administración ni exportar clientes", async () => {
  for (const path of ["/tickets/validate", "/events", "/staff/team", "/event-transports/event", "/sales", "/inventory", "/analytics"]) expect((await request(path)).status).toBe(403)
})
test("puede leer su perfil y llegar a las rutas de transporte autorizadas por evento", async () => {
  expect((await request("/staff/me")).status).toBe(200)
  expect((await request("/transport-tickets/events")).status).toBe(200)
  expect((await request("/transport-tickets/validate")).status).toBe(200)
})
test("conserva las autorizaciones existentes y rechaza tokens de cliente", async () => {
  role = "ADMIN"; expect((await request("/events")).status).toBe(200)
  const response = await app.request("/staff/me", { headers: { Authorization: `Bearer ${await createAccessToken("customer", "customer")}` } })
  expect(response.status).toBe(401)
})
