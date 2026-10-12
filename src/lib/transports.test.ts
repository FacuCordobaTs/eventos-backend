import { describe, expect, test } from "bun:test"
import {
  transportSchema,
  purchasedTransports,
  transportRevenue
} from "./transports"
import { normalizeTransportLines } from "./client-checkout"
import { MySqlDialect } from "drizzle-orm/mysql-core"

const input = {
  name: "Desde Santo Tomé",
  address: "Av. 7 de Marzo 1800",
  price: "18000.00",
  latitude: -31.663,
  longitude: -60.765
}
describe("transportes", () => {
  test("valida precio decimal y punto geográfico", () => {
    expect(transportSchema.parse(input).price).toBe("18000.00")
    for (const price of [
      "0",
      "-1",
      "18.000",
      "18000.001",
      "1e4",
      "NaN",
      "100000000"
    ]) {
      expect(transportSchema.safeParse({ ...input, price }).success).toBe(false)
    }
    expect(transportSchema.safeParse({ ...input, latitude: 91 }).success).toBe(
      false
    )
    expect(
      transportSchema.safeParse({ ...input, longitude: -181 }).success
    ).toBe(false)
    expect(transportSchema.safeParse({ ...input, address: " " }).success).toBe(
      false
    )
  })
  test("agrupa ids duplicados y permite hasta un pasaje por entrada", () => {
    expect(
      normalizeTransportLines(
        [
          { transportId: "t1", quantity: 1 },
          { transportId: "t1", quantity: 2 }
        ],
        [{ quantity: 3 }]
      )
    ).toEqual([{ transportId: "t1", quantity: 3 }])
    expect(normalizeTransportLines([], [])).toEqual([])
    expect(() =>
      normalizeTransportLines([{ transportId: "t1", quantity: 1 }], [])
    ).toThrow("INVALID_TRANSPORT_QUANTITY")
    expect(() =>
      normalizeTransportLines(
        [{ transportId: "t1", quantity: 2 }],
        [{ quantity: 1 }]
      )
    ).toThrow("INVALID_TRANSPORT_QUANTITY")
    expect(() =>
      normalizeTransportLines(
        [{ transportId: "t1", quantity: 0.5 }],
        [{ quantity: 1 }]
      )
    ).toThrow("INVALID_TRANSPORT_QUANTITY")
  })
  test("el comprobante filtra por tenant, evento, comprador y venta completada", async () => {
    let query: { sql: string; params: unknown[] } | undefined
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: (sql: never) => {
              query = new MySqlDialect().sqlToQuery(sql)
              return Promise.resolve([])
            }
          })
        })
      })
    }
    await purchasedTransports(db as never, {
      tenantId: "tenant-a",
      eventId: "event-a",
      customerId: "buyer-a"
    })
    expect(query?.params).toEqual([
      "tenant-a",
      "event-a",
      "tenant-a",
      "event-a",
      "COMPLETED",
      "buyer-a"
    ])
    expect(query?.sql).toContain("`sale_transports`.`tenant_id`")
    expect(query?.sql).toContain("`sales`.`status`")
  })
  test("el cierre suma sólo pasajes pagados al precio de la compra", async () => {
    let query: { sql: string; params: unknown[] } | undefined
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: (sql: never) => {
              query = new MySqlDialect().sqlToQuery(sql)
              return Promise.resolve([{ total: "36000.00" }])
            }
          })
        })
      })
    }
    expect(
      await transportRevenue(db as never, {
        tenantId: "tenant-a",
        eventId: "event-a"
      })
    ).toBe("36000.00")
    expect(query?.params).toEqual([
      "tenant-a",
      "event-a",
      "tenant-a",
      "event-a",
      "COMPLETED"
    ])
  })
})
