import { expect, test } from "bun:test"
import { getTableName } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import { cancelTransportShare, claimTransportShare, createTransportShare, getTransportSharePreview } from "./transport-shares"

function fixture(results: unknown[][], changed = 1) {
  const writes: { table: string; values: Record<string, unknown> }[] = []
  const reads: { table: string; locked: boolean; sql: string; params: unknown[] }[] = []
  let rolledBack = false
  const select = (empty = false) => {
    const read = { table: "", locked: false, sql: "", params: [] as unknown[] }
    const query = {
      from: (table: never) => { read.table = getTableName(table); return query }, innerJoin: () => query,
      where: (where: never) => { const q = new MySqlDialect().sqlToQuery(where); read.sql = q.sql; read.params = q.params; return query }, orderBy: () => query, limit: () => query,
      for: () => { read.locked = true; return query },
      then: (resolve: (rows: unknown[]) => unknown) => { reads.push(read); return Promise.resolve(empty ? [] : results.shift() ?? []).then(resolve) }
    }
    return query
  }
  const tx = {
    select: () => select(), selectDistinct: () => select(true),
    insert: (table: never) => ({ values: async (value: Record<string, unknown> | Record<string, unknown>[]) => { for (const values of Array.isArray(value) ? value : [value]) writes.push({ table: getTableName(table), values }) } }),
    update: (table: never) => ({ set: (values: Record<string, unknown>) => ({ where: async () => { writes.push({ table: getTableName(table), values }); return [{ affectedRows: changed }] } }) })
  }
  const db = { ...tx, transaction: async (run: (transaction: typeof tx) => unknown) => { try { return await run(tx) } catch (error) { rolledBack = true; throw error } } }
  return { db: db as never, reads, writes, rollback: () => rolledBack }
}
const scope = { customerId: "buyer", eventId: "event", tenantId: "tenant" }
const event = { id: "event", slug: "fiesta", name: "Fiesta", date: new Date(), status: "live", venue: null, location: null, imageUrl: null }
const share = { id: "share", eventId: "event", tenantId: "tenant", ownerCustomerId: "buyer", transportId: "bus", cancelledAt: null }
const booking = { transportId: "bus", name: "Desde Santo Tomé", address: "7 de Marzo", latitude: "-31.66", longitude: "-60.76", priceAtTime: "18000.00" }
const input = { firstName: "Ana", lastName: "García", dni: "30123456", phone: "5491155555555", email: "ana@example.com" }
const row = { transfer: { id: "transfer" }, pass: { id: "pass", qrHash: "old-qr", status: "PENDING" }, booking }
test.each(["draft", "on_sale", "live", "closed"])("%s: reserva pasajes con locks, scope y exclusión de links combinados", async (status: string) => {
  const f = fixture([[{ id: "buyer" }], [{ ...event, status }], [{ id: "bus", name: booking.name }], [{ id: "pass" }]])
  const result = await createTransportShare(f.db, { ...scope, transportId: "bus", quantity: 1 })
  expect(result.ok).toBe(true)
  expect(f.writes.map((w) => w.table)).toEqual(["transport_shares", "transport_transfers"])
  expect(f.reads.find((r) => r.table === "customers")?.locked).toBe(true)
  const passes = f.reads.find((r) => r.table === "transport_tickets")!
  expect(passes.locked).toBe(true)
  expect(passes.sql).toContain("ticket_transfers")
  expect(passes.sql).toContain("transport_transfers")
  expect(passes.params).toEqual(["tenant", "event", "bus", "COMPLETED", "buyer", "PENDING"])
})
test.each(["draft", "on_sale", "live", "closed"])("%s: traspasa el pasaje con un QR nuevo sin cambiar ventas", async (status: string) => {
  const f = fixture([[share], [{ ...event, status }], [{ id: "friend", isActive: true, name: "Privado", phone: "old", email: "private@example.com" }], [], [row]])
  const result = await claimTransportShare(f.db, "token", input)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.claimed.kind).toBe("transport")
  expect(result.claimed.claimant).toMatchObject({ customerId: "friend", name: "Ana García", createdNow: false })
  expect(result.claimed.qrHash).not.toBe("old-qr")
  expect(f.writes.map((w) => w.table)).toEqual(["transport_tickets", "transport_transfers"])
  expect(f.writes[0].values).toMatchObject({ customerId: "friend", buyerDni: "30123456", buyerPhone: input.phone })
})
test("propietario, inactivo y segundo reclamo se rechazan sin entregar otro QR", async () => {
  for (const [customer, already, code] of [[{ id: "buyer" }, [], "OWN_SHARE"], [{ id: "friend", isActive: false }, [], "CUSTOMER_INACTIVE"], [{ id: "friend", isActive: true }, [{ id: "claimed" }], "ALREADY_CLAIMED"]] as const) {
    const f = fixture([[share], [event], [customer], [...already]])
    expect(await claimTransportShare(f.db, "token", input)).toEqual({ ok: false, code })
    expect(f.writes).toHaveLength(0)
  }
})
test("si se escaneó durante el canje se revierte el traspaso completo", async () => {
  const f = fixture([[share], [event], [{ id: "friend", isActive: true }], [], [row]], 0)
  expect(await claimTransportShare(f.db, "token", input)).toEqual({ ok: false, code: "SOLD_OUT" })
  expect(f.rollback()).toBe(true)
})
test("link cancelado o evento eliminado nunca entrega pasajes", async () => {
  for (const [s, ev, code] of [[{ ...share, cancelledAt: new Date() }, event, "SHARE_CANCELLED"], [share, null, "EVENT_CLOSED"]] as const) {
    const f = fixture([[s], ev ? [ev] : []])
    expect(await claimTransportShare(f.db, "token", input)).toEqual({ ok: false, code })
    expect(f.writes).toHaveLength(0)
  }
})
test("cancelar libera sólo cupos pendientes del link del dueño identificado", async () => {
  const f = fixture([[share]])
  expect(await cancelTransportShare(f.db, { ...scope, shareId: "share" })).toEqual({ ok: true })
  expect(f.reads[0].params).toEqual(["share", "buyer", "event", "tenant"])
  expect(f.writes[1].values).toEqual({ status: "VOID" })
})
test("vista previa muestra dirección y mapa sin revelar QR o datos del pasajero", async () => {
  const f = fixture([[{ share, event, ownerName: "Facundo Pérez", productoraName: "Productora", route: booking }], [{ transfer: { status: "PENDING" }, pass: { customerId: "buyer", status: "PENDING", qrHash: "private-qr" } }]])
  const preview = await getTransportSharePreview(f.db, "token")
  expect(preview).toMatchObject({ kind: "transport", hostName: "Facundo", remaining: 1, state: "AVAILABLE", transport: { address: "7 de Marzo" } })
  expect(JSON.stringify(preview)).not.toContain("qrHash")
})
