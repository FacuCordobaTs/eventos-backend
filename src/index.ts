import { Hono } from "hono"
import { logger } from "hono/logger"
import { tenantsRoute } from "./routes/tenants"
import { staffRoute } from "./routes/staff"
import { eventsRoute } from "./routes/events"
import { ticketsRoute } from "./routes/tickets"
import { publicRoute } from "./routes/public"
import { authClientRoute } from "./routes/auth-client"
import { meRoute } from "./routes/me"
import { inventoryRoute } from "./routes/inventory"
import { analyticsRoute } from "./routes/analytics"
import { barsRoute } from "./routes/bars"
import { salesRoute } from "./routes/sales"
import { mountStockWebSocket } from "./routes/ws-stock"
import { cors } from "hono/cors"
import { websocket as honoWebsocket } from "hono/bun"

const app = new Hono()

app.use(logger())

app.use(
  "/*",
  cors({
    origin: [
      "https://totem.uno",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "https://totem-admin-9hw.pages.dev",
    ],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
)

app.route("/tenants", tenantsRoute)
app.route("/staff", staffRoute)
app.route("/events", eventsRoute)
app.route("/tickets", ticketsRoute)
app.route("/public", publicRoute)
app.route("/client/auth", authClientRoute)
app.route("/me", meRoute)
app.route("/inventory", inventoryRoute)
app.route("/analytics", analyticsRoute)
app.route("/bars", barsRoute)
app.route("/sales", salesRoute)

mountStockWebSocket(app)

const port = Number(process.env.PORT ?? 3000)

export default {
  port,
  fetch: (req: Request, server: Bun.Server) => app.fetch(req, { server }),
  websocket: honoWebsocket,
}
