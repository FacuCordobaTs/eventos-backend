import { beforeEach, describe, expect, mock, test } from "bun:test"
import { getTableName } from "drizzle-orm"
import type { Context, Next } from "hono"

// Sin DB: los endpoints reales de Resumen y Equipo del evento contra una base simulada que responde
// según la tabla y la forma del `select`. El SQL (rol del dueño, tenant) no se ejercita acá; importa
// el contrato HTTP: la productora ve a qué promotor general pertenece cada promotor, el promotor
// general recibe su cartera sin ese dato, y el cierre —que se congela y el reporte público sirve tal
// cual— nunca lo lleva.
const EVENT = { id: "event-1", tenantId: "tenant-1", closingReport: null }

// Ana es promotora general con dos promotores (Beto, Cami); Dani lo dio de alta la productora.
const PROMOTER_ROWS = [
  { id: "p-ana", name: "Ana López", phone: null, isActive: true, ownerStaffId: null },
  { id: "p-beto", name: "Beto Ruiz", phone: null, isActive: true, ownerStaffId: "staff-ana" },
  { id: "p-cami", name: "Cami Paz", phone: null, isActive: false, ownerStaffId: "staff-ana" },
  { id: "p-dani", name: "Dani Sosa", phone: null, isActive: true, ownerStaffId: null },
]
const OWNER_ROWS = [
  { promoterId: "p-beto", generalPromoterName: "Ana López" },
  { promoterId: "p-cami", generalPromoterName: "Ana López" },
]

const staffRow = (id: string, name: string, role: string, promoterId: string | null) => ({
  id,
  name,
  email: `${id}@example.com`,
  role,
  isActive: true,
  assignmentId: promoterId ? `assignment-${id}` : null,
  barId: null,
  promoterId,
})
const STAFF_ROWS = [
  staffRow("staff-ana", "Ana López", "GENERAL_PROMOTER", "p-ana"),
  staffRow("staff-beto", "Beto Ruiz", "PROMOTER", "p-beto"),
  staffRow("staff-dani", "Dani Sosa", "PROMOTER", "p-dani"),
  staffRow("staff-lu", "Lu Vega", "BARTENDER", null),
]
// Lo que ve un promotor general en Equipo: sólo su cartera.
const GENERAL_PROMOTER_OWN_ROWS = [STAFF_ROWS[1]]

let currentStaff: Record<string, unknown>
let queries: string[] = []

function answer(table: string, keys: string[]): unknown[] {
  if (table === "events") return [EVENT]
  if (table === "event_staff") return [{ id: "assignment-gp" }]
  if (keys.includes("generalPromoterName")) return OWNER_ROWS
  if (table === "promoters" && keys.includes("assignmentId")) return GENERAL_PROMOTER_OWN_ROWS
  if (table === "promoters" && keys.includes("ownerStaffId")) return PROMOTER_ROWS
  if (table === "staff" && keys.includes("assignmentId")) return STAFF_ROWS
  // Entradas y ventas de barra: nadie vendió, alcanza para ver cómo se arma cada fila.
  return []
}

function fakeDb() {
  return {
    select: (fields?: Record<string, unknown>) => {
      const keys = Object.keys(fields ?? {})
      let table = ""
      const chain: Record<string, unknown> = {}
      chain.from = (source: unknown) => {
        table = getTableName(source as never)
        return chain
      }
      for (const method of ["innerJoin", "leftJoin", "where", "groupBy", "orderBy", "limit"]) {
        chain[method] = () => chain
      }
      chain.then = (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => {
        queries.push(`${table}:${keys.join(",")}`)
        return Promise.resolve(answer(table, keys)).then(resolve, reject)
      }
      return chain
    },
  }
}

mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: () => fakeDb() }))
mock.module("../middleware/auth", () => ({
  authMiddleware: async (c: Context, next: Next) => {
    Object.assign(c, { staff: currentStaff })
    await next()
  },
}))

const { eventsRoute } = await import("./events")

const asAdmin = () => {
  currentStaff = { id: "staff-admin", tenantId: "tenant-1", role: "ADMIN" }
}
const asGeneralPromoter = () => {
  currentStaff = { id: "staff-ana", tenantId: "tenant-1", role: "GENERAL_PROMOTER" }
}

/** ¿Se consultó al dueño de los promotores? Sólo la lista de la productora lo necesita. */
const askedForOwners = () => queries.some((q) => q.includes("generalPromoterName"))

beforeEach(() => {
  queries = []
  asAdmin()
})

describe("Resumen: ventas por promotor", () => {
  test("la productora ve a qué promotor general pertenece cada promotor", async () => {
    const res = await eventsRoute.request("/event-1/promoter-sales")
    expect(res.status).toBe(200)
    const { promoters } = (await res.json()) as {
      promoters: { id: string; generalPromoterName: string | null }[]
    }
    const owners = Object.fromEntries(promoters.map((p) => [p.id, p.generalPromoterName]))
    expect(owners).toEqual({
      "p-beto": "Ana López",
      "p-cami": "Ana López",
      // La promotora general vende con fila propia y sin dueño; y Dani es de la productora.
      "p-ana": null,
      "p-dani": null,
    })
  })

  test("el promotor general recibe su cartera como antes, sin el dato ni la consulta extra", async () => {
    asGeneralPromoter()
    const res = await eventsRoute.request("/event-1/promoter-sales")
    expect(res.status).toBe(200)
    const { promoters } = (await res.json()) as { promoters: Record<string, unknown>[] }
    expect(promoters.map((p) => p.id).sort()).toEqual(["p-beto", "p-cami"])
    for (const row of promoters) expect(row).not.toHaveProperty("generalPromoterName")
    expect(askedForOwners()).toBe(false)
  })
})

describe("Cierre", () => {
  test("los promotores que se congelan no llevan el promotor general: el reporte público los sirve tal cual", async () => {
    const res = await eventsRoute.request("/event-1/closing")
    expect(res.status).toBe(200)
    const { byPromoter } = (await res.json()) as { byPromoter: Record<string, unknown>[] }
    expect(byPromoter.map((p) => p.id).sort()).toEqual(["p-ana", "p-beto", "p-cami", "p-dani"])
    for (const row of byPromoter) expect(row).not.toHaveProperty("generalPromoterName")
    expect(askedForOwners()).toBe(false)
  })
})

describe("Equipo del evento", () => {
  test("la productora ve el promotor general de cada promotor y nada para el resto", async () => {
    const res = await eventsRoute.request("/event-1/staff")
    expect(res.status).toBe(200)
    const { staff } = (await res.json()) as {
      staff: { id: string; generalPromoterName: string | null }[]
    }
    const owners = Object.fromEntries(staff.map((s) => [s.id, s.generalPromoterName]))
    expect(owners).toEqual({
      "staff-beto": "Ana López",
      // Promotora general, promotor de la productora y bartender: no pertenecen a ningún promotor general.
      "staff-ana": null,
      "staff-dani": null,
      "staff-lu": null,
    })
  })

  test("el promotor general ve su cartera sin el dato ni la consulta extra", async () => {
    asGeneralPromoter()
    const res = await eventsRoute.request("/event-1/staff")
    expect(res.status).toBe(200)
    const { staff } = (await res.json()) as { staff: Record<string, unknown>[] }
    expect(staff.map((s) => s.id)).toEqual(["staff-beto"])
    for (const row of staff) expect(row).not.toHaveProperty("generalPromoterName")
    expect(askedForOwners()).toBe(false)
  })
})
