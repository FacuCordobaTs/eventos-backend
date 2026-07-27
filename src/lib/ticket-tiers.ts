// ─────────────────────────────────────────────────────────────────────────────
// TANDAS — escalera de precios por tipo de entrada (spec §4.2).
//
// Una tanda ("Early $8.000, 200 cupos") es un peldaño de la escalera de precios de
// un tipo de entrada. El sistema la ejecuta solo: NO hay job ni cron, la tanda activa
// se calcula perezosamente en cada lectura a partir de (tandas, entradas vendidas, ahora).
//
// Reglas:
//   • Las tandas se consumen EN ORDEN (por `position`). Los cupos vendidos del tipo de
//     entrada llenan la tanda 0, luego la 1, etc. Al agotarse una, abre la siguiente.
//   • Una tanda con `stockLimit == null` tiene cupos ilimitados: nunca se agota por stock.
//   • Una tanda puede tener ventana de fecha [activeFrom, activeUntil). Si la ventana ya
//     cerró (now >= activeUntil), la tanda termina aunque le queden cupos (los cede).
//     Si todavía no abrió (now < activeFrom) y es la tanda en turno, la venta aún no arrancó.
//
// Este archivo es dependency-free a propósito: vive byte-a-byte idéntico en
// `backend/src/lib/ticket-tiers.ts` y `admin/src/lib/ticket-tiers.ts` (no hay monorepo).
//
// ⚠️  Si editás este archivo, editá la copia en la OTRA app para que quede idéntica.
// ─────────────────────────────────────────────────────────────────────────────

/** Una tanda tal como la necesita el cálculo. Fechas como ISO string o null. */
export interface TicketTier {
  id: string
  name: string
  /** Decimal como string (igual que lo devuelve la DB). */
  price: string
  /** Orden en la escalera (0 = primera). */
  position: number
  /** Cupos de esta tanda; null = ilimitada. */
  stockLimit: number | null
  /** Inicio de la ventana de fecha (ISO) o null = sin límite inferior. */
  activeFrom: string | null
  /** Fin de la ventana de fecha (ISO) o null = sin límite superior. */
  activeUntil: string | null
}

/** Por qué una tanda no es la activa (útil para explicar en la UI). */
export type TierState =
  /** Sus cupos ya se vendieron (la escalera avanzó más allá). */
  | "sold_out"
  /** Su ventana de fecha ya cerró. */
  | "expired"
  /** Su ventana de fecha todavía no abrió. */
  | "scheduled"
  /** Es la tanda que está vendiendo ahora. */
  | "active"

export interface TierEvaluation {
  /** La tanda activa ahora, o null si ninguna (todo vendido o venta no arrancada). */
  active: TicketTier | null
  /** Cuántos cupos le quedan a la tanda activa (null = ilimitada / no hay activa). */
  remainingInActive: number | null
  /** Estado de cada tanda (mismo orden que la entrada ordenada por position). */
  states: { tier: TicketTier; state: TierState }[]
}

function sortByPosition(tiers: TicketTier[]): TicketTier[] {
  return [...tiers].sort((a, b) => a.position - b.position)
}

function windowState(
  tier: TicketTier,
  nowMs: number
): "open" | "expired" | "scheduled" {
  if (tier.activeUntil != null && nowMs >= Date.parse(tier.activeUntil)) {
    return "expired"
  }
  if (tier.activeFrom != null && nowMs < Date.parse(tier.activeFrom)) {
    return "scheduled"
  }
  return "open"
}

/**
 * Evalúa la escalera de tandas de un tipo de entrada.
 *
 * @param tiers  Todas las tandas del tipo de entrada (en cualquier orden).
 * @param sold   Total de entradas emitidas (no canceladas) del tipo de entrada.
 * @param now    Momento de referencia (default: ahora).
 */
export function evaluateTicketTiers(
  tiers: TicketTier[],
  sold: number,
  now: Date = new Date()
): TierEvaluation {
  const ordered = sortByPosition(tiers)
  const nowMs = now.getTime()
  const states: { tier: TicketTier; state: TierState }[] = []

  let active: TicketTier | null = null
  let remainingInActive: number | null = null
  // Cupos acumulados de las tandas ya cerradas por stock (la "base" de la escalera).
  let capBefore = 0
  // Una vez que encontramos la tanda en turno, las siguientes quedan pendientes.
  let foundStockPosition = false

  for (const tier of ordered) {
    const win = windowState(tier, nowMs)

    if (foundStockPosition) {
      // Ya hay una tanda en la posición de stock actual (activa o scheduled): las que
      // siguen no vendieron nada todavía. Se marcan por su ventana de fecha.
      states.push({ tier, state: win === "expired" ? "expired" : "scheduled" })
      continue
    }

    const soldOutByStock =
      tier.stockLimit != null && sold >= capBefore + tier.stockLimit

    if (soldOutByStock) {
      states.push({ tier, state: "sold_out" })
      capBefore += tier.stockLimit as number
      continue
    }

    // Esta es la tanda donde cae la venta actual por stock. Ahora deciden las fechas.
    if (win === "expired") {
      // La tanda venció aunque le quedaban cupos: los cede y la escalera avanza.
      states.push({ tier, state: "expired" })
      capBefore += tier.stockLimit ?? 0
      continue
    }

    foundStockPosition = true
    if (win === "scheduled") {
      // La tanda en turno todavía no abrió por fecha → la venta aún no arrancó.
      states.push({ tier, state: "scheduled" })
      continue
    }

    // Abierta y con cupos: es la activa.
    active = tier
    remainingInActive =
      tier.stockLimit == null
        ? null
        : Math.max(0, capBefore + tier.stockLimit - sold)
    states.push({ tier, state: "active" })
  }

  return { active, remainingInActive, states }
}

/** Atajo: la tanda activa ahora, o null. */
export function activeTicketTier(
  tiers: TicketTier[],
  sold: number,
  now: Date = new Date()
): TicketTier | null {
  return evaluateTicketTiers(tiers, sold, now).active
}
