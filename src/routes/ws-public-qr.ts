import type { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"
import type { WSContext } from "hono/ws"
import {
  subscribePickupUpdates,
  subscribeReceiptUpdates,
} from "../lib/public-qr-broadcast"

/**
 * Receipt and pickup tokens are unguessable public capabilities, like the GET endpoints that
 * render their QR. The socket only streams a change notification; the client then refetches
 * the resource, which remains the source of truth.
 */
export function mountPublicQrWebSocket(app: Hono) {
  app.get(
    "/ws/public/receipts/:token",
    upgradeWebSocket(async (c) => {
      const token = c.req.param("token") ?? ""

      let unsubscribe: (() => void) | null = null
      return {
        onOpen(_event: Event, ws: WSContext) {
          unsubscribe = subscribeReceiptUpdates(token, (message) => ws.send(message))
        },
        onClose() {
          unsubscribe?.()
          unsubscribe = null
        },
      }
    })
  )

  app.get(
    "/ws/public/pickups/:token",
    upgradeWebSocket(async (c) => {
      const token = c.req.param("token") ?? ""

      let unsubscribe: (() => void) | null = null
      return {
        onOpen(_event: Event, ws: WSContext) {
          unsubscribe = subscribePickupUpdates(token, (message) => ws.send(message))
        },
        onClose() {
          unsubscribe?.()
          unsubscribe = null
        },
      }
    })
  )
}
