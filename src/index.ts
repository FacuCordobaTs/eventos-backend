import { Hono } from "hono"
import { logger } from "hono/logger"
import { tenantsRoute } from "./routes/tenants"
import { staffRoute } from "./routes/staff"
import { eventsRoute } from "./routes/events"
import { ticketsRoute } from "./routes/tickets"
import { publicRoute } from "./routes/public"
import { cors } from "hono/cors"

const app = new Hono()

app.use(logger())

app.use(
  "/*",
  cors({
    origin: ["https://totem.uno", "http://localhost:5173", "https://totem-admin-9hw.pages.dev"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
)

app.route("/tenants", tenantsRoute)
app.route("/staff", staffRoute)
app.route("/events", eventsRoute)
app.route("/tickets", ticketsRoute)
app.route("/public", publicRoute)

const port = Number(process.env.PORT ?? 3000)

export default {
  port,
  fetch: app.fetch,
}
