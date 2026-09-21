import { beforeEach, describe, expect, test } from "bun:test"
import { consumeRateLimit, releaseRateLimit, resetRateLimits } from "./rate-limit"

const MINUTE = 60 * 1000

beforeEach(() => {
  resetRateLimits()
})

describe("Ventana deslizante", () => {
  test("deja pasar hasta el límite y después bloquea con lo que falta para liberar", () => {
    expect(consumeRateLimit("k", 2, MINUTE).ok).toBe(true)
    expect(consumeRateLimit("k", 2, MINUTE).ok).toBe(true)

    const blocked = consumeRateLimit("k", 2, MINUTE)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.retryAfterMs).toBeGreaterThan(0)
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(MINUTE)
    }
  })

  test("claves distintas no comparten cupo", () => {
    expect(consumeRateLimit("a", 1, MINUTE).ok).toBe(true)
    expect(consumeRateLimit("a", 1, MINUTE).ok).toBe(false)
    expect(consumeRateLimit("b", 1, MINUTE).ok).toBe(true)
  })

  test("un consumo bloqueado igual queda contado: insistir no corre la ventana", () => {
    consumeRateLimit("k", 1, MINUTE)
    const first = consumeRateLimit("k", 1, MINUTE)
    const second = consumeRateLimit("k", 1, MINUTE)
    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    if (!first.ok && !second.ok) {
      expect(second.retryAfterMs).toBeLessThanOrEqual(first.retryAfterMs)
    }
  })
})

describe("Devolver un cupo", () => {
  test("el consumo liberado deja de contar", () => {
    const first = consumeRateLimit("k", 1, MINUTE)
    expect(first.ok).toBe(true)
    expect(consumeRateLimit("k", 1, MINUTE).ok).toBe(false)

    if (first.ok) releaseRateLimit("k", first.at)

    expect(consumeRateLimit("k", 1, MINUTE).ok).toBe(true)
  })

  test("liberar una marca ajena no devuelve nada", () => {
    const consumed = consumeRateLimit("k", 1, MINUTE)
    if (consumed.ok) releaseRateLimit("k", consumed.at + 1)
    expect(consumeRateLimit("k", 1, MINUTE).ok).toBe(false)
  })

  test("con varios consumos, sólo se va el que se devuelve", () => {
    const first = consumeRateLimit("k", 2, MINUTE)
    const second = consumeRateLimit("k", 2, MINUTE)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)

    if (first.ok) releaseRateLimit("k", first.at)

    // Queda uno de los dos: entra un tercero y recién el cuarto se bloquea.
    expect(consumeRateLimit("k", 2, MINUTE).ok).toBe(true)
    expect(consumeRateLimit("k", 2, MINUTE).ok).toBe(false)
  })

  test("una marca que ya venció se comporta como si no estuviera", async () => {
    const consumed = consumeRateLimit("k", 1, 1)
    expect(consumed.ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 5))
    if (consumed.ok) expect(() => releaseRateLimit("k", consumed.at)).not.toThrow()

    expect(consumeRateLimit("k", 1, 1).ok).toBe(true)
  })

  test("liberar una clave que nunca se usó no rompe", () => {
    expect(() => releaseRateLimit("nunca-usada", Date.now())).not.toThrow()
  })
})
