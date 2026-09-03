import { Hono } from "hono"
import { logger } from "hono/logger"
import { tenantsRoute } from "./routes/tenants"
import { staffRoute } from "./routes/staff"
import { eventsRoute } from "./routes/events"
import { ticketsRoute } from "./routes/tickets"
import { publicRoute } from "./routes/public"
import { inventoryRoute } from "./routes/inventory"
import { analyticsRoute } from "./routes/analytics"
import { barsRoute } from "./routes/bars"
import { salesRoute } from "./routes/sales"
import { promotersRoute } from "./routes/promoters"
import { mountStockWebSocket } from "./routes/ws-stock"
import { mountPublicQrWebSocket } from "./routes/ws-public-qr"
import { startJobsRunner } from "./lib/jobs-runner"
import { mercadopagoRoute } from "./routes/mercadopago"
import { webhookRoute } from "./routes/webhook"
import { cors } from "hono/cors"
import { websocket as honoWebsocket, serveStatic } from "hono/bun"

const app = new Hono()

app.use(logger())

app.use(
  "/*",
  cors({
    origin: [
      "https://crow.ar",
      "https://admin.crow.ar",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      // Tauri no sirve el frontend desde admin.crow.ar: en Windows WebView2 usa
      // https://tauri.localhost y en otros runtimes tauri://localhost.
      "https://tauri.localhost",
      "tauri://localhost",
    ],  
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
)

// Archivos estáticos del updater de Tauri (manifiesto + instaladores).
// Sirve backend/public/updates/ en https://api.crow.ar/public/updates/*
// Va antes de la ruta /public para que capture /public/updates/* primero;
// si el archivo no existe hace next() y cae en publicRoute.
app.use("/public/updates/*", serveStatic({ root: "./" }))

app.route("/tenants", tenantsRoute)
app.route("/staff", staffRoute)
app.route("/events", eventsRoute)
app.route("/tickets", ticketsRoute)
app.route("/public", publicRoute)
app.route("/inventory", inventoryRoute)
app.route("/analytics", analyticsRoute)
app.route("/bars", barsRoute)
app.route("/sales", salesRoute)
app.route("/promoters", promotersRoute)
app.route("/api/mp", mercadopagoRoute)
app.route("/api/webhook", webhookRoute)
mountStockWebSocket(app)
mountPublicQrWebSocket(app)

// Tarea 8.2 — Runner de jobs de fondo (visión §2.3): recordatorio de WhatsApp 1 h antes y
// transición on_sale → live a la hora de puertas. Tick inmediato + cada minuto. El estado
// vive en DB (idempotente por columna), ver src/lib/jobs-runner.ts.
startJobsRunner()

const port = Number(process.env.PORT ?? 3000)

/** Larger than multipart event images (5 MB cap + boundary overhead); avoids Bun 413 before Hono/CORS runs. */
const maxRequestBodySize = 9 * 1024 * 1024

export default {
  port,
  maxRequestBodySize,
  fetch: (req: Request, server: Bun.Server) => app.fetch(req, { server }),
  websocket: honoWebsocket,
}
