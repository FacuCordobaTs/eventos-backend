import { beforeEach, expect, mock, test } from "bun:test"
import { getTableName, type SQL } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import { Hono } from "hono"
import { createAccessToken, verifyToken } from "../lib/jwt"

// Fixture mínimo: staff y tenants para atravesar middleware y ruta reales.
type Row = Record<string, any>
let tables: Record<string, Row[]>
const dialect = new MySqlDialect()
const person = (
  id: string,
  role: string,
  roles: string[] | null = null,
  tenantId: string | null = "tenant-a"
) => ({
  id,
  tenantId,
  role,
  roles,
  name: id,
  email: `${id}@example.test`,
  isActive: true,
})
function matches(table: string, row: Row, condition?: SQL) {
  if (!condition) return true
  const { sql, params } = dialect.sqlToQuery(condition)
  const equalities = [...sql.matchAll(/`([^`]+)`\.`([^`]+)` = \?/g)]
  return equalities.every((match, index) => {
    if (match[1] !== table) return true
    const column = match[2].replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    return row[column] === params[index]
  })
}
function fakeDb() {
  const db = {
    select: () => {
      let table = ""
      let condition: SQL | undefined
      const chain: any = {
        from(source: any) {
          table = getTableName(source)
          return chain
        },
        where(sql: SQL) {
          condition = sql
          return chain
        },
        limit() {
          return chain
        },
        then(resolve: any, reject: any) {
          return Promise.resolve(
            (tables[table] ?? []).filter((row) => matches(table, row, condition))
          ).then(resolve, reject)
        },
      }
      return chain
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: () => ({ values: async () => undefined }),
    transaction: async (callback: (tx: any) => any) => callback(db),
  }
  return db
}
mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: fakeDb }))
const { staffRoute } = await import("./staff")
const app = new Hono().route("/staff", staffRoute)

beforeEach(() => {
  tables = {
    staff: [
      person("admin", "ADMIN"),
      person("manager", "MANAGER"),
      person("bartender", "BARTENDER"),
      person("transport", "TRANSPORTER", null),
      person("promoter", "GENERAL_PROMOTER", ["PROMOTER", "GENERAL_PROMOTER"]),
      person("other", "ADMIN", null, "tenant-b"),
    ],
    tenants: [{ id: "tenant-a", name: "Productora A" }],
    promoters: [],
  }
})

async function request(
  path: string,
  token: string,
  method = "POST",
  body?: unknown
) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const impersonate = (id: string, actorToken: string) =>
  request(`/staff/team/${id}/impersonate`, actorToken)

test("el admin deja el dispositivo con la sesión del empleado y sin referencia a su cuenta", async () => {
  const adminToken = await createAccessToken("admin")
  const response = await impersonate("bartender", adminToken)
  expect(response.status).toBe(200)
  const data = await response.json()

  const payload = await verifyToken(data.token)
  // La sesión entregada es la del empleado y dura un año.
  expect(payload.sub).toBe("bartender")
  expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 300 * 24 * 3600)
  // No queda rastro del administrador en la credencial: no hay vuelta al panel de gestión.
  expect(payload).not.toHaveProperty("act")
  expect(payload).not.toHaveProperty("actExp")
  expect(payload).not.toHaveProperty("actRole")

  const me = await (await request("/staff/me", data.token, "GET")).json()
  expect(me.staff.id).toBe("bartender")
  expect(me.staff.role).toBe("BARTENDER")
  expect(me.staff).not.toHaveProperty("impersonatedBy")
})

test("la sesión entregada opera con los permisos del empleado, no con los del actor", async () => {
  const data = await (await impersonate("transport", await createAccessToken("admin"))).json()
  // El transportista no puede administrar el equipo igual que el admin que abrió la sesión.
  expect((await request("/staff/team", data.token, "GET")).status).toBe(403)
  expect((await request("/staff/me", data.token, "GET")).status).toBe(200)
})

test("encargado, tenant, cuenta propia e inactiva quedan fuera del alcance", async () => {
  const adminToken = await createAccessToken("admin")
  expect((await impersonate("admin", adminToken)).status).toBe(400)
  expect((await impersonate("other", adminToken)).status).toBe(403)
  expect((await impersonate("missing", adminToken)).status).toBe(404)
  tables.staff[2].isActive = false
  expect((await impersonate("bartender", adminToken)).status).toBe(400)
  tables.staff[2].isActive = true

  // Un encargado no puede abrir la sesión de un administrador, pero sí la de un empleado.
  const managerToken = await createAccessToken("manager")
  expect((await impersonate("admin", managerToken)).status).toBe(403)
  expect((await impersonate("bartender", managerToken)).status).toBe(200)
  // Otros roles tampoco pueden cambiar la sesión del dispositivo.
  expect((await impersonate("bartender", await createAccessToken("promoter"))).status).toBe(403)
  expect((await impersonate("bartender", await createAccessToken("bartender"))).status).toBe(403)
})

test("no existe un camino para volver a la cuenta del administrador", async () => {
  const adminToken = await createAccessToken("admin")
  const data = await (await impersonate("bartender", adminToken)).json()
  // Ni un endpoint de vuelta ni el token viejo sirven dentro del dispositivo: sólo queda loguearse.
  expect((await request("/staff/impersonation/stop", data.token)).status).toBe(404)
  expect((await request("/staff/impersonation/stop", adminToken)).status).toBe(404)
})
