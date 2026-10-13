import { and, count, eq, gte, lt, sql } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import { bars, eventExpenses, sales } from "../db/schema"
import { dec, decFromDb, decToDb } from "./decimal-money"

/** Inclusive calendar dates in Argentina; the SQL upper bound is exclusive. */
export function cashPeriod(from: string, to: string) {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Elegí fechas válidas.")
    const day = new Date(`${value}T00:00:00Z`)
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
      throw new Error("Elegí fechas válidas.")
    }
    return new Date(`${value}T00:00:00-03:00`)
  }
  const start = parse(from)
  const end = new Date(parse(to).getTime() + 86_400_000)
  if (start >= end) throw new Error("La fecha hasta debe ser igual o posterior a desde.")
  return { from, to, start, end, timezone: "America/Argentina/Buenos_Aires" }
}

type CashRow = { barId: string | null; paymentMethod: string; amount: string; salesCount: number }

export function summarizeCashPeriod(rows: CashRow[], barNames: { id: string; name: string }[], expenses: string) {
  const names = new Map(barNames.map((bar) => [bar.id, bar.name]))
  const methods = ["CASH", "CARD", "MERCADOPAGO", "TRANSFER", "SALDO"]
  const amountFor = (subset: CashRow[], method: string) =>
    decToDb(subset.filter((row) => row.paymentMethod === method)
      .reduce((total, row) => total.plus(decFromDb(row.amount)), dec(0)))
  const collected = (subset: CashRow[]) => decToDb(subset
    .filter((row) => row.paymentMethod !== "SALDO")
    .reduce((total, row) => total.plus(decFromDb(row.amount)), dec(0)))
  const byMethod = methods.map((method) => ({ method, amount: amountFor(rows, method) }))
  const byBar = [...new Set(rows.map((row) => row.barId))].map((barId) => {
    const subset = rows.filter((row) => row.barId === barId)
    return {
      barId,
      barName: barId ? names.get(barId) ?? "Puesto" : "Puerta / online",
      collected: collected(subset),
      cashExpected: amountFor(subset, "CASH"),
      salesCount: subset.reduce((n, row) => n + Number(row.salesCount), 0),
      byMethod: methods.map((method) => ({ method, amount: amountFor(subset, method) })),
    }
  }).sort((a, b) => a.barName.localeCompare(b.barName))
  return {
    collected: collected(rows),
    cashExpected: amountFor(rows, "CASH"),
    balanceSpent: amountFor(rows, "SALDO"),
    expenses: decToDb(decFromDb(expenses)),
    afterExpenses: decToDb(dec(collected(rows)).minus(decFromDb(expenses))),
    salesCount: rows.reduce((n, row) => n + Number(row.salesCount), 0),
    byMethod,
    byBar,
  }
}

export async function computeEventCashPeriod(
  db: MySql2Database<Record<string, never>>, tenantId: string, eventId: string, period: ReturnType<typeof cashPeriod>,
) {
  // POS keeps the sale's original date (including offline sync); online payments belong
  // to the day money was received, with createdAt as fallback for legacy sales.
  const at = sql<Date>`case when ${sales.source} = 'POS' then ${sales.createdAt} else coalesce(${sales.paidAt}, ${sales.createdAt}) end`
  const [rows, barNames, expenseRows] = await Promise.all([
    db.select({ barId: sales.barId, paymentMethod: sales.paymentMethod,
      amount: sql<string>`coalesce(sum(${sales.totalAmount}), 0)`, salesCount: count() })
      .from(sales).where(and(eq(sales.tenantId, tenantId), eq(sales.eventId, eventId),
        eq(sales.status, "COMPLETED"), gte(at, period.start), lt(at, period.end)))
      .groupBy(sales.barId, sales.paymentMethod),
    db.select({ id: bars.id, name: bars.name }).from(bars)
      .where(and(eq(bars.tenantId, tenantId), eq(bars.eventId, eventId))),
    db.select({ amount: sql<string>`coalesce(sum(${eventExpenses.amount}), 0)` }).from(eventExpenses)
      .where(and(eq(eventExpenses.tenantId, tenantId), eq(eventExpenses.eventId, eventId),
        gte(eventExpenses.date, period.start), lt(eventExpenses.date, period.end))),
  ])
  return {
    period: { from: period.from, to: period.to, timezone: period.timezone },
    generatedAt: new Date().toISOString(),
    ...summarizeCashPeriod(rows, barNames, expenseRows[0]?.amount ?? "0"),
  }
}
