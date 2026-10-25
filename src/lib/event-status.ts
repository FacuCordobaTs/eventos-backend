/** Valores históricos de DB/API. No gobiernan permisos, visibilidad ni transiciones. */
export const EVENT_STATUSES = ["draft", "on_sale", "live", "closed"] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]
