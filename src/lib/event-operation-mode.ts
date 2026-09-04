import type { events } from "../db/schema"

export type EventOperationMode = NonNullable<
  (typeof events.$inferSelect)["operationMode"]
>

export function eventSupportsConsumptions(mode: EventOperationMode): boolean {
  return mode !== "TICKETS_ONLY"
}

export function eventTracksStock(mode: EventOperationMode): boolean {
  return mode === "FULL_OPERATION"
}
