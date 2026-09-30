import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test"
import { getTableName } from "drizzle-orm"
import type { Context, Next } from "hono"

// Sin DB: los endpoints reales de la pantalla "Mensajes" del evento contra una base simulada que
// responde según la tabla. El SQL (tenant, entradas no anuladas) no se ejercita acá; importa el
// contrato HTTP: quién puede verla y configurarla, qué se valida, qué se guarda y la confirmación que
// exige un cambio que hace salir el mensaje en el próximo minuto (un envío masivo sin vuelta atrás).
const NOW = new Date("2026-10-10T20:00:00.000Z")
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000)

type Row = Record<string, unknown>
type Audience = { customerId: string; name: string; phone: string | null }

/** Evento en venta que empieza en 5 horas, con la configuración por defecto: todavía no le toca. */
const baseEvent = (): Row => ({
  id: "event-1",
  tenantId: "tenant-1",
  name: "Fiesta",
  slug: "fiesta",
  status: "on_sale",
  operationMode: "FULL_OPERATION",
  date: at(300),
  doorsAt: null,
  whatsappReminderEnabled: true,
  whatsappReminderLeadMinutes: 60,
  whatsappReminderSentAt: null,
})

// Ana y Beto reciben el mensaje; Cami tiene entrada pero no celular.
const AUDIENCE: Audience[] = [
  { customerId: "c-1", name: "Ana", phone: "1155550001" },
  { customerId: "c-2", name: "Beto", phone: "1155550002" },
  { customerId: "c-3", name: "Cami", phone: null },
]

let currentStaff: Record<string, unknown>
let eventRow: Row | null
let updates: Row[]
let inserts: { table: string; values: Row }[]
let queries: string[]

function fakeDb() {
  const thenable = (table: () => string) => {
    const chain: Record<string, unknown> = {}
    for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit"]) {
      chain[method] = () => chain
    }
    chain.from = (source: unknown) => {
      const name = getTableName(source as never)
      table = () => name
      return chain
    }
    chain.then = (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => {
      const name = table()
      queries.push(name)
      const rows = name === "events" ? (eventRow ? [eventRow] : []) : []
      return Promise.resolve(rows).then(resolve, reject)
    }
    return chain
  }
  return {
    select: () => thenable(() => ""),
    selectDistinct: () => {
      const chain = thenable(() => "")
      chain.then = (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => {
        queries.push("audience")
        return Promise.resolve(AUDIENCE).then(resolve, reject)
      }
      return chain
    },
    update: () => ({
      set: (values: Row) => ({
        where: () => {
          updates.push(values)
          Object.assign(eventRow ?? {}, values)
          return Promise.resolve()
        },
      }),
    }),
    transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        insert: (table: unknown) => ({
          values: (values: Row) => {
            inserts.push({ table: getTableName(table as never), values })
            return Promise.resolve()
          },
        }),
      }),
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

// El query string fuerza una instancia propia de `./events`. Bun comparte los módulos entre archivos
// de test y `eventsRoute` captura el `authMiddleware` mockeado al evaluarse: sin él estas pruebas
// correrían con el staff de otro archivo (p. ej. events-promoter-owner.test.ts) y darían 403.
// @ts-expect-error tsc no resuelve el query string; Bun sí.
const { eventsRoute } = await import("./events?whatsapp-reminder")

const asRole = (role: string) => {
  currentStaff = { id: `staff-${role}`, tenantId: "tenant-1", role }
}

const get = () => eventsRoute.request("/event-1/whatsapp-reminder")
const patch = (body: unknown) =>
  eventsRoute.request("/event-1/whatsapp-reminder", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  setSystemTime(NOW)
  eventRow = baseEvent()
  updates = []
  inserts = []
  queries = []
  asRole("ADMIN")
  process.env.WHATSAPP_ACCESS_TOKEN = "token-de-prueba"
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456"
})

afterEach(() => {
  setSystemTime()
})

describe("GET /events/:id/whatsapp-reminder", () => {
  test("muestra el horario, a cuántas personas les llega y el mensaje con su link", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      enabled: true,
      leadMinutes: 60,
      leadLimits: { min: 5, max: 10080 },
      whatsappAvailable: true,
      state: "SCHEDULED",
      sentAt: null,
      // Nada escribe `doorsAt`: la referencia es la fecha y hora del evento.
      reference: { at: at(300).toISOString(), source: "date" },
      sendAt: at(240).toISOString(),
      audience: { recipients: 2, withoutPhone: 1 },
      message: {
        template: "crow_recordatorio",
        bodyTemplate: expect.stringContaining("{{1}}"),
        eventName: "Fiesta",
        buttonLabel: "Ir al evento",
        url: "https://crow.ar/fiesta",
      },
    })
  })

  test("un MANAGER también la ve", async () => {
    asRole("MANAGER")
    expect((await get()).status).toBe(200)
  })

  test.each(["BARTENDER", "SECURITY", "PROMOTER", "GENERAL_PROMOTER"])(
    "%s no la ve, y ni siquiera se consulta el evento",
    async (role: string) => {
      asRole(role)
      const res = await get()
      expect(res.status).toBe(403)
      expect(queries).toEqual([])
    }
  )

  test("un evento inexistente o de otra productora responde 404", async () => {
    eventRow = null
    expect((await get()).status).toBe(404)
  })

  test("una cuenta sin productora asignada responde 400", async () => {
    currentStaff = { id: "staff-x", role: "ADMIN" }
    expect((await get()).status).toBe(400)
  })

  test("avisa cuando el WhatsApp de la plataforma no está configurado", async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN
    const body = (await (await get()).json()) as { whatsappAvailable: boolean; state: string }
    expect(body.whatsappAvailable).toBe(false)
    // El estado del evento no cambia: sólo se avisa que no hay con qué mandar.
    expect(body.state).toBe("SCHEDULED")
  })

  test("un recordatorio ya enviado lo dice y no vuelve a ser programable", async () => {
    eventRow = { ...baseEvent(), whatsappReminderSentAt: at(-5) }
    const body = (await (await get()).json()) as { state: string; sentAt: string }
    expect(body.state).toBe("SENT")
    expect(body.sentAt).toBe(at(-5).toISOString())
  })
})

describe("PATCH /events/:id/whatsapp-reminder", () => {
  test("el administrador lo desactiva", async () => {
    const res = await patch({ enabled: false })
    expect(res.status).toBe(200)
    expect(updates).toEqual([
      { whatsappReminderEnabled: false, whatsappReminderLeadMinutes: 60 },
    ])
    const body = (await res.json()) as { enabled: boolean; state: string }
    expect(body).toMatchObject({ enabled: false, state: "DISABLED" })
  })

  test("cambia el adelanto y devuelve la nueva hora de envío", async () => {
    const res = await patch({ leadMinutes: 180 })
    expect(res.status).toBe(200)
    expect(updates).toEqual([
      { whatsappReminderEnabled: true, whatsappReminderLeadMinutes: 180 },
    ])
    const body = (await res.json()) as { leadMinutes: number; sendAt: string; state: string }
    expect(body).toMatchObject({
      leadMinutes: 180,
      sendAt: at(120).toISOString(),
      state: "SCHEDULED",
    })
  })

  test("un MANAGER también lo configura", async () => {
    asRole("MANAGER")
    expect((await patch({ enabled: false })).status).toBe(200)
  })

  test.each(["BARTENDER", "SECURITY", "PROMOTER", "GENERAL_PROMOTER"])(
    "%s no puede configurarlo",
    async (role: string) => {
      asRole(role)
      const res = await patch({ enabled: false })
      expect(res.status).toBe(403)
      expect(updates).toEqual([])
    }
  )

  test.each([
    ["adelanto menor al mínimo", { leadMinutes: 4 }],
    ["adelanto mayor al máximo", { leadMinutes: 10081 }],
    ["adelanto fraccionario", { leadMinutes: 90.5 }],
    ["adelanto como texto", { leadMinutes: "60" }],
    ["interruptor como texto", { enabled: "false" }],
    ["cuerpo vacío", {}],
    ["sólo la confirmación", { confirmSend: true }],
  ])("rechaza %s sin tocar nada", async (_name: string, body: unknown) => {
    const res = await patch(body)
    expect(res.status).toBe(400)
    expect(updates).toEqual([])
  })

  test("acepta los límites del adelanto", async () => {
    // Evento a un mes: hasta con el máximo (7 días) la hora de envío queda en el futuro.
    eventRow = { ...baseEvent(), date: at(30 * 24 * 60) }
    expect((await patch({ leadMinutes: 5 })).status).toBe(200)
    expect((await patch({ leadMinutes: 10080 })).status).toBe(200)
  })

  test("un evento inexistente o de otra productora responde 404 y no escribe", async () => {
    eventRow = null
    expect((await patch({ enabled: false })).status).toBe(404)
    expect(updates).toEqual([])
  })
})

describe("confirmación de un envío inmediato", () => {
  // Faltan 30 minutos y el adelanto es de 60: la ventana está abierta. Apagado, no sale; al
  // encenderlo el runner lo manda en el próximo minuto a todas las personas con entrada.
  const insideWindow = (overrides: Row = {}) => ({
    ...baseEvent(),
    date: at(30),
    ...overrides,
  })

  test("activarlo con la ventana abierta pide confirmación y avisa a cuántas personas les llega", async () => {
    eventRow = insideWindow({ whatsappReminderEnabled: false })
    const res = await patch({ enabled: true })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: "CONFIRM_IMMEDIATE_SEND",
      recipients: 2,
    })
    expect(updates).toEqual([])
  })

  test("con la confirmación explícita lo activa y queda por salir", async () => {
    eventRow = insideWindow({ whatsappReminderEnabled: false })
    const res = await patch({ enabled: true, confirmSend: true })
    expect(res.status).toBe(200)
    expect(updates).toEqual([
      { whatsappReminderEnabled: true, whatsappReminderLeadMinutes: 60 },
    ])
    expect(((await res.json()) as { state: string }).state).toBe("SENDING")
  })

  test("agrandar el adelanto hasta que la hora de envío ya pasó también la pide", async () => {
    // Faltan 150 minutos y el adelanto es de 60: todavía no. Con 180 la hora de envío ya pasó.
    eventRow = baseEvent()
    eventRow.date = at(150)
    const res = await patch({ leadMinutes: 180 })
    expect(res.status).toBe(409)
    expect(updates).toEqual([])
  })

  test("un adelanto que deja la hora de envío en el futuro no la pide", async () => {
    eventRow = baseEvent()
    eventRow.date = at(150)
    expect((await patch({ leadMinutes: 90 })).status).toBe(200)
  })

  test("si el mensaje ya iba a salir, cambiar el adelanto no la pide de nuevo", async () => {
    eventRow = insideWindow()
    expect((await patch({ leadMinutes: 120 })).status).toBe(200)
  })

  test("desactivarlo nunca la pide, con la ventana abierta o no", async () => {
    eventRow = insideWindow()
    const res = await patch({ enabled: false })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { state: string }).state).toBe("DISABLED")
  })

  test("no la pide si el evento sigue en borrador: no sale hasta abrir la venta", async () => {
    eventRow = insideWindow({ status: "draft", whatsappReminderEnabled: false })
    expect((await patch({ enabled: true })).status).toBe(200)
  })

  test("no la pide si el WhatsApp de la plataforma no está configurado: no sale nada", async () => {
    delete process.env.WHATSAPP_PHONE_NUMBER_ID
    eventRow = insideWindow({ whatsappReminderEnabled: false })
    expect((await patch({ enabled: true })).status).toBe(200)
  })

  test("no la pide si ya salió", async () => {
    eventRow = insideWindow({ whatsappReminderEnabled: false, whatsappReminderSentAt: at(-5) })
    expect((await patch({ enabled: true })).status).toBe(200)
  })
})

describe("el evento y su duplicado", () => {
  test("el evento expone si el recordatorio está activado", async () => {
    eventRow = { ...baseEvent(), whatsappReminderEnabled: false }
    const res = await eventsRoute.request("/event-1")
    expect(res.status).toBe(200)
    const { event } = (await res.json()) as { event: { whatsappReminderEnabled: boolean } }
    expect(event.whatsappReminderEnabled).toBe(false)
  })

  test("duplicar copia el interruptor y el adelanto, pero no la marca de 'ya se envió'", async () => {
    eventRow = {
      ...baseEvent(),
      operationMode: "TICKETS_ONLY",
      whatsappReminderEnabled: false,
      whatsappReminderLeadMinutes: 180,
      whatsappReminderSentAt: at(-5),
    }
    const res = await eventsRoute.request("/event-1/duplicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    const created = inserts.find((i) => i.table === "events")
    expect(created?.values).toMatchObject({
      whatsappReminderEnabled: false,
      whatsappReminderLeadMinutes: 180,
    })
    // El duplicado es un evento nuevo: su recordatorio todavía no salió.
    expect(created?.values).not.toHaveProperty("whatsappReminderSentAt")
  })
})
