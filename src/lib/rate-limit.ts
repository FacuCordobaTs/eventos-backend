/**
 * Limitador de ventana deslizante en memoria, para los endpoints públicos que disparan un envío
 * real (hoy: el código de acceso de cliente por WhatsApp). El repo no tenía ningún rate limiting
 * y `POST /public/customers/access` ya podía usarse como amplificador de mensajes con solo conocer
 * un DNI o un teléfono.
 *
 * Solo protege dentro de un proceso: varias instancias del backend no comparten el estado (el
 * mismo caveat que ya documenta `docs/COMMUNICATIONS_JOBS_AND_REALTIME.md` para los jobs). Antes
 * de escalar horizontalmente, mover el estado a DB o a un store compartido.
 */

/** Timestamps (ms) de los consumos dentro de la ventana, por clave. */
const buckets = new Map<string, number[]>()

/** Cada cuántos consumos se barren las claves vencidas para que el Map no crezca sin límite. */
const SWEEP_EVERY = 500
let sinceSweep = 0

export type RateLimitResult =
  | { ok: true }
  /** `retryAfterMs` es cuánto falta para que la ventana libere un lugar. */
  | { ok: false; retryAfterMs: number }

/**
 * Registra un consumo en la ventana `key` y dice si entra dentro de `limit` por `windowMs`.
 * Consume y verifica en un solo paso: cuando devuelve `{ ok: false }` el intento igual queda
 * contado, así insistir no corre la ventana hacia adelante.
 */
export function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now()
  const cutoff = now - windowMs
  const hits = (buckets.get(key) ?? []).filter((at) => at > cutoff)

  if (hits.length >= limit) {
    buckets.set(key, hits)
    return { ok: false, retryAfterMs: hits[0] + windowMs - now }
  }

  hits.push(now)
  buckets.set(key, hits)

  if (++sinceSweep >= SWEEP_EVERY) {
    sinceSweep = 0
    for (const [bucketKey, timestamps] of buckets) {
      const alive = timestamps.filter((at) => at > cutoff)
      if (alive.length === 0) buckets.delete(bucketKey)
      else buckets.set(bucketKey, alive)
    }
  }

  return { ok: true }
}

/** Limpia el estado. Para tests: sin esto, un caso deja la ventana sucia para el siguiente. */
export function resetRateLimits(): void {
  buckets.clear()
  sinceSweep = 0
}

/**
 * IP del cliente detrás del proxy. Si no hay headers de forwarding (dev, o el servicio expuesto
 * directo) devuelve null y el llamador debe omitir el límite por IP en vez de bloquear a todos
 * bajo la misma clave.
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")
  const first = forwarded?.split(",")[0]?.trim()
  if (first) return first
  return headers.get("x-real-ip")?.trim() || null
}
