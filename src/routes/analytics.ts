import { Hono } from "hono"
import { drizzle } from "drizzle-orm/mysql2"
import { and, asc, count, desc, eq, gte, ne, sql } from "drizzle-orm"
import { pool } from "../db"
import {
  eventInventory,
  events,
  inventoryItems,
  sales,
  ticketTypes,
  tickets,
} from "../db/schema"
import { authMiddleware, type AuthenticatedContext } from "../middleware/auth"
import { dec, decFromDb, decToDb } from "../lib/decimal-money"

function requireTenantId(ctx: AuthenticatedContext): string | null {
  const id = ctx.staff.tenantId
  if (id == null || id === "") return null
  return id
}

function alertThreshold() {
  return dec(process.env.INVENTORY_ALERT_THRESHOLD ?? "100")
}

function deriveEventStatus(ev: {
  date: Date
  isActive: boolean | null
}): "active" | "draft" | "finished" {
  if (ev.isActive === false) return "draft"
  const d = new Date(ev.date)
  if (Number.isNaN(d.getTime())) return "active"
  return d.getTime() < Date.now() ? "finished" : "active"
}

export const analyticsRoute = new Hono()
  .use("*", authMiddleware)
  .get("/dashboard", async (c) => {
    const ctx = c as AuthenticatedContext
    const tenantId = requireTenantId(ctx)
    if (!tenantId) {
      return c.json(
        { error: "Tu cuenta no tiene tenant asignado." },
        400
      )
    }

    const db = drizzle(pool)
    const now = new Date()

    const [upcoming] = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          eq(events.isActive, true),
          gte(events.date, now)
        )
      )
      .orderBy(asc(events.date))
      .limit(1)

    let focusEvent = upcoming
    if (!focusEvent) {
      const [latest] = await db
        .select()
        .from(events)
        .where(eq(events.tenantId, tenantId))
        .orderBy(desc(events.date))
        .limit(1)
      focusEvent = latest
    }

    const [ticketRevRow] = await db
      .select({
        total: sql<string>`COALESCE(SUM(CAST(${ticketTypes.price} AS DECIMAL(14,2))), 0)`,
      })
      .from(tickets)
      .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
      .where(
        and(eq(tickets.tenantId, tenantId), ne(tickets.status, "CANCELLED"))
      )

    const [productRevRow] = await db
      .select({
        total: sql<string>`COALESCE(SUM(CAST(${sales.totalAmount} AS DECIMAL(14,2))), 0)`,
      })
      .from(sales)
      .where(
        and(eq(sales.tenantId, tenantId), eq(sales.status, "COMPLETED"))
      )

    const totalRevenue = decFromDb(ticketRevRow?.total).plus(
      decFromDb(productRevRow?.total)
    )

    const [ticketCountRow] = await db
      .select({ n: count() })
      .from(tickets)
      .where(
        and(eq(tickets.tenantId, tenantId), ne(tickets.status, "CANCELLED"))
      )

    const [usedCountRow] = await db
      .select({ n: count() })
      .from(tickets)
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.status, "USED")))

    const th = alertThreshold()
    let stockAlerts: {
      id: string
      name: string
      unit: (typeof inventoryItems.$inferSelect)["unit"]
      currentStock: string
      threshold: string
    }[] = []

    if (focusEvent) {
      const invRows = await db
        .select({
          id: inventoryItems.id,
          name: inventoryItems.name,
          unit: inventoryItems.unit,
          stockAllocated: eventInventory.stockAllocated,
        })
        .from(eventInventory)
        .innerJoin(
          inventoryItems,
          eq(eventInventory.inventoryItemId, inventoryItems.id)
        )
        .where(
          and(
            eq(eventInventory.eventId, focusEvent.id),
            eq(eventInventory.tenantId, tenantId),
            eq(inventoryItems.tenantId, tenantId)
          )
        )

      stockAlerts = invRows
        .filter((r) => decFromDb(r.stockAllocated).lt(th))
        .map((r) => ({
          id: r.id,
          name: r.name,
          unit: r.unit,
          currentStock: String(r.stockAllocated),
          threshold: decToDb(th),
        }))
    }

    const hourTotals = Array.from({ length: 24 }, () => dec(0))

    if (focusEvent) {
      const saleRows = await db
        .select({
          createdAt: sales.createdAt,
          totalAmount: sales.totalAmount,
        })
        .from(sales)
        .where(
          and(
            eq(sales.tenantId, tenantId),
            eq(sales.eventId, focusEvent.id),
            eq(sales.status, "COMPLETED")
          )
        )

      for (const r of saleRows) {
        const d = r.createdAt ? new Date(r.createdAt) : null
        if (!d || Number.isNaN(d.getTime())) continue
        const h = d.getHours()
        hourTotals[h] = hourTotals[h]!.plus(decFromDb(r.totalAmount))
      }
    }

    const salesByHour = hourTotals.map((total, hour) => ({
      hour,
      label: `${String(hour).padStart(2, "0")}:00`,
      revenue: Number(total.toFixed(2)),
    }))

    const sparklineFromHourly = salesByHour.map((x) => x.revenue)

    const eventRows = await db
      .select()
      .from(events)
      .where(eq(events.tenantId, tenantId))
      .orderBy(desc(events.date))
      .limit(40)

    const eventPerformance = []
    for (const ev of eventRows) {
      const [tRev] = await db
        .select({
          total: sql<string>`COALESCE(SUM(CAST(${ticketTypes.price} AS DECIMAL(14,2))), 0)`,
        })
        .from(tickets)
        .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
        .where(
          and(
            eq(tickets.eventId, ev.id),
            eq(tickets.tenantId, tenantId),
            ne(tickets.status, "CANCELLED")
          )
        )

      const [pRev] = await db
        .select({
          total: sql<string>`COALESCE(SUM(CAST(${sales.totalAmount} AS DECIMAL(14,2))), 0)`,
        })
        .from(sales)
        .where(
          and(
            eq(sales.eventId, ev.id),
            eq(sales.tenantId, tenantId),
            eq(sales.status, "COMPLETED")
          )
        )

      const [soldRow] = await db
        .select({ n: count() })
        .from(tickets)
        .where(
          and(
            eq(tickets.eventId, ev.id),
            eq(tickets.tenantId, tenantId),
            ne(tickets.status, "CANCELLED")
          )
        )

      const types = await db
        .select({ stockLimit: ticketTypes.stockLimit })
        .from(ticketTypes)
        .where(
          and(eq(ticketTypes.eventId, ev.id), eq(ticketTypes.tenantId, tenantId))
        )

      let ticketsCapacity: number | null = null
      if (types.length > 0 && types.every((t) => t.stockLimit != null)) {
        ticketsCapacity = types.reduce((s, t) => s + (t.stockLimit ?? 0), 0)
      }

      const ticketRev = decFromDb(tRev?.total)
      const productRev = decFromDb(pRev?.total)
      const totalEv = ticketRev.plus(productRev)
      const sold = Number(soldRow?.n ?? 0)
      const progressPct =
        ticketsCapacity != null && ticketsCapacity > 0
          ? Math.min(100, Math.round((sold / ticketsCapacity) * 100))
          : 0

      eventPerformance.push({
        eventId: ev.id,
        name: ev.name,
        date: ev.date,
        status: deriveEventStatus(ev),
        ticketRevenue: decToDb(ticketRev),
        productRevenue: decToDb(productRev),
        totalRevenue: decToDb(totalEv),
        ticketsSold: sold,
        ticketsCapacity,
        salesProgress: progressPct,
      })
    }

    return c.json({
      kpis: {
        totalRevenue: decToDb(totalRevenue),
        totalTicketsSold: Number(ticketCountRow?.n ?? 0),
        usedTickets: Number(usedCountRow?.n ?? 0),
        stockAlertsCount: stockAlerts.length,
      },
      focusEvent: focusEvent
        ? { id: focusEvent.id, name: focusEvent.name, date: focusEvent.date }
        : null,
      salesByHour,
      salesChartSparkline: sparklineFromHourly,
      stockAlerts,
      eventPerformance,
    })
  })
