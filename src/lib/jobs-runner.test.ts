import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test"

// Sin DB ni Meta: el runner contra una base simulada que responde según la forma del `select`, y
// `fetch` interceptado para ver exactamente qué se le manda a la Graph API. El SQL (estado, tenant,
// entradas no anuladas) no se ejercita acá; importa qué decide el runner con las filas que recibe y
// qué manda: la hora de envío de cada evento, el interruptor, la plantilla y a quién.
const NOW = new Date("2026-10-10T20:00:00.000Z")
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000)

type Audience = { customerId: string; name: string; phone: string | null }

let candidates: Record<string, unknown>[] = []
let audiences: Audience[][] = []
let updates: Record<string, unknown>[] = []
let queries: string[] = []

function fakeDb() {
  const thenable = (rows: () => unknown[], label: string) => {
    const chain: Record<string, unknown> = {}
    for (const method of ["from", "innerJoin", "where"]) chain[method] = () => chain
    chain.then = (resolve: (r: unknown[]) => unknown, reject: (e: unknown) => unknown) => {
      queries.push(label)
      return Promise.resolve(rows()).then(resolve, reject)
    }
    return chain
  }
  return {
    select: (fields: Record<string, unknown>) => {
      const keys = Object.keys(fields)
      // Transición on_sale → live: nada vence en estos tests.
      if (keys.includes("wentLiveAt")) return thenable(() => [], "transition")
      return thenable(() => candidates, "candidates")
    },
    // Una lista de destinatarios por evento vencido, en el orden en que el runner los procesa.
    selectDistinct: () => thenable(() => audiences.shift() ?? [], "audience"),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values)
          return Promise.resolve()
        },
      }),
    }),
  }
}

mock.module("../db", () => ({ pool: {} }))
mock.module("drizzle-orm/mysql2", () => ({ drizzle: () => fakeDb() }))

const { runJobsTick } = await import("./jobs-runner")

type Sent = { to: string; template: string; body: string[]; button: string | undefined }
let sent: Sent[] = []
let graphStatus = 200
const realFetch = globalThis.fetch

/** Evento en venta, con la configuración por defecto, que empieza en 30 minutos: le toca salir. */
function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "ev-1",
    tenantId: "t-1",
    name: "Fiesta",
    slug: "fiesta",
    status: "on_sale",
    date: at(30),
    doorsAt: null,
    whatsappReminderEnabled: true,
    whatsappReminderLeadMinutes: 60,
    whatsappReminderSentAt: null,
    ...overrides,
  }
}

const ANA: Audience = { customerId: "c-1", name: "Ana", phone: "1155550001" }
const BETO: Audience = { customerId: "c-2", name: "Beto", phone: "1155550002" }

beforeEach(() => {
  setSystemTime(NOW)
  candidates = []
  audiences = []
  updates = []
  queries = []
  sent = []
  graphStatus = 200
  process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba"
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456"
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body))
    const components: { type: string; parameters: { text: string }[] }[] =
      payload.template.components ?? []
    sent.push({
      to: payload.to,
      template: payload.template.name,
      body: components.find((c) => c.type === "body")?.parameters.map((p) => p.text) ?? [],
      button: components.find((c) => c.type === "button")?.parameters[0]?.text,
    })
    return graphStatus === 200
      ? new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }))
      : new Response(JSON.stringify({ error: { message: "rechazado" } }), { status: 400 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  setSystemTime()
})

describe("recordatorio de WhatsApp", () => {
  test("manda la plantilla a cada persona con su nombre, el del evento y el botón, y marca el evento", async () => {
    candidates = [candidate()]
    audiences = [[ANA, BETO]]

    await runJobsTick()

    expect(sent).toEqual([
      { to: "5491155550001", template: "crow_recordatorio", body: ["Ana", "Fiesta"], button: "fiesta" },
      { to: "5491155550002", template: "crow_recordatorio", body: ["Beto", "Fiesta"], button: "fiesta" },
    ])
    expect(updates).toHaveLength(1)
    expect(updates[0].whatsappReminderSentAt).toBeInstanceOf(Date)
  })

  test("sin slug el botón lleva el id del evento", async () => {
    candidates = [candidate({ slug: null })]
    audiences = [[ANA]]

    await runJobsTick()

    expect(sent.map((s) => s.button)).toEqual(["ev-1"])
  })

  test("no manda antes de la hora de envío", async () => {
    candidates = [candidate({ date: at(300) })]
    audiences = [[ANA]]

    await runJobsTick()

    expect(sent).toEqual([])
    expect(updates).toEqual([])
  })

  test("cada evento sale con su propio adelanto", async () => {
    // Los dos empiezan en 2 horas. Con 60 minutos de adelanto todavía falta; con 180 ya salió.
    candidates = [
      candidate({ id: "ev-corto", name: "Corto", date: at(120), whatsappReminderLeadMinutes: 60 }),
      candidate({ id: "ev-largo", name: "Largo", date: at(120), whatsappReminderLeadMinutes: 180 }),
    ]
    audiences = [[ANA]]

    await runJobsTick()

    expect(sent.map((s) => s.body[1])).toEqual(["Largo"])
    expect(updates).toHaveLength(1)
  })

  test("la hora de puertas, si existe, pisa a la fecha del evento", async () => {
    candidates = [candidate({ date: at(600), doorsAt: at(30) })]
    audiences = [[ANA]]

    await runJobsTick()

    expect(sent).toHaveLength(1)
  })

  test("un evento con el recordatorio apagado no manda nada", async () => {
    candidates = [candidate({ whatsappReminderEnabled: false })]
    audiences = [[ANA]]

    await runJobsTick()

    expect(sent).toEqual([])
    expect(updates).toEqual([])
  })

  test("un evento que ya lo envió no lo repite", async () => {
    candidates = [candidate({ whatsappReminderSentAt: at(-5) })]
    audiences = [[ANA]]

    await runJobsTick()

    expect(sent).toEqual([])
    expect(updates).toEqual([])
  })

  test("sin el WhatsApp de la plataforma configurado no consulta ni manda nada", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN
    delete process.env.WHATSAPP_PHONE_NUMBER_ID
    candidates = [candidate()]
    audiences = [[ANA]]

    await runJobsTick()

    expect(sent).toEqual([])
    expect(updates).toEqual([])
    expect(queries).not.toContain("candidates")
  })

  test("el evento queda marcado aunque Meta rechace los mensajes: sale una sola vez", async () => {
    graphStatus = 400
    candidates = [candidate()]
    audiences = [[ANA, BETO]]

    await runJobsTick()

    expect(sent).toHaveLength(2)
    expect(updates).toHaveLength(1)
    expect(updates[0].whatsappReminderSentAt).toBeInstanceOf(Date)
  })

  test("las personas sin celular usable quedan fuera del envío", async () => {
    candidates = [candidate()]
    audiences = [[ANA, { customerId: "c-3", name: "Cami", phone: null }]]

    await runJobsTick()

    expect(sent.map((s) => s.body[0])).toEqual(["Ana"])
  })
})
