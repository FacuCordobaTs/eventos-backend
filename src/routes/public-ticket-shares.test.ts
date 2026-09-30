import { beforeEach, describe, expect, mock, test } from "bun:test"
import { createAccessToken } from "../lib/jwt"
import { resetRateLimits } from "../lib/rate-limit"

// Sin DB ni servicios externos: los endpoints reales de "compartir entradas" contra un módulo de
// negocio simulado. La lógica transaccional se prueba en `lib/ticket-shares.test.ts`; acá importa el
// contrato HTTP —validación del formulario, códigos de error, qué se le devuelve a cada persona y
// los límites— y la resolución de las credenciales del dueño.
const realShares = await import("../lib/ticket-shares")
const realMailer = await import("../lib/send-checkout-receipt-email")
const realBroadcast = await import("../lib/public-qr-broadcast")

let selectQueue: unknown[][] = []
const calls = { claim: [] as unknown[][], create: [] as unknown[][], cancel: [] as unknown[][] }
let claimResult: unknown
let createResult: unknown
let cancelResult: unknown
let previewResult: unknown
// Efectos que el canje dispara después de responder: nada sale de verdad en los tests.
const emails: Record<string, unknown>[] = []
let emailFails = false
const broadcasts: string[] = []
let ownerTokens: string[] = []
const dbUpdates: Record<string, unknown>[] = []

function fakeDb() {
  const chain: Record<string, unknown> = {}
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy", "for", "limit"]) {
    chain[method] = () => chain
  }
  chain.then = (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(selectQueue.shift() ?? []).then(resolve, reject)
  return {
    select: () => chain,
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          dbUpdates.push(values)
        },
      }),
    }),
  }
}

mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: () => fakeDb() }))
mock.module("../lib/send-checkout-receipt-email", () => ({
  ...realMailer,
  sendManualTicketQrEmail: async (input: Record<string, unknown>) => {
    emails.push(input)
    if (emailFails) throw new Error("Resend caído")
  },
}))
mock.module("../lib/public-qr-broadcast", () => ({
  ...realBroadcast,
  broadcastReceiptUpdate: (token: string) => {
    broadcasts.push(token)
  },
}))
mock.module("../lib/ticket-shares", () => ({
  ...realShares,
  claimTicketShare: async (...args: unknown[]) => {
    calls.claim.push(args)
    return claimResult
  },
  createTicketShare: async (...args: unknown[]) => {
    calls.create.push(args)
    return createResult
  },
  cancelTicketShare: async (...args: unknown[]) => {
    calls.cancel.push(args)
    return cancelResult
  },
  getSharePreview: async () => previewResult,
  ownerReceiptTokens: async () => ownerTokens,
}))

const { publicRoute } = await import("./public")

/** Los efectos posteriores a la respuesta se disparan sin esperar: se deja correr la cola. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const VALID_CLAIM = {
  firstName: " María ",
  lastName: "García",
  dni: "30.123.456",
  phone: "11 5555-5555",
  email: "  Maria@Example.com ",
}

const CLAIMED = {
  ticketId: "ticket-1",
  qrHash: "11111111-1111-1111-1111-111111111111",
  ticketType: { name: "General", validFrom: null, validUntil: null },
  event: {
    id: "event-1",
    slug: "fiesta",
    name: "Fiesta",
    date: new Date("2026-10-10T23:00:00Z"),
    venue: "Club",
    location: null,
    imageUrl: null,
  },
  tenantId: "tenant-1",
  ownerCustomerId: "owner-1",
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return publicRoute.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  resetRateLimits()
  selectQueue = []
  calls.claim = []
  calls.create = []
  calls.cancel = []
  claimResult = undefined
  createResult = undefined
  cancelResult = undefined
  previewResult = null
  emails.length = 0
  emailFails = false
  broadcasts.length = 0
  ownerTokens = []
  dbUpdates.length = 0
  // Bun carga el `.env` del backend: los tests fijan su propio valor para no depender de él.
  process.env.RESEND_API_KEY = "test-key"
})

describe("Reclamar: el formulario del amigo", () => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    ["nombre vacío", { firstName: "   " }, "firstName", "Ingresá tu nombre"],
    ["apellido vacío", { lastName: "" }, "lastName", "Ingresá tu apellido"],
    ["DNI demasiado corto", { dni: "12345" }, "dni", "Revisá tu DNI"],
    ["DNI con letras", { dni: "abcdefgh" }, "dni", "Revisá tu DNI"],
    ["celular demasiado corto", { phone: "1234" }, "phone", "Revisá tu celular"],
    ["email sin arroba", { email: "maria.example.com" }, "email", "Revisá tu email"],
  ]
  for (const [label, override, field, message] of cases) {
    test(`rechaza con el campo y el motivo: ${label}`, async () => {
      const res = await post("/ticket-shares/tok/claim", { ...VALID_CLAIM, ...override })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.code).toBe("INVALID_DATA")
      expect(body.field).toBe(field)
      expect(body.error).toContain(message)
      expect(calls.claim).toHaveLength(0)
    })
  }

  test("normaliza lo que se guarda: DNI en dígitos, celular de WhatsApp y email en minúsculas", async () => {
    claimResult = {
      ok: true,
      claimed: { ...CLAIMED, claimant: { customerId: "c1", name: "María García", email: "maria@example.com", createdNow: true } },
    }
    const res = await post("/ticket-shares/tok/claim", VALID_CLAIM)
    expect(res.status).toBe(201)
    expect(calls.claim).toHaveLength(1)
    const [, token, input] = calls.claim[0] as [unknown, string, Record<string, string>]
    expect(token).toBe("tok")
    expect(input).toEqual({
      firstName: "María",
      lastName: "García",
      dni: "30123456",
      phone: "5491155555555",
      email: "maria@example.com",
    })
  })
})

describe("Reclamar: qué se le devuelve a quien reclama", () => {
  test("una ficha recién creada abre la sesión del cliente", async () => {
    claimResult = {
      ok: true,
      claimed: { ...CLAIMED, claimant: { customerId: "c1", name: "María García", email: "m@example.com", createdNow: true } },
    }
    const body = await (await post("/ticket-shares/tok/claim", VALID_CLAIM)).json()
    expect(body.session?.token).toEqual(expect.any(String))
    expect(body.ticket).toMatchObject({ id: "ticket-1", qrHash: CLAIMED.qrHash, status: "PENDING" })
    expect(body.ticket.ticketType.name).toBe("General")
    expect(body.holderName).toBe("María García")
    expect(body.event).toMatchObject({ id: "event-1", slug: "fiesta" })
  })

  test("una ficha que ya existía NO abre sesión: el DNI no se verifica", async () => {
    claimResult = {
      ok: true,
      claimed: { ...CLAIMED, claimant: { customerId: "c9", name: "Nombre Tipeado", email: "m@example.com", createdNow: false } },
    }
    const body = await (await post("/ticket-shares/tok/claim", VALID_CLAIM)).json()
    expect(body.session).toBeNull()
    // Y lo que se devuelve es lo que escribió, nunca datos de la ficha existente.
    expect(body.holderName).toBe("Nombre Tipeado")
    expect(JSON.stringify(body)).not.toContain("c9")
  })

  const errors: [string, number][] = [
    ["SHARE_NOT_FOUND", 404],
    ["SHARE_CANCELLED", 410],
    ["EVENT_CLOSED", 410],
    ["SOLD_OUT", 409],
    ["ALREADY_CLAIMED", 409],
    ["OWN_SHARE", 409],
    ["CUSTOMER_INACTIVE", 403],
  ]
  for (const [code, status] of errors) {
    test(`${code} responde ${status} con su código`, async () => {
      claimResult = { ok: false, code }
      const res = await post("/ticket-shares/tok/claim", VALID_CLAIM)
      expect(res.status).toBe(status)
      const body = await res.json()
      expect(body.code).toBe(code)
      expect(typeof body.error).toBe("string")
    })
  }
})

describe("Reclamar: efectos posteriores", () => {
  const claimed = {
    ...CLAIMED,
    claimant: { customerId: "c1", name: "María García", email: "m@example.com", createdNow: true },
  }

  test("manda una copia de la entrada por email con el link al acceso del evento", async () => {
    claimResult = { ok: true, claimed }
    expect((await post("/ticket-shares/tok/claim", VALID_CLAIM)).status).toBe(201)
    await settle()

    expect(emails).toHaveLength(1)
    expect(emails[0]).toMatchObject({ ticketId: "ticket-1", tenantId: "tenant-1" })
    expect(String(emails[0]?.linkUrl)).toEndWith("/fiesta/acceso")
    // Queda marcado que ya se le mandó.
    expect(dbUpdates.some((values) => values.emailSentAt instanceof Date)).toBe(true)
  })

  test("si el mail falla o no está configurado, el canje igual sale bien", async () => {
    claimResult = { ok: true, claimed }

    emailFails = true
    expect((await post("/ticket-shares/tok/claim", VALID_CLAIM)).status).toBe(201)
    await settle()
    expect(emails).toHaveLength(1)
    expect(dbUpdates.some((values) => values.emailSentAt instanceof Date)).toBe(false)

    emails.length = 0
    process.env.RESEND_API_KEY = ""
    expect((await post("/ticket-shares/tok2/claim", VALID_CLAIM)).status).toBe(201)
    await settle()
    expect(emails).toHaveLength(0)
  })

  test("un canje rechazado no manda mail ni avisa a nadie", async () => {
    ownerTokens = ["receipt-1"]
    claimResult = { ok: false, code: "SOLD_OUT" }
    await post("/ticket-shares/tok/claim", VALID_CLAIM)
    await settle()
    expect(emails).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)
  })

  test("avisa a los comprobantes abiertos del dueño para que vea el traspaso al instante", async () => {
    ownerTokens = ["receipt-1", "receipt-2"]
    claimResult = { ok: true, claimed }
    await post("/ticket-shares/tok/claim", VALID_CLAIM)
    await settle()
    expect(broadcasts).toEqual(["receipt-1", "receipt-2"])
  })
})

describe("Reclamar: límites", () => {
  test("un mismo link se corta cuando recibe demasiados intentos", async () => {
    claimResult = { ok: false, code: "SOLD_OUT" }
    let last = 0
    for (let i = 0; i < 61; i++) {
      last = (await post("/ticket-shares/same/claim", VALID_CLAIM)).status
    }
    expect(last).toBe(429)
    // Otro link no se ve afectado.
    expect((await post("/ticket-shares/other/claim", VALID_CLAIM)).status).toBe(409)
  })

  test("una misma IP se corta aunque cambie de link", async () => {
    claimResult = { ok: false, code: "SOLD_OUT" }
    const headers = { "x-forwarded-for": "203.0.113.7" }
    let last = 0
    for (let i = 0; i < 21; i++) {
      last = (await post(`/ticket-shares/link-${i}/claim`, VALID_CLAIM, headers)).status
    }
    expect(last).toBe(429)
    expect((await post("/ticket-shares/link-x/claim", VALID_CLAIM, { "x-forwarded-for": "203.0.113.8" })).status).toBe(409)
  })
})

describe("Vista previa del link", () => {
  test("un link inexistente es 404", async () => {
    previewResult = null
    const res = await publicRoute.request("/ticket-shares/nope")
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe("SHARE_NOT_FOUND")
  })

  test("muestra quién lo pasó, el evento y cuántas quedan, sin QRs ni datos de otros", async () => {
    previewResult = {
      state: "AVAILABLE",
      hostName: "Facundo",
      event: CLAIMED.event,
      productoraName: "Productora",
      ticketType: { name: "VIP", validFrom: null, validUntil: new Date("2026-10-11T05:00:00Z") },
      remaining: 2,
      total: 3,
    }
    const res = await publicRoute.request("/ticket-shares/tok")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      state: "AVAILABLE",
      hostName: "Facundo",
      productora: { name: "Productora" },
      ticketType: { name: "VIP", validFrom: null, validUntil: "2026-10-11T05:00:00.000Z" },
      remaining: 2,
      total: 3,
    })
    expect(body.event).toMatchObject({ id: "event-1", slug: "fiesta", name: "Fiesta" })
    expect(JSON.stringify(body)).not.toContain("qrHash")
  })
})

describe("Armar y cancelar: credenciales del dueño", () => {
  const SALE = { customerId: "owner-1", eventId: "event-1", tenantId: "tenant-1", status: "COMPLETED" }
  const SHARE_DTO = {
    id: "share-1",
    token: "tok",
    ticketTypeName: "General",
    total: 2,
    claimed: 0,
    pending: 2,
    status: "ACTIVE",
    createdAt: null,
    claims: [],
  }

  test("sin ninguna credencial no se arma nada", async () => {
    const res = await post("/ticket-shares", { ticketTypeId: "type-1", quantity: 2 })
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe("HOLDER_NOT_FOUND")
    expect(calls.create).toHaveLength(0)
  })

  test("un comprobante inexistente o de una compra sin acreditar no sirve", async () => {
    selectQueue = [[]]
    expect((await post("/ticket-shares", { receiptToken: "r", ticketTypeId: "type-1", quantity: 2 })).status).toBe(404)

    selectQueue = [[{ ...SALE, status: "PENDING" }]]
    expect((await post("/ticket-shares", { receiptToken: "r", ticketTypeId: "type-1", quantity: 2 })).status).toBe(404)
    expect(calls.create).toHaveLength(0)
  })

  test("con el comprobante de una compra acreditada arma el link del dueño de esa compra", async () => {
    selectQueue = [[SALE]]
    createResult = { ok: true, share: SHARE_DTO }
    const res = await post("/ticket-shares", { receiptToken: "r", ticketTypeId: "type-1", quantity: 2 })
    expect(res.status).toBe(201)
    expect((await res.json()).share).toMatchObject({ id: "share-1", token: "tok", pending: 2 })
    expect(calls.create[0]?.[1]).toEqual({
      customerId: "owner-1",
      eventId: "event-1",
      tenantId: "tenant-1",
      ticketTypeId: "type-1",
      quantity: 2,
    })
  })

  test("valida la cantidad antes de tocar nada", async () => {
    for (const quantity of [0, -3, 2.5, 51, "2"]) {
      const res = await post("/ticket-shares", { receiptToken: "r", ticketTypeId: "type-1", quantity })
      expect(res.status).toBe(400)
    }
    expect(calls.create).toHaveLength(0)
  })

  test("los errores de negocio viajan con su código", async () => {
    selectQueue = [[SALE]]
    createResult = { ok: false, code: "NOT_ENOUGH_TICKETS" }
    const res = await post("/ticket-shares", { receiptToken: "r", ticketTypeId: "type-1", quantity: 9 })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("NOT_ENOUGH_TICKETS")
  })

  describe("con la sesión del evento (customerToken)", () => {
    const CUSTOMER = { id: "friend-1", name: "María", email: "m@example.com", phone: null, dni: "30123456" }
    const EVENT_ROW = { tenantId: "tenant-1" }
    const body = (token: string, extra: Record<string, unknown> = {}) => ({
      customerToken: token,
      eventId: "event-1",
      ticketTypeId: "type-1",
      quantity: 1,
      ...extra,
    })

    test("alcanza con haber entrado al evento por el link de acceso", async () => {
      const token = await createAccessToken("friend-1", "customer")
      selectQueue = [[CUSTOMER], [EVENT_ROW], [{ id: "access-code" }]]
      createResult = { ok: true, share: SHARE_DTO }
      const res = await post("/ticket-shares", body(token))
      expect(res.status).toBe(201)
      expect(calls.create[0]?.[1]).toMatchObject({ customerId: "friend-1", eventId: "event-1", tenantId: "tenant-1" })
    })

    test("quien recibió una entrada de un amigo también está adentro del evento, sin compra ni acceso", async () => {
      const token = await createAccessToken("friend-1", "customer")
      // Sin código verificado, sin compra, pero con una entrada recibida.
      selectQueue = [[CUSTOMER], [EVENT_ROW], [], [], [{ id: "ticket-received" }]]
      createResult = { ok: true, share: SHARE_DTO }
      expect((await post("/ticket-shares", body(token))).status).toBe(201)
    })

    test("sin ninguna relación con el evento no puede armar un link", async () => {
      const token = await createAccessToken("friend-1", "customer")
      selectQueue = [[CUSTOMER], [EVENT_ROW], [], [], []]
      const res = await post("/ticket-shares", body(token))
      expect(res.status).toBe(404)
      expect(calls.create).toHaveLength(0)
    })

    test("un token de personal, uno inventado o un evento que no existe no sirven", async () => {
      const staffToken = await createAccessToken("friend-1", "staff")
      selectQueue = [[CUSTOMER], [EVENT_ROW], [{ id: "access-code" }]]
      expect((await post("/ticket-shares", body(staffToken))).status).toBe(404)
      expect((await post("/ticket-shares", body("no-es-un-jwt"))).status).toBe(404)

      const token = await createAccessToken("friend-1", "customer")
      selectQueue = [[CUSTOMER], []]
      expect((await post("/ticket-shares", body(token))).status).toBe(404)
      expect(calls.create).toHaveLength(0)
    })

    test("la sesión sola, sin indicar el evento, no alcanza", async () => {
      const token = await createAccessToken("friend-1", "customer")
      const res = await post("/ticket-shares", { customerToken: token, ticketTypeId: "type-1", quantity: 1 })
      expect(res.status).toBe(404)
    })
  })

  test("cancelar sólo opera sobre los links del dueño que se identifica", async () => {
    selectQueue = [[SALE]]
    cancelResult = { ok: true }
    const ok = await post("/ticket-shares/share-1/cancel", { receiptToken: "r" })
    expect(ok.status).toBe(200)
    expect(calls.cancel[0]?.[1]).toEqual({
      shareId: "share-1",
      customerId: "owner-1",
      eventId: "event-1",
      tenantId: "tenant-1",
    })

    selectQueue = [[]]
    const anonymous = await post("/ticket-shares/share-1/cancel", { receiptToken: "desconocido" })
    expect(anonymous.status).toBe(404)
    expect(calls.cancel).toHaveLength(1)
  })
})
