import { describe, expect, test } from "bun:test"
import { getTableName } from "drizzle-orm"
import {
  admissionWindowEnded,
  cancelTicketShare,
  claimTicketShare,
  createTicketShare,
  firstNameOf,
  generateShareToken,
  isDuplicateEntryError,
  isShareListable,
  isTicketDeliverable,
  joinFullName,
  normalizeClaimPhone,
  normalizeDni,
  shareErrorResponse,
  summarizeShare,
  type ShareErrorCode,
} from "./ticket-shares"

describe("Token del link", () => {
  test("es largo, seguro para una URL y no se repite", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateShareToken()))
    expect(tokens.size).toBe(500)
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/)
    }
  })
})

describe("Datos de quien reclama", () => {
  test("el DNI se reduce a dígitos y respeta el largo de un documento", () => {
    expect(normalizeDni("30.123.456")).toBe("30123456")
    expect(normalizeDni(" 30123456 ")).toBe("30123456")
    expect(normalizeDni("1234567")).toBe("1234567")
    expect(normalizeDni("12345")).toBeNull()
    expect(normalizeDni("1234567890")).toBeNull()
    expect(normalizeDni("abc")).toBeNull()
  })

  test("el celular se guarda en el formato de WhatsApp, el mismo contra el que busca el acceso", () => {
    expect(normalizeClaimPhone("11 5555-5555")).toBe("5491155555555")
    expect(normalizeClaimPhone("+54 9 11 5555-5555")).toBe("5491155555555")
    expect(normalizeClaimPhone("1234567")).toBeNull()
    expect(normalizeClaimPhone("1234567890123456")).toBeNull()
    expect(normalizeClaimPhone("no es un número")).toBeNull()
  })

  test("nombre y apellido se unen sin espacios de más", () => {
    expect(joinFullName("  María ", " del   Valle Pérez ")).toBe("María del Valle Pérez")
  })

  test("al amigo se lo presenta sólo con el nombre de pila de quien armó el link", () => {
    expect(firstNameOf("Facundo Cordoba")).toBe("Facundo")
    expect(firstNameOf("  lucía  ")).toBe("lucía")
    expect(firstNameOf("Invitado")).toBe("Un amigo")
    expect(firstNameOf("")).toBe("Un amigo")
    expect(firstNameOf(null)).toBe("Un amigo")
  })
})

describe("Entradas entregables", () => {
  const now = new Date("2026-09-10T20:00:00Z")

  test("el cierre de la ventana es exclusivo, como en la puerta", () => {
    expect(admissionWindowEnded({ validUntil: new Date("2026-09-10T20:00:00Z") }, now)).toBe(true)
    expect(admissionWindowEnded({ validUntil: new Date("2026-09-10T20:00:01Z") }, now)).toBe(false)
    expect(admissionWindowEnded({ validUntil: null }, now)).toBe(false)
  })

  test("sólo se entrega una entrada pendiente, del dueño y con la ventana vigente", () => {
    const open = { validUntil: null }
    expect(isTicketDeliverable({ status: "PENDING", customerId: "owner" }, "owner", open, now)).toBe(true)
    expect(isTicketDeliverable({ status: "USED", customerId: "owner" }, "owner", open, now)).toBe(false)
    expect(isTicketDeliverable({ status: "CANCELLED", customerId: "owner" }, "owner", open, now)).toBe(false)
    // Ya se la llevó otro (por otro link): no es más del dueño.
    expect(isTicketDeliverable({ status: "PENDING", customerId: "friend" }, "owner", open, now)).toBe(false)
    expect(
      isTicketDeliverable(
        { status: "PENDING", customerId: "owner" },
        "owner",
        { validUntil: new Date("2026-09-10T19:00:00Z") },
        now
      )
    ).toBe(false)
  })
})

describe("Resumen de un link", () => {
  const claimedAt = new Date("2026-09-11T03:00:00Z")
  const pending = { status: "PENDING" as const, deliverable: true, claimantName: null, claimedAt: null }
  const claimed = (name: string) => ({
    status: "CLAIMED" as const,
    deliverable: false,
    claimantName: name,
    claimedAt,
  })

  test("un link con cupos libres está activo y cuenta lo reclamado y lo pendiente", () => {
    const summary = summarizeShare({
      cancelledAt: null,
      rows: [claimed("María García"), pending, pending],
    })
    expect(summary).toMatchObject({ total: 3, claimed: 1, pending: 2, status: "ACTIVE" })
    expect(summary.claims).toEqual([{ name: "María García", claimedAt: claimedAt.toISOString() }])
  })

  test("los cupos cuya entrada ya no se puede entregar no cuentan como pendientes", () => {
    const summary = summarizeShare({
      cancelledAt: null,
      rows: [claimed("Juan"), { ...pending, deliverable: false }],
    })
    expect(summary).toMatchObject({ total: 1, claimed: 1, pending: 0, status: "COMPLETED" })
  })

  test("los cupos anulados (VOID) no son entradas de nadie", () => {
    const summary = summarizeShare({
      cancelledAt: null,
      rows: [pending, { ...pending, status: "VOID" as const }],
    })
    expect(summary).toMatchObject({ total: 1, pending: 1, status: "ACTIVE" })
  })

  test("un link cancelado conserva lo ya reclamado y no deja nada pendiente", () => {
    const summary = summarizeShare({
      cancelledAt: new Date(),
      rows: [claimed("Juan"), pending],
    })
    expect(summary).toMatchObject({ total: 1, claimed: 1, pending: 0, status: "CANCELLED" })
  })

  test("un nombre vacío se muestra como un amigo, sin romper la lista", () => {
    const summary = summarizeShare({ cancelledAt: null, rows: [claimed("  ")] })
    expect(summary.claims[0]?.name).toBe("Un amigo")
  })

  test("el dueño sólo ve los links activos o los que entregaron algo", () => {
    expect(isShareListable({ status: "ACTIVE", claimed: 0 })).toBe(true)
    expect(isShareListable({ status: "COMPLETED", claimed: 2 })).toBe(true)
    expect(isShareListable({ status: "CANCELLED", claimed: 1 })).toBe(true)
    expect(isShareListable({ status: "CANCELLED", claimed: 0 })).toBe(false)
    expect(isShareListable({ status: "COMPLETED", claimed: 0 })).toBe(false)
  })
})

describe("Errores", () => {
  test("cada código tiene un status HTTP y un mensaje para el usuario", () => {
    const codes: ShareErrorCode[] = [
      "SHARE_NOT_FOUND",
      "SHARE_CANCELLED",
      "EVENT_CLOSED",
      "SOLD_OUT",
      "ALREADY_CLAIMED",
      "OWN_SHARE",
      "CUSTOMER_INACTIVE",
      "NOT_ENOUGH_TICKETS",
      "TICKET_TYPE_NOT_FOUND",
      "INVALID_QUANTITY",
      "HOLDER_NOT_FOUND",
    ]
    for (const code of codes) {
      const { status, body } = shareErrorResponse(code)
      expect(status).toBeGreaterThanOrEqual(400)
      expect(body.code).toBe(code)
      expect(body.error.length).toBeGreaterThan(10)
    }
    expect(shareErrorResponse("SOLD_OUT").status).toBe(409)
    expect(shareErrorResponse("SHARE_CANCELLED").status).toBe(410)
  })

  test("reconoce un ER_DUP_ENTRY directo o envuelto por Drizzle", () => {
    expect(isDuplicateEntryError({ code: "ER_DUP_ENTRY" })).toBe(true)
    expect(isDuplicateEntryError({ errno: 1062 })).toBe(true)
    expect(isDuplicateEntryError(new Error("x", { cause: { code: "ER_DUP_ENTRY" } }))).toBe(true)
    expect(isDuplicateEntryError(new Error("otro error"))).toBe(false)
    expect(isDuplicateEntryError(null)).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Transacciones, contra una base falsa con guion. No hay MySQL en los tests: cada `select` devuelve
// el siguiente resultado de la cola (en el orden en que el código consulta) y cada escritura queda
// registrada. Verifica las invariantes —qué se escribe y qué no—, no el SQL.
// -----------------------------------------------------------------------------

type Write = { op: "update" | "insert"; table: string; values: Record<string, unknown> }

function fakeDb(script: {
  selects: unknown[][]
  /** `affectedRows` de cada UPDATE sobre `tickets`, en orden (por defecto 1). */
  ticketUpdates?: number[]
  /** Fallo que tira el INSERT que cumpla la condición. */
  insertError?: (table: string, values: Record<string, unknown>) => unknown
  /** Fallo que tira el UPDATE que cumpla la condición. */
  updateError?: (table: string, values: Record<string, unknown>) => unknown
}) {
  const writes: Write[] = []
  const selects = [...script.selects]
  const ticketUpdates = [...(script.ticketUpdates ?? [])]

  // Cada lectura queda anotada con su tabla principal y si fue bloqueante (`FOR UPDATE`): bajo
  // REPEATABLE READ sólo una lectura bloqueante ve lo último confirmado, así que el ORDEN de los
  // locks importa y se verifica.
  const reads: { table: string; locking: boolean }[] = []
  const select = () => {
    const state = { table: "", locking: false }
    const chain: Record<string, unknown> = {}
    for (const method of ["innerJoin", "leftJoin", "where", "orderBy", "limit"]) {
      chain[method] = () => chain
    }
    chain.from = (table: object) => {
      state.table = getTableName(table as never)
      return chain
    }
    chain.for = () => {
      state.locking = true
      return chain
    }
    chain.then = (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => {
      reads.push({ ...state })
      const rows = selects.shift()
      if (rows === undefined) return Promise.reject(new Error("select sin resultado en el guion")).then(resolve, reject)
      return Promise.resolve(rows).then(resolve, reject)
    }
    return chain
  }

  const tx = {
    select,
    insert: (table: object) => ({
      values: async (values: Record<string, unknown> | Record<string, unknown>[]) => {
        const name = getTableName(table as never)
        for (const row of Array.isArray(values) ? values : [values]) {
          const error = script.insertError?.(name, row)
          if (error) throw error
          writes.push({ op: "insert", table: name, values: row })
        }
        return [{ affectedRows: 1 }]
      },
    }),
    update: (table: object) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          const name = getTableName(table as never)
          const error = script.updateError?.(name, values)
          if (error) throw error
          writes.push({ op: "update", table: name, values })
          if (name === "tickets") return [{ affectedRows: ticketUpdates.shift() ?? 1 }]
          return [{ affectedRows: 1 }]
        },
      }),
    }),
  }
  // Una transacción que termina con una excepción se deshace entera, como en MySQL.
  const state = { rolledBack: false }
  const db = {
    transaction: async (callback: (t: typeof tx) => unknown) => {
      try {
        return await callback(tx)
      } catch (error) {
        state.rolledBack = true
        throw error
      }
    },
  }
  return { db: db as never, writes, state, reads }
}

const SHARE = {
  id: "share-1",
  tenantId: "tenant-1",
  eventId: "event-1",
  ticketTypeId: "type-1",
  ownerCustomerId: "owner-1",
  token: "tok",
  cancelledAt: null,
}
const EVENT = {
  id: "event-1",
  slug: "fiesta",
  name: "Fiesta",
  date: new Date("2026-10-10T23:00:00Z"),
  venue: "Club",
  location: null,
  imageUrl: null,
  status: "on_sale",
}
const TYPE = { name: "General", validFrom: null, validUntil: null }
const pendingTransfer = (n: number, overrides: Record<string, unknown> = {}) => ({
  transferId: `transfer-${n}`,
  ticketId: `ticket-${n}`,
  ticketStatus: "PENDING",
  ticketCustomerId: "owner-1",
  ...overrides,
})

const CLAIM = {
  firstName: "María",
  lastName: "García",
  dni: "30123456",
  phone: "5491155555555",
  email: "maria@example.com",
}

describe("Reclamar una entrada", () => {
  test("un amigo nuevo queda registrado como cliente y recibe la entrada con un QR nuevo", async () => {
    const { db, writes } = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [TYPE],
        [pendingTransfer(1), pendingTransfer(2)],
        [], // no hay cliente con ese DNI
        [], // el email está libre
      ],
    })

    const result = await claimTicketShare(db, "tok", CLAIM)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claimed.ticketId).toBe("ticket-1")
    expect(result.claimed.claimant).toMatchObject({ name: "María García", createdNow: true })
    expect(result.claimed.ownerCustomerId).toBe("owner-1")

    const customer = writes.find((w) => w.op === "insert" && w.table === "customers")
    expect(customer?.values).toMatchObject({
      name: "María García",
      email: "maria@example.com",
      phone: "5491155555555",
      dni: "30123456",
      isActive: true,
    })

    const ticket = writes.find((w) => w.op === "update" && w.table === "tickets")
    expect(ticket?.values).toMatchObject({
      customerId: customer?.values.id,
      buyerName: "María García",
      buyerEmail: "maria@example.com",
      buyerDni: "30123456",
      emailSentAt: null,
    })
    // El QR cambia: el comprador no puede seguir usando su copia. La venta y el promotor no se tocan.
    expect(ticket?.values.qrHash).toBe(result.claimed.qrHash)
    expect(result.claimed.qrHash).toMatch(/^[0-9a-f-]{36}$/)
    expect(ticket?.values).not.toHaveProperty("saleId")
    expect(ticket?.values).not.toHaveProperty("promoterId")

    const transfer = writes.find((w) => w.op === "update" && w.table === "ticket_transfers")
    expect(transfer?.values).toMatchObject({
      status: "CLAIMED",
      toCustomerId: customer?.values.id,
      toName: "María García",
    })
  })

  test("un DNI que ya existe no le cambia el nombre ni el email a esa ficha, y no se le devuelve su nombre", async () => {
    const { db, writes } = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [TYPE],
        [pendingTransfer(1)],
        [{ id: "customer-9", name: "Nombre Guardado", email: "real@example.com", phone: "5491100000000", dni: "30123456", isActive: true }],
        [], // todavía no reclamó en este link
      ],
    })

    const result = await claimTicketShare(db, "tok", {
      ...CLAIM,
      firstName: "Otro",
      lastName: "Nombre",
      phone: "5491199999999",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Sin sesión ni datos de la ficha: el DNI no se verifica.
    expect(result.claimed.claimant).toEqual({
      customerId: "customer-9",
      name: "Otro Nombre",
      email: "maria@example.com",
      createdNow: false,
    })
    expect(writes.some((w) => w.table === "customers")).toBe(false)
    expect(writes.find((w) => w.table === "tickets")?.values).toMatchObject({
      customerId: "customer-9",
      buyerName: "Otro Nombre",
    })
  })

  test("a una ficha sin celular se le completa el que escribió, pero uno existente no se pisa", async () => {
    const withoutPhone = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [TYPE],
        [pendingTransfer(1)],
        [{ id: "customer-9", name: "X", email: "x@example.com", phone: null, isActive: true }],
        [],
      ],
    })
    await claimTicketShare(withoutPhone.db, "tok", CLAIM)
    expect(withoutPhone.writes.find((w) => w.table === "customers")?.values).toEqual({
      phone: "5491155555555",
    })

    const withPhone = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [TYPE],
        [pendingTransfer(1)],
        [{ id: "customer-9", name: "X", email: "x@example.com", phone: "5491100000000", isActive: true }],
        [],
      ],
    })
    await claimTicketShare(withPhone.db, "tok", CLAIM)
    expect(withPhone.writes.some((w) => w.table === "customers")).toBe(false)
  })

  test("si el email ya es de otra ficha, la nueva se crea con el email sintético y el real queda en la entrada", async () => {
    const { db, writes } = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [TYPE],
        [pendingTransfer(1)],
        [], // DNI nuevo
        [{ id: "someone-else" }], // pero el email es de otra persona
      ],
    })

    const result = await claimTicketShare(db, "tok", CLAIM)

    expect(result.ok).toBe(true)
    expect(writes.find((w) => w.table === "customers")?.values).toMatchObject({
      email: "acceso-30123456@crow.local",
      dni: "30123456",
    })
    expect(writes.find((w) => w.table === "tickets")?.values).toMatchObject({
      buyerEmail: "maria@example.com",
    })
  })

  test("si dos pedidos crean el mismo DNI a la vez, el segundo reutiliza la ficha que ganó", async () => {
    const { db, writes } = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [TYPE],
        [pendingTransfer(1)],
        [], // DNI nuevo al consultar
        [], // email libre
        [{ id: "winner-1" }], // otro pedido ya creó al cliente
      ],
      insertError: (table) => (table === "customers" ? { code: "ER_DUP_ENTRY" } : null),
    })

    const result = await claimTicketShare(db, "tok", CLAIM)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claimed.claimant).toMatchObject({ customerId: "winner-1", createdNow: false })
    expect(writes.find((w) => w.table === "tickets")?.values).toMatchObject({ customerId: "winner-1" })
  })

  test("lo primero es el lock del link, y el choque por DNI se resuelve con una lectura actual", async () => {
    const first = fakeDb({ selects: [[SHARE], [EVENT], [TYPE], [pendingTransfer(1)], [], []] })
    await claimTicketShare(first.db, "tok", CLAIM)
    // Sin esto dos amigos leerían los mismos cupos libres: el snapshot se toma después del lock.
    expect(first.reads[0]).toEqual({ table: "ticket_shares", locking: true })

    const race = fakeDb({
      selects: [[SHARE], [EVENT], [TYPE], [pendingTransfer(1)], [], [], [{ id: "winner-1" }]],
      insertError: (table) => (table === "customers" ? { code: "ER_DUP_ENTRY" } : null),
    })
    await claimTicketShare(race.db, "tok", CLAIM)
    // La relectura del ganador: un SELECT común vería el snapshot viejo y no la fila recién confirmada.
    expect(race.reads.at(-1)).toEqual({ table: "customers", locking: true })
  })

  test("el dueño no puede reclamar su propio link", async () => {
    const { db, writes } = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [TYPE],
        [pendingTransfer(1)],
        [{ id: "owner-1", name: "Dueño", email: "o@example.com", phone: null, isActive: true }],
      ],
    })
    const result = await claimTicketShare(db, "tok", CLAIM)
    expect(result).toEqual({ ok: false, code: "OWN_SHARE" })
    expect(writes).toHaveLength(0)
  })

  test("una persona no se lleva dos entradas del mismo link", async () => {
    const { db, writes } = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [TYPE],
        [pendingTransfer(1), pendingTransfer(2)],
        [{ id: "customer-9", name: "X", email: "x@example.com", phone: "1", isActive: true }],
        [{ id: "transfer-old" }], // ya reclamó una
      ],
    })
    expect(await claimTicketShare(db, "tok", CLAIM)).toEqual({ ok: false, code: "ALREADY_CLAIMED" })
    expect(writes).toHaveLength(0)
  })

  test("si el unique de la base detecta el doble reclamo, deshace la entrega", async () => {
    const { db, state } = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [TYPE],
        [pendingTransfer(1)],
        [{ id: "customer-9", name: "X", email: "x@example.com", phone: "1", isActive: true }],
        [],
      ],
      updateError: (table, values) =>
        table === "ticket_transfers" && values.status === "CLAIMED" ? { code: "ER_DUP_ENTRY" } : null,
    })
    expect(await claimTicketShare(db, "tok", CLAIM)).toEqual({ ok: false, code: "ALREADY_CLAIMED" })
    // El UPDATE de `tickets` ya se había hecho: la transacción entera se deshace con él.
    expect(state.rolledBack).toBe(true)
  })

  test("una cuenta desactivada no puede reclamar", async () => {
    const { db, writes } = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [TYPE],
        [pendingTransfer(1)],
        [{ id: "customer-9", name: "X", email: "x@example.com", phone: "1", isActive: false }],
      ],
    })
    expect(await claimTicketShare(db, "tok", CLAIM)).toEqual({ ok: false, code: "CUSTOMER_INACTIVE" })
    expect(writes).toHaveLength(0)
  })

  test("un link inexistente, cancelado o de un evento cerrado no entrega nada", async () => {
    const none = fakeDb({ selects: [[]] })
    expect(await claimTicketShare(none.db, "tok", CLAIM)).toEqual({ ok: false, code: "SHARE_NOT_FOUND" })

    const cancelled = fakeDb({ selects: [[{ ...SHARE, cancelledAt: new Date() }]] })
    expect(await claimTicketShare(cancelled.db, "tok", CLAIM)).toEqual({ ok: false, code: "SHARE_CANCELLED" })

    const closed = fakeDb({ selects: [[SHARE], [{ ...EVENT, status: "closed" }]] })
    expect(await claimTicketShare(closed.db, "tok", CLAIM)).toEqual({ ok: false, code: "EVENT_CLOSED" })

    for (const scenario of [none, cancelled, closed]) expect(scenario.writes).toHaveLength(0)
  })

  test("sin cupos entregables el link está agotado, y los cupos muertos se anulan sin crear ningún cliente", async () => {
    const { db, writes } = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [TYPE],
        [
          // El dueño ya la usó en la puerta.
          pendingTransfer(1, { ticketStatus: "USED" }),
          // Se la llevó otro por otro link.
          pendingTransfer(2, { ticketCustomerId: "someone-else" }),
        ],
      ],
    })

    expect(await claimTicketShare(db, "tok", CLAIM)).toEqual({ ok: false, code: "SOLD_OUT" })

    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ op: "update", table: "ticket_transfers", values: { status: "VOID" } })
  })

  test("una entrada con la ventana de ingreso vencida no se regala", async () => {
    const { db } = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [{ ...TYPE, validUntil: new Date(Date.now() - 60_000) }],
        [pendingTransfer(1)],
      ],
    })
    expect(await claimTicketShare(db, "tok", CLAIM)).toEqual({ ok: false, code: "SOLD_OUT" })
  })

  test("si la puerta usó la entrada entre la lectura y la entrega, se prueba con la siguiente", async () => {
    const { db, writes } = fakeDb({
      selects: [
        [SHARE],
        [EVENT],
        [TYPE],
        [pendingTransfer(1), pendingTransfer(2)],
        [],
        [],
      ],
      // El primer UPDATE condicional no encuentra la fila (ya no está PENDING del dueño).
      ticketUpdates: [0, 1],
    })

    const result = await claimTicketShare(db, "tok", CLAIM)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claimed.ticketId).toBe("ticket-2")
    expect(
      writes.find((w) => w.table === "ticket_transfers" && w.values.status === "VOID")
    ).toBeDefined()
    expect(
      writes.find((w) => w.table === "ticket_transfers" && w.values.status === "CLAIMED")
    ).toBeDefined()
  })

  test("si ningún cupo se pudo entregar, aborta la transacción: el cliente recién creado no queda", async () => {
    const { db, writes, state } = fakeDb({
      selects: [[SHARE], [EVENT], [TYPE], [pendingTransfer(1)], [], []],
      ticketUpdates: [0],
    })
    expect(await claimTicketShare(db, "tok", CLAIM)).toEqual({ ok: false, code: "SOLD_OUT" })
    // El alta del cliente se hizo adentro de la transacción y se deshace con el rollback.
    expect(writes.some((w) => w.op === "insert" && w.table === "customers")).toBe(true)
    expect(state.rolledBack).toBe(true)
  })

  test("un canje exitoso y los rechazos previos a escribir no deshacen nada", async () => {
    const ok = fakeDb({
      selects: [[SHARE], [EVENT], [TYPE], [pendingTransfer(1)], [], []],
    })
    expect((await claimTicketShare(ok.db, "tok", CLAIM)).ok).toBe(true)
    expect(ok.state.rolledBack).toBe(false)

    const soldOut = fakeDb({ selects: [[SHARE], [EVENT], [TYPE], []] })
    await claimTicketShare(soldOut.db, "tok", CLAIM)
    expect(soldOut.state.rolledBack).toBe(false)
  })
})

describe("Armar un link", () => {
  const ARGS = {
    customerId: "owner-1",
    eventId: "event-1",
    tenantId: "tenant-1",
    ticketTypeId: "type-1",
    quantity: 2,
  }
  const OWNER_ROW = { id: "owner-1" }

  test("reserva la cantidad pedida entre las entradas que no están en otro link", async () => {
    const { db, writes } = fakeDb({
      selects: [
        [OWNER_ROW],
        [{ status: "on_sale" }],
        [{ name: "General", validUntil: null }],
        [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
        [{ ticketId: "t1" }], // t1 ya está en otro link
      ],
    })

    const result = await createTicketShare(db, ARGS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.share).toMatchObject({
      ticketTypeName: "General",
      total: 2,
      claimed: 0,
      pending: 2,
      status: "ACTIVE",
      claims: [],
    })
    expect(result.share.token).toMatch(/^[A-Za-z0-9_-]{32}$/)

    const share = writes.find((w) => w.table === "ticket_shares")
    expect(share?.values).toMatchObject({
      ownerCustomerId: "owner-1",
      ticketTypeId: "type-1",
      token: result.share.token,
    })
    const reserved = writes.filter((w) => w.table === "ticket_transfers")
    expect(reserved.map((w) => w.values.ticketId)).toEqual(["t2", "t3"])
    expect(reserved.map((w) => w.values.position)).toEqual([0, 1])
    expect(reserved.every((w) => w.values.fromCustomerId === "owner-1")).toBe(true)
  })

  test("no alcanza con menos entradas libres que las pedidas", async () => {
    const { db, writes } = fakeDb({
      selects: [
        [OWNER_ROW],
        [{ status: "live" }],
        [{ name: "General", validUntil: null }],
        [{ id: "t1" }, { id: "t2" }],
        [{ ticketId: "t1" }],
      ],
    })
    expect(await createTicketShare(db, ARGS)).toEqual({ ok: false, code: "NOT_ENOUGH_TICKETS" })
    expect(writes).toHaveLength(0)
  })

  test("rechaza cantidades inválidas, eventos cerrados, tipos ajenos y ventanas vencidas", async () => {
    for (const quantity of [0, -1, 1.5, 51]) {
      const { db } = fakeDb({ selects: [] })
      expect(await createTicketShare(db, { ...ARGS, quantity })).toEqual({ ok: false, code: "INVALID_QUANTITY" })
    }

    const closed = fakeDb({ selects: [[OWNER_ROW], [{ status: "closed" }]] })
    expect(await createTicketShare(closed.db, ARGS)).toEqual({ ok: false, code: "EVENT_CLOSED" })

    const noType = fakeDb({ selects: [[OWNER_ROW], [{ status: "on_sale" }], []] })
    expect(await createTicketShare(noType.db, ARGS)).toEqual({ ok: false, code: "TICKET_TYPE_NOT_FOUND" })

    const expired = fakeDb({
      selects: [
        [OWNER_ROW],
        [{ status: "on_sale" }],
        [{ name: "General", validUntil: new Date(Date.now() - 1000) }],
      ],
    })
    expect(await createTicketShare(expired.db, ARGS)).toEqual({ ok: false, code: "NOT_ENOUGH_TICKETS" })
  })

  test("un dueño que ya no existe no puede armar links", async () => {
    const { db, writes } = fakeDb({ selects: [[]] })
    expect(await createTicketShare(db, ARGS)).toEqual({ ok: false, code: "HOLDER_NOT_FOUND" })
    expect(writes).toHaveLength(0)
  })

  test("lo primero es el lock del dueño: todo lo que se lee después ya ve lo que confirmó el pedido anterior", async () => {
    const { db, reads } = fakeDb({
      selects: [
        [OWNER_ROW],
        [{ status: "on_sale" }],
        [{ name: "General", validUntil: null }],
        [{ id: "t1" }, { id: "t2" }],
        [],
      ],
    })
    await createTicketShare(db, ARGS)
    // Bajo REPEATABLE READ el snapshot se toma en la primera lectura no bloqueante: si el lock del
    // dueño no fuera primero, un doble toque leería reservas viejas y reservaría dos veces.
    expect(reads[0]).toEqual({ table: "customers", locking: true })
    expect(reads.slice(1).every((read) => read.table !== "customers")).toBe(true)
    // Las entradas candidatas también se leen con lectura actual.
    expect(reads.find((read) => read.table === "tickets")).toEqual({ table: "tickets", locking: true })
  })
})

describe("Cancelar un link", () => {
  const ARGS = { shareId: "share-1", customerId: "owner-1", eventId: "event-1", tenantId: "tenant-1" }

  test("da de baja el link y anula los cupos sin reclamar", async () => {
    const { db, writes } = fakeDb({ selects: [[SHARE]] })
    expect(await cancelTicketShare(db, ARGS)).toEqual({ ok: true })
    expect(writes.find((w) => w.table === "ticket_shares")?.values.cancelledAt).toBeInstanceOf(Date)
    expect(writes.find((w) => w.table === "ticket_transfers")?.values).toEqual({ status: "VOID" })
  })

  test("cancela bajo el lock del link, como el canje", async () => {
    const { db, reads } = fakeDb({ selects: [[SHARE]] })
    await cancelTicketShare(db, ARGS)
    expect(reads[0]).toEqual({ table: "ticket_shares", locking: true })
  })

  test("es idempotente", async () => {
    const { db, writes } = fakeDb({ selects: [[{ ...SHARE, cancelledAt: new Date() }]] })
    expect(await cancelTicketShare(db, ARGS)).toEqual({ ok: true })
    expect(writes).toHaveLength(0)
  })

  test("el link de otra persona, evento o productora es indistinguible de uno inexistente", async () => {
    for (const other of [
      { ...ARGS, customerId: "intruder" },
      { ...ARGS, eventId: "event-2" },
      { ...ARGS, tenantId: "tenant-2" },
    ]) {
      const { db, writes } = fakeDb({ selects: [[SHARE]] })
      expect(await cancelTicketShare(db, other)).toEqual({ ok: false, code: "SHARE_NOT_FOUND" })
      expect(writes).toHaveLength(0)
    }
    const missing = fakeDb({ selects: [[]] })
    expect(await cancelTicketShare(missing.db, ARGS)).toEqual({ ok: false, code: "SHARE_NOT_FOUND" })
  })
})
