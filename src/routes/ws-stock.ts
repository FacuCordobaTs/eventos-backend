import type { Hono } from "hono"
import { upgradeWebSocket } from "hono/bun"
import type { WSContext } from "hono/ws"
import { drizzle } from "drizzle-orm/mysql2"
import { and, eq } from "drizzle-orm"
import { pool } from "../db"
import { events, staff } from "../db/schema"
import { verifyToken } from "../lib/jwt"
import {
  makeStockRoomKey,
  stockRoomSubscribe,
} from "../lib/event-stock-broadcast"

export function mountStockWebSocket(app: Hono) {
  app.get(
    "/ws/event/:eventId/stock",
    upgradeWebSocket(async (c) => {
      const eventId = c.req.param("eventId")
      const token = c.req.query("token") ?? ""

      let roomKey: string | null = null
      let unsubscribe: (() => void) | null = null

      try {
        const payload = await verifyToken(token)
        if (payload.aud !== "staff") {
          throw new Error("not staff")
        }
        const db = drizzle(pool)
        const [st] = await db
          .select({ tenantId: staff.tenantId })
          .from(staff)
          .where(eq(staff.id, payload.sub))
          .limit(1)
        const tenantId = st?.tenantId
        if (!tenantId) {
          throw new Error("no tenant")
        }
        const [ev] = await db
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
          .limit(1)
        if (!ev) {
          throw new Error("bad event")
        }
        roomKey = makeStockRoomKey(tenantId, eventId)
      } catch {
        roomKey = null
      }

      if (!roomKey) {
        return {
          onOpen(_evt: Event, ws: WSContext) {
            ws.close(4401, "Unauthorized")
          },
        }
      }

      return {
        onOpen(_evt: Event, ws: WSContext) {
          unsubscribe = stockRoomSubscribe(roomKey!, (msg) => {
            try {
              ws.send(msg)
            } catch {
              /* closed */
            }
          })
        },
        onClose() {
          unsubscribe?.()
          unsubscribe = null
        },
      }
    })
  )
}
