import { beforeEach, expect, mock, test } from "bun:test"
import { getTableName, type SQL } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import { Hono } from "hono"
import { createAccessToken, createRoleAccessToken, verifyToken } from "../lib/jwt"
import { resolveStaffRole, staffRoles } from "../lib/staff-roles"

// Exercise real HTTP validation, JWT selection and middleware with a tenant-aware DB fixture.
type Row = Record<string, any>
let tables: Record<string, Row[]>
let failPromoterInsert = false
let failAssignmentInsert = false
let failPromoterUpdate = false
const dialect = new MySqlDialect()
const person = (id: string, role: string, roles: string[] | null = null, tenantId = "tenant-a") => ({
  id, tenantId, role, roles, name: id, email: `${id}@example.test`, isActive: true,
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
      let table = "", condition: SQL | undefined
      const chain: any = {
        from(source: any) { table = getTableName(source); return chain },
        where(sql: SQL) { condition = sql; return chain },
        limit() { return chain }, for() { return chain },
        then(resolve: any, reject: any) { return Promise.resolve((tables[table] ?? []).filter((row) => matches(table, row, condition))).then(resolve, reject) },
      }
      return chain
    },
    update: (source: any) => ({ set: (values: Row) => ({ where: async (condition: SQL) => {
      const table = getTableName(source)
      if (table === "promoters" && failPromoterUpdate) throw new Error("fixture promoter update failed")
      for (const row of tables[table] ?? []) if (matches(table, row, condition)) Object.assign(row, values)
    } }) }),
    insert: (source: any) => ({ values: async (values: Row | Row[]) => {
      const table = getTableName(source)
      if (table === "promoters" && failPromoterInsert) throw new Error("fixture insert failed")
      if (table === "event_staff" && failAssignmentInsert) throw new Error("fixture assignment failed")
      ;(tables[table] ??= []).push(...(Array.isArray(values) ? values : [values]).map((row) => ({ ...row })))
    } }),
    transaction: async (callback: (tx: any) => any) => {
      const snapshot = structuredClone(tables)
      try { return await callback(db) } catch (err) { tables = snapshot; throw err }
    },
  }
  return db
}
mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: fakeDb }))
const { staffRoute } = await import("./staff")
const { eventsRoute } = await import("./events")
const app = new Hono().route("/staff", staffRoute).route("/events", eventsRoute)
app.onError(() => new Response("fixture transaction error", { status: 500 }))

beforeEach(() => {
  failPromoterInsert = false
  failAssignmentInsert = false
  failPromoterUpdate = false
  tables = {
    staff: [person("admin", "ADMIN"), person("manager", "MANAGER"), person("employee", "TRANSPORTER", ["TRANSPORTER", "GENERAL_PROMOTER"]), person("other", "ADMIN", null, "tenant-b")],
    events: [{ id: "event-a", tenantId: "tenant-a" }, { id: "event-b", tenantId: "tenant-b" }],
    tenants: [{ id: "tenant-a", name: "Productora A" }],
    promoters: [], staff_invitations: [], event_staff: [],
  }
})
async function request(path: string, id = "admin", body?: unknown, method = "POST", token?: string) {
  return app.request(path, { method, headers: { Authorization: `Bearer ${token ?? await createAccessToken(id)}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

test("legacy roles and removed selections resolve only to currently granted roles", () => {
  expect(staffRoles(person("legacy", "MANAGER"))).toEqual(["MANAGER"])
  expect(resolveStaffRole(person("multi", "ADMIN", ["SECURITY", "TRANSPORTER"]), "ADMIN")).toBe("SECURITY")
})

test("ADMIN and MANAGER assign all roles, including ADMIN, and create one promoter identity", async () => {
  for (const actor of ["admin", "manager"]) {
    const response = await request("/events/event-a/staff/employee/roles", actor, { roles: ["ADMIN", "MANAGER", "TRANSPORTER", "PROMOTER", "GENERAL_PROMOTER", "BARTENDER", "SECURITY", "DEPOSIT", "ADMIN"] }, "PATCH")
    // The maximum payload is eight; a duplicate is accepted within that limit.
    expect(response.status).toBe(400)
    expect((await request("/events/event-a/staff/employee/roles", actor, { roles: ["ADMIN", "MANAGER", "TRANSPORTER", "PROMOTER", "GENERAL_PROMOTER", "BARTENDER", "SECURITY", "DEPOSIT"] }, "PATCH")).status).toBe(200)
    expect(tables.staff[2].roles).toHaveLength(8)
    expect(tables.promoters).toHaveLength(1)
  }
})

test("role changes enforce actor, tenant, active account, nonempty enum and self-access", async () => {
  const path = "/events/event-a/staff/employee/roles"
  for (const roles of [[], ["INVALID"]]) expect((await request(path, "admin", { roles }, "PATCH")).status).toBe(400)
  expect((await request("/events/event-b/staff/employee/roles", "admin", { roles: ["ADMIN"] }, "PATCH")).status).toBe(404)
  expect((await request("/events/event-a/staff/other/roles", "admin", { roles: ["ADMIN"] }, "PATCH")).status).toBe(404)
  expect((await request("/events/event-a/staff/admin/roles", "admin", { roles: ["TRANSPORTER"] }, "PATCH")).status).toBe(400)
  const gpToken = createRoleAccessToken(await verifyToken(await createAccessToken("employee")), "GENERAL_PROMOTER")
  expect((await request(path, "employee", { roles: ["ADMIN"] }, "PATCH", gpToken)).status).toBe(403)
  tables.staff[2].isActive = false
  expect((await request(path, "admin", { roles: ["ADMIN"] }, "PATCH")).status).toBe(404)
})

test("selected role is signed, does not renew expiration and is revalidated after revocation", async () => {
  const original = await createAccessToken("employee", "staff", "60d")
  const switched = await request("/staff/me/role", "employee", { role: "GENERAL_PROMOTER" }, "POST", original)
  expect(switched.status).toBe(200)
  const data = await switched.json()
  expect(data.staff.role).toBe("GENERAL_PROMOTER")
  expect(data.staff.roles).toEqual(["TRANSPORTER", "GENERAL_PROMOTER"])
  expect((await verifyToken(data.token)).exp).toBe((await verifyToken(original)).exp)
  expect((await request("/staff/me/role", "employee", { role: "ADMIN" }, "POST", original)).status).toBe(403)
  expect((await (await request("/staff/me", "employee", undefined, "GET", data.token)).json()).staff.role).toBe("GENERAL_PROMOTER")
  tables.staff[2].roles = ["TRANSPORTER"]
  expect((await (await request("/staff/me", "employee", undefined, "GET", data.token)).json()).staff.role).toBe("TRANSPORTER")
  expect((await request("/events/event-a/staff/employee/roles", "employee", { roles: ["ADMIN"] }, "PATCH", data.token)).status).toBe(403)
})

test("transportist can switch functions; an inactive or customer account cannot", async () => {
  expect((await request("/staff/me/role", "employee", { role: "GENERAL_PROMOTER" })).status).toBe(200)
  tables.staff[2].isActive = false
  expect((await request("/staff/me/role", "employee", { role: "GENERAL_PROMOTER" })).status).toBe(401)
  expect((await request("/staff/me/role", "admin", { role: "ADMIN" }, "POST", await createAccessToken("admin", "customer"))).status).toBe(401)
})

test("role changes and promoter identity roll back together; removal keeps historical identity", async () => {
  failPromoterInsert = true
  expect((await request("/events/event-a/staff/employee/roles", "admin", { roles: ["ADMIN", "PROMOTER"] }, "PATCH")).status).toBe(500)
  expect(tables.staff[2].roles).toEqual(["TRANSPORTER", "GENERAL_PROMOTER"])
  failPromoterInsert = false
  expect((await request("/events/event-a/staff/employee/roles", "admin", { roles: ["ADMIN", "PROMOTER"] }, "PATCH")).status).toBe(200)
  const promoterId = tables.promoters[0].id
  expect((await request("/events/event-a/staff/employee/roles", "admin", { roles: ["ADMIN"] }, "PATCH")).status).toBe(200)
  expect(tables.promoters[0]).toMatchObject({ id: promoterId, isActive: false })
})

test("manager can invite multiple roles; general promoter cannot grant extra functions", async () => {
  const response = await request("/staff/invitations", "manager", { name: "Empleado nuevo", role: "ADMIN", roles: ["ADMIN", "TRANSPORTER", "PROMOTER"], eventId: "event-a" })
  expect(response.status).toBe(201)
  const invite = (await response.json()).invitation
  expect(tables.staff.find((row) => row.id === invite.acceptedStaffId)?.roles).toEqual(["ADMIN", "TRANSPORTER", "PROMOTER"])
  expect(tables.event_staff[0].staffId).toBe(invite.acceptedStaffId)
  const accepted = await app.request(`/staff/invitations/${invite.token}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  expect(accepted.status).toBe(200)
  expect((await accepted.json()).staff.roles).toEqual(["ADMIN", "TRANSPORTER", "PROMOTER"])
  const reused = await app.request(`/staff/invitations/${invite.token}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  expect(reused.status).toBe(200)
  expect((await reused.json()).staff.id).toBe(invite.acceptedStaffId)
  const gpToken = createRoleAccessToken(await verifyToken(await createAccessToken("employee")), "GENERAL_PROMOTER")
  expect((await request("/staff/invitations", "employee", { name: "Intento", role: "PROMOTER", roles: ["PROMOTER", "ADMIN"] }, "POST", gpToken)).status).toBe(403)
})

test("general promoter cannot deactivate or reactivate a multi-function account", async () => {
  tables.staff.push(person("subordinate", "PROMOTER", ["PROMOTER", "SECURITY"]))
  const gpToken = createRoleAccessToken(await verifyToken(await createAccessToken("employee")), "GENERAL_PROMOTER")
  expect((await request("/staff/team/subordinate", "employee", undefined, "DELETE", gpToken)).status).toBe(403)
  tables.staff.at(-1)!.isActive = false
  expect((await request("/staff/team/subordinate/reactivate", "employee", {}, "POST", gpToken)).status).toBe(403)
})

test("editing a name through the team endpoint preserves all roles", async () => {
  expect((await request("/staff/team/employee", "admin", { name: "Nombre nuevo" }, "PATCH")).status).toBe(200)
  expect(tables.staff[2].roles).toEqual(["TRANSPORTER", "GENERAL_PROMOTER"])
})

test("new events assign the whole active tenant team, for ADMIN and MANAGER in every operation mode", async () => {
  tables.staff.push(person("inactive", "SECURITY"))
  tables.staff.at(-1)!.isActive = false
  for (const actor of ["admin", "manager"]) {
    for (const operationMode of ["TICKETS_ONLY", "TICKETS_AND_CONSUMPTIONS", "FULL_OPERATION"]) {
      const response = await request("/events", actor, { name: "Nuevo evento", date: "2026-11-12T22:00:00Z", operationMode })
      expect(response.status).toBe(201)
      const { event } = await response.json() as { event: { id: string } }
      const assignments = tables.event_staff.filter((row) => row.eventId === event.id)
      expect(assignments.map((row) => row.staffId).sort()).toEqual(["admin", "employee", "manager"])
      expect(assignments.every((row) => row.tenantId === "tenant-a" && row.barId === null)).toBe(true)
      expect(new Set(assignments.map((row) => row.id)).size).toBe(3)
    }
  }
})

test("event creation and default assignments roll back together without changing existing events", async () => {
  tables.event_staff.push({ id: "previous", eventId: "event-a", tenantId: "tenant-a", staffId: "admin", barId: "bar-a" })
  const snapshot = structuredClone(tables)
  failAssignmentInsert = true
  expect((await request("/events", "admin", { name: "Nuevo evento", date: "2026-11-12T22:00:00Z" })).status).toBe(500)
  expect(tables).toEqual(snapshot)
})

test("operational roles cannot create events and grant default team access", async () => {
  for (const role of ["GENERAL_PROMOTER", "PROMOTER", "BARTENDER", "SECURITY", "TRANSPORTER"]) {
    tables.staff.push(person(`actor-${role}`, role))
    expect((await request("/events", `actor-${role}`, { name: "Sin permiso", date: "2026-11-12T22:00:00Z" })).status).toBe(403)
  }
  expect(tables.events).toHaveLength(2)
  expect(tables.event_staff).toHaveLength(0)
})

test("duplicated events include active tenant staff in all modes and preserve remapped bars", async () => {
  tables.events[0] = { ...tables.events[0], name: "Origen", date: new Date("2026-11-12T22:00:00Z"), operationMode: "FULL_OPERATION" }
  tables.staff.push({ ...person("inactive", "SECURITY"), isActive: false })
  tables.bars = [{ id: "old-bar", eventId: "event-a", tenantId: "tenant-a", name: "Barra", isActive: true, isDefault: true }]
  tables.event_staff = [{ id: "old-assignment", eventId: "event-a", tenantId: "tenant-a", staffId: "employee", barId: "old-bar" }]
  for (const operationMode of ["TICKETS_ONLY", "FULL_OPERATION"]) {
    const response = await request("/events/event-a/duplicate", "admin", { name: "Nuevo evento", date: "2026-11-13T22:00:00Z", operationMode })
    expect(response.status).toBe(201)
    const { event } = await response.json() as { event: { id: string } }
    const assignments = tables.event_staff.filter((row) => row.eventId === event.id)
    expect(assignments.map((row) => row.staffId).sort()).toEqual(["admin", "employee", "manager"])
    const employeeBar = assignments.find((row) => row.staffId === "employee")!.barId
    if (operationMode === "TICKETS_ONLY") expect(employeeBar).toBeNull()
    else {
      expect(employeeBar).not.toBe("old-bar")
      expect(tables.bars.find((row) => row.id === employeeBar)?.eventId).toBe(event.id)
    }
  }
  expect((await request("/events/event-a/duplicate", "employee", { name: "Sin permiso" })).status).toBe(403)
})

test("ADMIN removes employees from active team and revokes their sessions while preserving history", async () => {
  tables.promoters.push({ id: "profile", staffId: "employee", tenantId: "tenant-a", isActive: true })
  tables.event_staff.push({ id: "assignment", staffId: "employee", eventId: "event-a", tenantId: "tenant-a" })
  const employeeToken = await createAccessToken("employee")
  const assignments = structuredClone(tables.event_staff)
  expect((await request("/staff/team/employee", "admin", undefined, "DELETE")).status).toBe(200)
  expect(tables.staff.find((row) => row.id === "employee")?.isActive).toBe(false)
  expect(tables.promoters[0].isActive).toBe(false)
  expect(tables.event_staff).toEqual(assignments)
  const team = await request("/staff/team", "admin", undefined, "GET")
  expect((await team.json() as { staff: Row[] }).staff.some((row) => row.id === "employee")).toBe(false)
  expect((await request("/staff/me", "employee", undefined, "GET", employeeToken)).status).toBe(401)
})

test("employee removal rejects self, other tenants, managers and unrelated operational roles", async () => {
  expect((await request("/staff/team/admin", "admin", undefined, "DELETE")).status).toBe(400)
  expect((await request("/staff/team/other", "admin", undefined, "DELETE")).status).toBe(403)
  expect((await request("/staff/team/employee", "manager", undefined, "DELETE")).status).toBe(403)
  tables.staff.push(person("security", "SECURITY"))
  expect((await request("/staff/team/employee", "security", undefined, "DELETE")).status).toBe(403)
  expect(tables.staff.every((row) => row.isActive)).toBe(true)
})

test("employee and promoter removal roll back together on failure", async () => {
  tables.promoters.push({ id: "profile", staffId: "employee", tenantId: "tenant-a", isActive: true })
  const snapshot = structuredClone(tables)
  failPromoterUpdate = true
  expect((await request("/staff/team/employee", "admin", undefined, "DELETE")).status).toBe(500)
  expect(tables).toEqual(snapshot)
})
