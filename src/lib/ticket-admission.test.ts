import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { admissionWindowError, admissionWindowFields, isAdmissionWindowOrdered, selectAdmissionTicket } from "./ticket-admission"

const date = (value: string) => new Date(value)
const from = "2026-09-10T21:00:00-03:00"
const until = "2026-09-10T22:00:00-03:00"

describe("Horario de ingreso por tipo de entrada", () => {
  test("mantiene las entradas sin horario y permite quitar límites con null", () => {
    expect(admissionWindowError({}, date(until))).toBeNull()
    expect(admissionWindowError({ validFrom: null, validUntil: null }, date(until))).toBeNull()
  })

  test("hasta las 22 permite 21:59:59 y rechaza exactamente 22:00 y después", () => {
    expect(admissionWindowError({ validUntil: until }, date("2026-09-10T21:59:59.999-03:00"))).toBeNull()
    expect(admissionWindowError({ validUntil: until }, date(until))).toContain("hasta el")
    expect(admissionWindowError({ validUntil: until }, date("2026-09-11T22:00:00-03:00"))).toContain("Fuera de horario")
  })

  test("desde las 21 rechaza antes y permite exactamente la apertura", () => {
    expect(admissionWindowError({ validFrom: from }, date("2026-09-10T20:59:59-03:00"))).toContain("desde el")
    expect(admissionWindowError({ validFrom: from }, date(from))).toBeNull()
    expect(admissionWindowError({ validFrom: from }, date(until))).toBeNull()
  })

  test("una ventana nocturna termina al día siguiente y no se repite cada día", () => {
    const window = { validFrom: from, validUntil: "2026-09-11T03:00:00-03:00" }
    expect(admissionWindowError(window, date("2026-09-11T02:59:00-03:00"))).toBeNull()
    expect(admissionWindowError(window, date("2026-09-11T03:00:00-03:00"))).not.toBeNull()
    expect(admissionWindowError(window, date("2026-09-11T21:30:00-03:00"))).not.toBeNull()
  })

  test("compara instantes UTC y muestra hora Argentina, sin depender del VPS", () => {
    expect(admissionWindowError({ validFrom: from, validUntil: until }, date("2026-09-11T00:30:00Z"))).toBeNull()
    const error = admissionWindowError({ validUntil: date("2026-09-11T01:00:00Z") }, date(until))
    expect(error).toContain("10/09/2026")
    expect(error).toContain("22:00")
    expect(error).toContain("hora Argentina")
  })

  test("valida orden al crear o combinar un PATCH con los valores guardados", () => {
    expect(isAdmissionWindowOrdered({ validFrom: from, validUntil: until })).toBe(true)
    expect(isAdmissionWindowOrdered({ validFrom: until, validUntil: from })).toBe(false)
    expect(isAdmissionWindowOrdered({ validFrom: until, validUntil: until })).toBe(false)
    const saved = { validFrom: from, validUntil: until }
    expect(isAdmissionWindowOrdered({ ...saved, validFrom: "2026-09-11T04:00:00Z" })).toBe(false)
    expect(isAdmissionWindowOrdered({ ...saved, validUntil: null })).toBe(true)
  })

  test("API acepta extremos opcionales y rechaza fechas inválidas o sin zona", () => {
    const schema = z.object(admissionWindowFields)
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ validFrom: null, validUntil: until }).success).toBe(true)
    expect(schema.safeParse({ validFrom: "2026-09-10T22:00:00" }).success).toBe(false)
    expect(schema.safeParse({ validUntil: "2026-02-30T22:00:00Z" }).success).toBe(false)
    expect(schema.safeParse({ validUntil: "22:00" }).success).toBe(false)
  })
})

describe("Selección por DNI", () => {
  const expired = { id: "expired", status: "PENDING", validUntil: until }
  const future = { id: "future", status: "PENDING", validFrom: "2026-09-11T03:00:00-03:00" }
  const pending = { id: "pending", status: "PENDING" }
  const used = { id: "used", status: "USED" }
  test("omite entradas vencidas o futuras y prioriza un primer ingreso", () => {
    expect(selectAdmissionTicket([expired, future, used, pending], date(until))?.id).toBe("pending")
  })
  test("puede elegir un reingreso dentro de horario sin que una pendiente vencida lo tape", () => {
    expect(selectAdmissionTicket([expired, used], date(until))?.id).toBe("used")
  })
  test("elige una entrada fuera de horario para devolver el motivo si ninguna sirve", () => {
    const selected = selectAdmissionTicket([expired, future], date(until))!
    expect(admissionWindowError(selected, date(until))).toContain("Fuera de horario")
  })
  test("respeta orden de emisión y no inventa entradas para un DNI sin tickets", () => {
    expect(selectAdmissionTicket([pending, { ...pending, id: "newer" }], date(from))?.id).toBe("pending")
    expect(selectAdmissionTicket([], date(from))).toBeUndefined()
  })
})
