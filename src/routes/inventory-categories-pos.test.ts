import { beforeEach, describe, expect, mock, test } from "bun:test"
import { getTableName, type SQL } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import type { Context, Next } from "hono"

// Endpoints reales, sin credenciales ni DB. Se evalúan los filtros SQL sencillos del flujo
// (tenant, evento, producto, activo) y se registran las escrituras de la transacción.
type Row = Record<string, any>
const dialect = new MySqlDialect()
let tables: Record<string, Row[]>
let staff: Row
let writes: { table: string; values: Row }[]
let queries: { table: string; sql: string; params: unknown[] }[]
const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

function matching(table: string, row: Row, condition?: SQL): boolean {
  if (!condition) return true
  const query = dialect.sqlToQuery(condition)
  // Los joins se proyectan abajo; acá sólo se filtran columnas de la tabla fuente.
  const pattern = /`([^`]+)`\.`([^`]+)` (= \?|in \([^)]*\))/g
  for (const match of query.sql.matchAll(pattern)) {
    if (match[1] !== table) continue
    const firstParam = (query.sql.slice(0, match.index).match(/\?/g) ?? []).length
    const count = (match[3].match(/\?/g) ?? []).length
    const allowed = query.params.slice(firstParam, firstParam + count)
    const value = row[camel(match[2])]
    if (!allowed.some((param) => param === value || (typeof value === "boolean" && Number(value) === param))) return false
  }
  return true
}

function fakeDb() {
  const db = {
    select: (fields?: Row) => {
      let table = ""
      let condition: SQL | undefined
      const chain: Row = {}
      chain.from = (source: never) => { table = getTableName(source); return chain }
      chain.where = (sql: SQL) => { condition = sql; return chain }
      for (const method of ["innerJoin", "leftJoin", "orderBy", "limit"]) chain[method] = () => chain
      chain.then = (resolve: (rows: Row[]) => unknown, reject: (e: unknown) => unknown) => {
        const query = condition ? dialect.sqlToQuery(condition) : { sql: "", params: [] }
        queries.push({ table, ...query })
        const rows = (tables[table] ?? []).filter((row) => matching(table, row, condition))
        const projected = rows.map((row) => {
          if (!fields) return { ...row }
          const result: Row = {}
          for (const [alias, field] of Object.entries(fields)) {
            if (field?.name && field?.table) {
              const fieldTable = getTableName(field.table)
              const source = fieldTable === table ? row : (tables[fieldTable] ?? []).find((joined) =>
                fieldTable === "event_products" ? joined.productId === row.id :
                fieldTable === "product_categories" ? joined.id === row.categoryId : false
              )
              result[alias] = source?.[camel(field.name)] ?? null
            } else if (alias === "m") result[alias] = Math.max(0, ...rows.map((r) => Number(r.sortOrder)))
            else if (alias === "price") {
              const sql = dialect.sqlToQuery(field).sql
              expect(sql).toContain("coalesce")
              result[alias] = tables.event_products.find((p) => p.productId === row.id)?.priceOverride ?? row.price
            }
          }
          return result
        })
        return Promise.resolve(projected).then(resolve, reject)
      }
      return chain
    },
    insert: (source: never) => ({ values: async (values: Row | Row[]) => {
      const table = getTableName(source)
      for (const row of Array.isArray(values) ? values : [values]) {
        writes.push({ table, values: row }); (tables[table] ??= []).push({ ...row })
      }
    } }),
    update: (source: never) => ({ set: (values: Row) => ({ where: async (condition: SQL) => {
      const table = getTableName(source)
      writes.push({ table, values })
      for (const row of tables[table] ?? []) if (matching(table, row, condition)) Object.assign(row, values)
    } }) }),
    delete: (source: never) => ({ where: async (condition: SQL) => {
      const table = getTableName(source)
      tables[table] = (tables[table] ?? []).filter((r) => !matching(table, r, condition))
    } }),
    transaction: async (run: (tx: any) => unknown): Promise<any> => run(db),
  }
  return db
}

mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: fakeDb }))
mock.module("../middleware/auth", () => ({ authMiddleware: async (c: Context, next: Next) => { Object.assign(c, { staff }); await next() } }))
// @ts-expect-error Bun aísla esta instancia del middleware mockeado por otros tests.
const { inventoryRoute } = await import("./inventory?categories-pos")
// @ts-expect-error Instancia propia para probar el catálogo efectivo de la caja.
const { barsRoute } = await import("./bars?categories-pos")
const request = (method: string, path: string, body?: unknown) => inventoryRoute.request(path, {
  method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const sale = () => request("POST", "/sales", { eventId: "event-1", barId: "bar-1", paymentMethod: "CASH", items: [{ productId: "food", quantity: 2 }, { productId: "drink", quantity: 1 }] })

beforeEach(() => {
  staff = { id: "staff-1", tenantId: "tenant-1", role: "ADMIN" }
  writes = []; queries = []
  tables = {
    product_categories: [{ id: "cat-food", tenantId: "tenant-1", name: "Comida", sortOrder: 1, isActive: true }, { id: "cat-other", tenantId: "tenant-2", name: "Privada", sortOrder: 2, isActive: true }],
    products: [{ id: "food", tenantId: "tenant-1", name: "Hamburguesa", price: "10.10", saleType: "GLASS", categoryId: "cat-food", isActive: true }, { id: "drink", tenantId: "tenant-1", name: "Agua", price: "3.20", saleType: "GLASS", categoryId: null, isActive: true }],
    events: [{ id: "event-1", tenantId: "tenant-1", operationMode: "TICKETS_AND_CONSUMPTIONS" }],
    bars: [{ id: "bar-1", eventId: "event-1", tenantId: "tenant-1" }],
    event_products: [{ id: "ep-food", tenantId: "tenant-1", eventId: "event-1", productId: "food", isActive: true, priceOverride: "12.35", directStock: "10.00" }, { id: "ep-drink", tenantId: "tenant-1", eventId: "event-1", productId: "drink", isActive: true, priceOverride: null, directStock: null }],
  }
})

describe("Categorías operables desde el catálogo", () => {
  test("lista sólo categorías activas del tenant", async () => {
    tables.product_categories.push({ id: "inactive", tenantId: "tenant-1", name: "Vieja", sortOrder: 3, isActive: false })
    const res = await request("GET", "/categories")
    expect(await res.json()).toEqual({ categories: [{ id: "cat-food", name: "Comida", sortOrder: 1 }] })
  })
  test("crea y renombra con nombre limpio y orden editable", async () => {
    const res = await request("POST", "/categories", { name: "  Bebidas  " })
    expect(res.status).toBe(201)
    const { category } = await res.json() as any
    expect(category.name).toBe("Bebidas")
    expect(writes[0].values.tenantId).toBe("tenant-1")
    expect((await request("PUT", `/categories/${category.id}`, { name: "Bebidas sin alcohol", sortOrder: 0 })).status).toBe(200)
    expect(tables.product_categories.find((c) => c.id === category.id)?.sortOrder).toBe(0)
  })
  test("rechaza nombres vacíos después de quitar espacios", async () => {
    expect((await request("POST", "/categories", { name: "   " })).status).toBe(400)
    expect(writes).toHaveLength(0)
  })
  for (const role of ["BARTENDER", "SECURITY", "PROMOTER", "GENERAL_PROMOTER"]) {
    test(`${role} no puede alterar categorías`, async () => {
      staff.role = role
      for (const method of ["POST", "PUT", "DELETE"]) {
        expect((await request(method, method === "POST" ? "/categories" : "/categories/cat-food", { name: "Otra" })).status).toBe(403)
      }
      expect(writes).toHaveLength(0)
    })
  }
  test("no modifica ni elimina categorías de otro tenant", async () => {
    expect((await request("PUT", "/categories/cat-other", { name: "Otra" })).status).toBe(404)
    expect((await request("DELETE", "/categories/cat-other")).status).toBe(404)
    expect(writes).toHaveLength(0)
  })
  test("eliminar desvincula productos sin desactivarlos ni afectar otro tenant", async () => {
    tables.products.push({ id: "foreign", tenantId: "tenant-2", categoryId: "cat-food" })
    expect((await request("DELETE", "/categories/cat-food")).status).toBe(200)
    expect(tables.products[0].categoryId).toBeNull()
    expect(tables.products[0].isActive).toBe(true)
    expect(tables.products[2].categoryId).toBe("cat-food")
  })
  test("editar producto conserva una categoría omitida y permite quitarla explícitamente", async () => {
    const body = { name: "Hamburguesa doble", price: "15.00", recipes: [] }
    expect((await request("PUT", "/products/food", body)).status).toBe(200)
    expect(tables.products[0].categoryId).toBe("cat-food")
    expect((await request("PUT", "/products/food", { ...body, categoryId: null })).status).toBe(200)
    expect(tables.products[0].categoryId).toBeNull()
  })
  test("no asigna categorías ajenas o inactivas", async () => {
    const body = { name: "Hamburguesa", price: "10.10", recipes: [] }
    expect((await request("PUT", "/products/food", { ...body, categoryId: "cat-other" })).status).toBe(400)
    tables.product_categories[0].isActive = false
    expect((await request("PUT", "/products/food", { ...body, categoryId: "cat-food" })).status).toBe(400)
    expect(writes).toHaveLength(0)
  })
  test("MANAGER puede crear productos clasificados; roles operativos no pueden editarlos", async () => {
    const body = { name: "Pizza", price: "5.00", categoryId: "cat-food", recipes: [] }
    staff.role = "MANAGER"
    const res = await request("POST", "/products", body)
    expect(res.status).toBe(201)
    expect((await res.json() as any).product.categoryId).toBe("cat-food")
    writes = []
    staff.role = "BARTENDER"
    expect((await request("POST", "/products", body)).status).toBe(403)
    expect((await request("PUT", "/products/food", body)).status).toBe(403)
    expect(writes).toHaveLength(0)
  })
})

describe("POS de comida y bebidas", () => {
  test("la caja permite al bartender y rechaza roles ajenos al POS", async () => {
    for (const role of ["SECURITY", "PROMOTER", "GENERAL_PROMOTER"]) {
      staff.role = role
      expect((await sale()).status).toBe(403)
    }
    expect(writes).toHaveLength(0)
    staff.role = "BARTENDER"
    expect((await sale()).status).toBe(201)
  })
  test("catálogo devuelve categorías y el precio efectivo del evento", async () => {
    const res = await barsRoute.request("/bar-1/products?eventId=event-1")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.products[0]).toMatchObject({ id: "food", price: "12.35", categoryId: "cat-food", categoryName: "Comida" })
    expect(body.products[1].price).toBe("3.20")
  })
  for (const mode of ["TICKETS_AND_CONSUMPTIONS", "FULL_OPERATION"]) {
    test(`pedido mixto cobra precio de evento con Decimal y emite un QR por unidad en ${mode}`, async () => {
      tables.events[0].operationMode = mode
      expect((await sale()).status).toBe(201)
      expect(writes.find((w) => w.table === "sales")?.values.totalAmount).toBe("27.90")
      expect(writes.filter((w) => w.table === "sale_items").map((w) => w.values.priceAtTime)).toEqual(["12.35", "3.20"])
      const consumptions = writes.filter((w) => w.table === "digital_consumptions")
      expect(consumptions).toHaveLength(3)
      expect(new Set(consumptions.map((c) => c.values.qrHash)).size).toBe(3)
      expect(consumptions.every((c) => c.values.tenantId === "tenant-1" && c.values.eventId === "event-1" && c.values.status === "PENDING")).toBe(true)
      expect(tables.event_products[0].directStock).toBe(mode === "FULL_OPERATION" ? "8.00" : "10.00")
    })
  }
  for (const mismatch of ["inactive", "tenant", "event"]) {
    test(`no vende un producto fuera del menú por ${mismatch}`, async () => {
      const menu = tables.event_products[0]
      if (mismatch === "inactive") menu.isActive = false
      if (mismatch === "tenant") menu.tenantId = "tenant-2"
      if (mismatch === "event") menu.eventId = "event-2"
      expect((await sale()).status).toBe(400)
      expect(writes).toHaveLength(0)
    })
  }
  test("respeta un override de cero", async () => {
    tables.event_products[0].priceOverride = "0.00"
    expect((await sale()).status).toBe(201)
    expect(writes.find((w) => w.table === "sales")?.values.totalAmount).toBe("3.20")
  })
})
