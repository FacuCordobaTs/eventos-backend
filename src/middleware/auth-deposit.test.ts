import { beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { createAccessToken } from "../lib/jwt"

let role = "DEPOSIT"
let active = true
const staff = () => ({
  id: "deposit-worker",
  tenantId: "tenant-a",
  email: "deposit@example.com",
  name: "Depósito",
  role,
  isActive: active,
})
mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [staff()] }) }),
    }),
  }),
}))
// @ts-expect-error Query string isolates this fixture from route-level middleware mocks.
const { authMiddleware } = await import("./auth?deposit-permission-tests")
const app = new Hono().use("*", authMiddleware).all("*", (c) => c.json({ ok: true }))

beforeEach(() => {
  role = "DEPOSIT"
  active = true
})

async function request(path: string, method = "GET") {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${await createAccessToken("deposit-worker", "staff")}` },
  })
}

test("la sesión Depósito sólo entra a su evento, al stock y a su perfil", async () => {
  for (const path of [
    "/staff/me",
    "/events",
    "/events/event-a",
    "/events/event-a/deposit",
    "/events/event-a/stock-snapshot",
    "/inventory/items",
  ]) {
    expect((await request(path)).status).toBe(200)
  }
  expect((await request("/events/event-a/deposit/stock", "POST")).status).toBe(200)
  expect((await request("/events/event-a/deposit/transfers", "POST")).status).toBe(200)
  expect((await request("/inventory/items", "POST")).status).toBe(200)
})

test("la sesión Depósito no puede operar ventas, caja, menú, equipo ni analytics", async () => {
  for (const [path, method] of [
    ["/sales", "GET"],
    ["/analytics/dashboard", "GET"],
    ["/staff/team", "GET"],
    ["/events/event-a/bars", "GET"],
    ["/events/event-a/bars/bar-a/stock", "PUT"],
    ["/inventory/products", "GET"],
    ["/inventory/items/item-1", "DELETE"],
  ] as const) {
    expect((await request(path, method)).status).toBe(403)
  }
})

test("un ADMIN conserva acceso y una sesión inactiva no entra", async () => {
  role = "ADMIN"
  expect((await request("/sales")).status).toBe(200)
  active = false
  expect((await request("/sales")).status).toBe(401)
})
