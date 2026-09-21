import { describe, expect, test } from "bun:test"
import { generateCode, hashCode, maskPhone, normalizeIdentifier } from "./customer-access"

describe("Identificación del cliente por DNI o celular", () => {
  test("un número de hasta 8 dígitos es DNI", () => {
    expect(normalizeIdentifier("30123456")).toEqual({
      kind: "dni",
      value: "30123456",
      candidates: ["30123456"],
    })
    expect(normalizeIdentifier("1234567")?.kind).toBe("dni")
  })

  test("los separadores no cambian el documento", () => {
    expect(normalizeIdentifier("30.123.456")?.value).toBe("30123456")
    expect(normalizeIdentifier(" 30123456 ")?.value).toBe("30123456")
  })

  test("un número de 10 dígitos o más es celular y se normaliza al formato de WhatsApp", () => {
    const local = normalizeIdentifier("11 5555-5555")
    expect(local?.kind).toBe("phone")
    expect(local?.value).toBe("5491155555555")
  })

  test("el celular ya internacional no se duplica el prefijo", () => {
    expect(normalizeIdentifier("+54 9 11 5555-5555")?.value).toBe("5491155555555")
    expect(normalizeIdentifier("5491155555555")?.value).toBe("5491155555555")
  })

  test("el celular acepta las variantes con las que se pudo haber guardado la ficha", () => {
    const parsed = normalizeIdentifier("11 5555-5555")
    expect(parsed?.candidates).toContain("1155555555")
    expect(parsed?.candidates).toContain("5491155555555")
  })

  test("9 dígitos es ambiguo, y lo demasiado corto o largo no es ninguno de los dos", () => {
    expect(normalizeIdentifier("123456789")).toBeNull()
    expect(normalizeIdentifier("12345")).toBeNull()
    expect(normalizeIdentifier("1234567890123456")).toBeNull()
    expect(normalizeIdentifier("sin numeros")).toBeNull()
    expect(normalizeIdentifier("")).toBeNull()
  })
})

describe("Teléfono enmascarado", () => {
  test("deja reconocer el número sin exponerlo entero", () => {
    expect(maskPhone("5491155551234")).toBe("+54 9 •••• 1234")
  })

  test("un número no argentino conserva sólo los últimos 4 dígitos", () => {
    expect(maskPhone("155551234")).toBe("•••• 1234")
  })

  test("un valor sin dígitos suficientes no filtra nada", () => {
    expect(maskPhone("12")).toBe("••••")
  })
})

describe("Código", () => {
  test("siempre son 6 dígitos", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCode()).toMatch(/^\d{6}$/)
    }
  })

  test("el hash depende del código y de la fila: el mismo código en otra fila no coincide", () => {
    const id = "11111111-1111-1111-1111-111111111111"
    const other = "22222222-2222-2222-2222-222222222222"

    expect(hashCode("123456", id)).toBe(hashCode("123456", id))
    expect(hashCode("123456", id)).not.toBe(hashCode("123456", other))
    expect(hashCode("123456", id)).not.toBe(hashCode("654321", id))
    expect(hashCode("123456", id)).toHaveLength(64)
  })
})
