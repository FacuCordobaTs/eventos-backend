import { beforeEach, describe, expect, mock, test } from "bun:test"
import { getTableName } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"

const token = "a".repeat(64)
let active = true
let failed = false
let queries: { table: string; params: unknown[] }[] = []
const db = {
  select: () => {
    let table = ""
    let params: unknown[] = []
    const chain = {
      from: (source: never) => {
        table = getTableName(source)
        return chain
      },
      innerJoin: () => chain,
      where: (where: never) => {
        params = new MySqlDialect().sqlToQuery(where).params
        queries.push({ table, params })
        return chain
      },
      orderBy: () => chain,
      limit: () => chain,
      then: (
        resolve: (rows: unknown[]) => unknown,
        reject: (reason: unknown) => unknown
      ) =>
        (failed
          ? Promise.reject(new Error("query failed"))
          : Promise.resolve(
              table === "event_transports"
                ? active && params[0] === token
                  ? [
                      {
                        id: "transport-a",
                        eventId: "event-a",
                        tenantId: "tenant-a",
                        name: "Desde Santo Tomé",
                        address: "7 de Marzo",
                        latitude: "-31.663",
                        longitude: "-60.765",
                        eventName: "Fiesta",
                        eventDate: "2026-12-01"
                      }
                    ]
                  : []
                : [
                    {
                      id: "booking-a",
                      name: "Salida",
                      quantity: 3,
                      price: "18000.00",
                      customerName: "Ana",
                      customerDni: "12345678",
                      customerPhone: "1155550000"
                    }
                  ]
            )
        ).then(resolve, reject)
    }
    return chain
  }
}
mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: () => db }))
const { transportManifestsRoute } =
  // @ts-expect-error Bun supports query strings for isolated route instances.
  await import("./transport-manifests?driver-tests")
beforeEach(() => {
  active = true
  failed = false
  queries = []
})

describe("lista del chofer", () => {
  test("el token permite sólo pasajeros pagados de su tenant, evento y transporte", async () => {
    const response = await transportManifestsRoute.request(`/${token}`)
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("private, no-store")
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow")
    const data = await response.json()
    expect(data.passengers).toEqual([
      {
        id: "booking-a",
        name: "Ana",
        dni: "12345678",
        phone: "1155550000",
        quantity: 3
      }
    ])
    expect(data.passengers[0].price).toBeUndefined()
    expect(data.tenantId).toBeUndefined()
    expect(queries[1].params).toEqual([
      "tenant-a",
      "event-a",
      "tenant-a",
      "event-a",
      "COMPLETED",
      "transport-a"
    ])
  })
  test("no acepta ids públicos de transporte ni tokens inválidos", async () => {
    expect((await transportManifestsRoute.request("/transport-a")).status).toBe(
      404
    )
    expect(queries).toHaveLength(0)
    expect(
      (await transportManifestsRoute.request(`/${"b".repeat(64)}`)).status
    ).toBe(404)
  })
  test("un link desactivado deja de entregar pasajeros", async () => {
    active = false
    expect((await transportManifestsRoute.request(`/${token}`)).status).toBe(
      404
    )
    expect(queries).toHaveLength(1)
  })
  test("una falla de base no devuelve datos privados ni el token en el error", async () => {
    failed = true
    const response = await transportManifestsRoute.request(`/${token}`)
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain(token)
  })
})
