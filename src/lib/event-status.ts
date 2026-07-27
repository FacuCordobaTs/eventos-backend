// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL EVENT STATE MACHINE — single source of truth for both apps.
//
// This file is intentionally dependency-free (pure TypeScript) so it can live
// byte-for-byte identical in `backend/src/lib/event-status.ts` and
// `admin/src/lib/event-status.ts`. There is no monorepo linking the two apps
// (separate git repos + separate deploys), so the module is mirrored, not shared.
//
// ⚠️  If you edit this file, edit the copy in the OTHER app to match exactly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four lives of an event. The event's status governs its whole interface
 * (spec §0): Borrador → En venta → En vivo → Cerrado.
 */
export const EVENT_STATUSES = ["draft", "on_sale", "live", "closed"] as const

export type EventStatus = (typeof EVENT_STATUSES)[number]

/** Human labels (es) as shown in the header and everywhere the state is a word. */
export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  draft: "Borrador",
  on_sale: "En venta",
  live: "En vivo",
  closed: "Cerrado",
}

export function eventStatusLabel(status: EventStatus): string {
  return EVENT_STATUS_LABELS[status] ?? status
}

export function isEventStatus(value: unknown): value is EventStatus {
  return (
    typeof value === "string" &&
    (EVENT_STATUSES as readonly string[]).includes(value)
  )
}

/** How the transition is triggered. */
export type TransitionTrigger =
  /** The productor deliberately pushes it (primary action in the header). */
  | "manual"
  /** The system advances it on its own (e.g. door time), with a manual override. */
  | "automatic"

export interface EventStatusTransition {
  from: EventStatus
  to: EventStatus
  /** Verb shown on the primary action button / override when available. */
  action: string
  trigger: TransitionTrigger
}

/**
 * The state graph is a straight line — each status has exactly one successor.
 * The productor only ever pushes two transitions (Abrir venta, Cerrar el evento);
 * En vivo starts on its own at door time, with an "Arrancar ahora" override.
 */
export const EVENT_STATUS_TRANSITIONS: readonly EventStatusTransition[] = [
  { from: "draft", to: "on_sale", action: "Abrir venta", trigger: "manual" },
  { from: "on_sale", to: "live", action: "Arrancar ahora", trigger: "automatic" },
  { from: "live", to: "closed", action: "Cerrar el evento", trigger: "manual" },
]

/** Position in the lifecycle (draft=0 … closed=3). Useful for ordering/gating. */
export function eventStatusRank(status: EventStatus): number {
  return EVENT_STATUSES.indexOf(status)
}

/** True if `status` is at or past `min` in the lifecycle. */
export function eventStatusAtLeast(
  status: EventStatus,
  min: EventStatus
): boolean {
  return eventStatusRank(status) >= eventStatusRank(min)
}

/** The single outgoing transition from a status, if any (closed has none). */
export function outgoingTransition(
  from: EventStatus
): EventStatusTransition | undefined {
  return EVENT_STATUS_TRANSITIONS.find((t) => t.from === from)
}

/** The transition metadata between two states, if the edge exists. */
export function transitionBetween(
  from: EventStatus,
  to: EventStatus
): EventStatusTransition | undefined {
  return EVENT_STATUS_TRANSITIONS.find((t) => t.from === from && t.to === to)
}

/** Whether moving `from → to` is a legal step in the lifecycle. */
export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return transitionBetween(from, to) !== undefined
}

/**
 * Backend guard: throw if a transition is illegal. Returns the transition so the
 * caller can read its metadata. Use before persisting a status change.
 */
export function assertTransition(
  from: EventStatus,
  to: EventStatus
): EventStatusTransition {
  const transition = transitionBetween(from, to)
  if (!transition) {
    throw new Error(
      `Transición de estado inválida: ${from} → ${to}. ` +
        `Desde "${from}" solo se permite ${
          outgoingTransition(from)?.to ?? "ninguna (evento cerrado)"
        }.`
    )
  }
  return transition
}
