import { describe, expect, test } from "bun:test"
import {
  describeReminderMessage,
  listReminderAudience,
  reminderLink,
  reminderReference,
  reminderSchedule,
  reminderSendAt,
  type ReminderEventRow,
} from "./whatsapp-reminder"
import { REMINDER_BUTTON_LABEL, REMINDER_TEMPLATE } from "./whatsapp-service"

const MINUTE = 60_000
const NOW = new Date("2026-10-10T20:00:00.000Z")
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * MINUTE)

/** Evento en venta que empieza en 5 horas, sin hora de puertas y con la configuración por defecto. */
function event(overrides: Partial<ReminderEventRow> = {}): ReminderEventRow {
  return {
    status: "on_sale",
    date: at(300),
    doorsAt: null,
    whatsappReminderEnabled: true,
    whatsappReminderLeadMinutes: 60,
    whatsappReminderSentAt: null,
    ...overrides,
  }
}

const stateOf = (overrides: Partial<ReminderEventRow> = {}) =>
  reminderSchedule(event(overrides), NOW).state

describe("hora de referencia y de envío", () => {
  test("usa la hora de puertas cuando el evento la tiene", () => {
    const doorsAt = at(240)
    expect(reminderReference(event({ doorsAt }))).toEqual({ at: doorsAt, source: "doorsAt" })
  })

  test("sin hora de puertas usa la fecha del evento (la habitual: nada escribe doorsAt)", () => {
    const date = at(300)
    expect(reminderReference(event({ date, doorsAt: null }))).toEqual({ at: date, source: "date" })
  })

  test("el envío es la referencia menos el adelanto", () => {
    expect(reminderSendAt(at(300), 60)).toEqual(at(240))
    expect(reminderSendAt(at(300), 1440)).toEqual(at(300 - 1440))
  })
})

describe("estado del recordatorio", () => {
  test("con la configuración original sale una hora antes de la fecha", () => {
    // Faltan 5 h: todavía no. Faltan 61, 60 y 59 minutos: el límite entra en la ventana.
    expect(stateOf({ date: at(300) })).toBe("SCHEDULED")
    expect(stateOf({ date: at(61) })).toBe("SCHEDULED")
    expect(stateOf({ date: at(60) })).toBe("SENDING")
    expect(stateOf({ date: at(59) })).toBe("SENDING")
  })

  test("la ventana es [envío, referencia): al llegar la hora del evento ya no sale", () => {
    expect(stateOf({ date: at(1) })).toBe("SENDING")
    expect(stateOf({ date: at(0) })).toBe("MISSED")
    expect(stateOf({ date: at(-30) })).toBe("MISSED")
  })

  test("un adelanto mayor abre la ventana antes; uno menor, después", () => {
    // Faltan 150 minutos: con 180 ya salió la hora de envío, con 60 todavía no.
    expect(stateOf({ date: at(150), whatsappReminderLeadMinutes: 180 })).toBe("SENDING")
    expect(stateOf({ date: at(150), whatsappReminderLeadMinutes: 60 })).toBe("SCHEDULED")
    // Con 15 minutos de adelanto, a 20 minutos del evento todavía falta; a 10 ya salió.
    expect(stateOf({ date: at(20), whatsappReminderLeadMinutes: 15 })).toBe("SCHEDULED")
    expect(stateOf({ date: at(10), whatsappReminderLeadMinutes: 15 })).toBe("SENDING")
  })

  test("la hora de puertas pisa a la fecha", () => {
    // La fecha está lejos pero las puertas abren en 30 minutos: sale.
    expect(stateOf({ date: at(600), doorsAt: at(30) })).toBe("SENDING")
    // La fecha ya pasó pero las puertas todavía no: sale.
    expect(stateOf({ date: at(-10), doorsAt: at(30) })).toBe("SENDING")
  })

  test("en vivo también sale mientras falte para la hora del evento", () => {
    expect(stateOf({ status: "live", date: at(30) })).toBe("SENDING")
  })

  test("en borrador espera a que se abra la venta, aunque esté dentro de la ventana", () => {
    expect(stateOf({ status: "draft", date: at(30) })).toBe("WAITING_SALE")
    expect(stateOf({ status: "draft", date: at(300) })).toBe("WAITING_SALE")
  })

  test("un evento cerrado no manda más recordatorios", () => {
    expect(stateOf({ status: "closed", date: at(30) })).toBe("EVENT_CLOSED")
  })

  test("apagado no sale, y apagado gana sobre 'se perdió la hora'", () => {
    expect(stateOf({ whatsappReminderEnabled: false, date: at(30) })).toBe("DISABLED")
    expect(stateOf({ whatsappReminderEnabled: false, date: at(-30) })).toBe("DISABLED")
  })

  test("si ya salió no se repite, sin importar el resto", () => {
    const sentAt = at(-10)
    expect(stateOf({ whatsappReminderSentAt: sentAt, date: at(30) })).toBe("SENT")
    expect(stateOf({ whatsappReminderSentAt: sentAt, whatsappReminderEnabled: false })).toBe("SENT")
    expect(stateOf({ whatsappReminderSentAt: sentAt, status: "closed" })).toBe("SENT")
  })

  test("devuelve la referencia y la hora de envío que usó para decidir", () => {
    const { reference, sendAt } = reminderSchedule(
      event({ date: at(300), whatsappReminderLeadMinutes: 90 }),
      NOW
    )
    expect(reference).toEqual({ at: at(300), source: "date" })
    expect(sendAt).toEqual(at(210))
  })
})

describe("link del botón", () => {
  test("usa la slug del evento y, sin ella, el id", () => {
    expect(reminderLink({ slug: "fiesta-verano", id: "ev-1" })).toEqual({
      parameter: "fiesta-verano",
      url: "https://crow.ar/fiesta-verano",
    })
    expect(reminderLink({ slug: null, id: "ev-1" })).toEqual({
      parameter: "ev-1",
      url: "https://crow.ar/ev-1",
    })
  })

  test("escapa lo que no es seguro en una URL", () => {
    expect(reminderLink({ slug: null, id: "a b/c" }).parameter).toBe("a%20b%2Fc")
  })
})

describe("mensaje", () => {
  test("describe plantilla, botón y link del evento", () => {
    const message = describeReminderMessage({ id: "ev-1", slug: "fiesta", name: "Fiesta" })
    expect(message.template).toBe(REMINDER_TEMPLATE)
    expect(message.buttonLabel).toBe(REMINDER_BUTTON_LABEL)
    expect(message.url).toBe("https://crow.ar/fiesta")
    expect(message.eventName).toBe("Fiesta")
    // Las dos variables del cuerpo, en el orden en que las manda el runner.
    expect(message.bodyTemplate).toContain("{{1}}")
    expect(message.bodyTemplate).toContain("{{2}}")
  })
})

// Base falsa: la consulta real (join, tenant, entradas no anuladas) es SQL y no se ejercita acá;
// importa qué se hace con las filas que devuelve.
function fakeDb(rows: { customerId: string; name: string; phone: string | null }[]) {
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.innerJoin = () => chain
  chain.where = () => chain
  chain.then = (resolve: (r: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject)
  return { selectDistinct: () => chain } as never
}

describe("destinatarios", () => {
  const audience = (rows: { customerId: string; name: string; phone: string | null }[]) =>
    listReminderAudience(fakeDb(rows), { id: "ev-1", tenantId: "t-1" })

  test("una persona recibe un solo mensaje aunque figure más de una vez", async () => {
    const { recipients, withoutPhone } = await audience([
      { customerId: "c-1", name: "Ana", phone: "1155550001" },
      { customerId: "c-1", name: "Ana", phone: "1155550001" },
      { customerId: "c-2", name: "Beto", phone: "1155550002" },
    ])
    expect(recipients.map((r) => r.customerId)).toEqual(["c-1", "c-2"])
    expect(withoutPhone).toBe(0)
  })

  test("las personas sin celular no reciben, pero se cuentan aparte", async () => {
    const { recipients, withoutPhone } = await audience([
      { customerId: "c-1", name: "Ana", phone: "1155550001" },
      { customerId: "c-2", name: "Beto", phone: null },
      { customerId: "c-3", name: "Cami", phone: "" },
      { customerId: "c-4", name: "Dani", phone: "sin número" },
    ])
    expect(recipients.map((r) => r.customerId)).toEqual(["c-1"])
    expect(withoutPhone).toBe(3)
  })

  test("conserva el celular tal como está guardado (el envío lo normaliza)", async () => {
    const { recipients } = await audience([
      { customerId: "c-1", name: "Ana", phone: "+54 9 11 5555-0001" },
    ])
    expect(recipients).toEqual([
      { customerId: "c-1", name: "Ana", phone: "+54 9 11 5555-0001" },
    ])
  })

  test("sin compradores no hay destinatarios", async () => {
    expect(await audience([])).toEqual({ recipients: [], withoutPhone: 0 })
  })
})
