import { describe, expect, test } from "bun:test"
import { isValidTicketPromo, ticketPaidUnits } from "./ticket-promo"

describe("ticketPaidUnits", () => {
  test("sin promo cobra todo", () => {
    expect(ticketPaidUnits({ promoBuy: null, promoPay: null }, 3)).toBe(3)
  })
  test("2x1", () => {
    const p = { promoBuy: 2, promoPay: 1 }
    expect([1, 2, 3, 4, 5].map((q) => ticketPaidUnits(p, q))).toEqual([1, 1, 2, 2, 3])
  })
  test("3x2", () => {
    const p = { promoBuy: 3, promoPay: 2 }
    expect([1, 2, 3, 4, 6].map((q) => ticketPaidUnits(p, q))).toEqual([1, 2, 2, 3, 4])
  })
  test("promo inválida se ignora", () => {
    expect(ticketPaidUnits({ promoBuy: 2, promoPay: 2 }, 4)).toBe(4)
  })
})

describe("isValidTicketPromo", () => {
  test("valida combinaciones", () => {
    expect(isValidTicketPromo({ promoBuy: null, promoPay: null })).toBe(true)
    expect(isValidTicketPromo({ promoBuy: 2, promoPay: 1 })).toBe(true)
    expect(isValidTicketPromo({ promoBuy: 2, promoPay: null })).toBe(false)
    expect(isValidTicketPromo({ promoBuy: 1, promoPay: 1 })).toBe(false)
    expect(isValidTicketPromo({ promoBuy: 3, promoPay: 0 })).toBe(false)
  })
})
