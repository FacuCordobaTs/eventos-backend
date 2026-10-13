import { describe, expect, test } from "bun:test"
import { cashPeriod, computeEventCashPeriod, summarizeCashPeriod } from "./event-cash-period"
import { drizzle } from "drizzle-orm/mysql2"

describe("caja por fechas", () => {
  test("viernes y sábado completos en Argentina, sin incluir el domingo", () => {
    const period = cashPeriod("2026-10-09", "2026-10-10")
    expect(period.start.toISOString()).toBe("2026-10-09T03:00:00.000Z")
    expect(period.end.toISOString()).toBe("2026-10-11T03:00:00.000Z")
  })
  test("un solo día y cruces de mes o año", () => {
    expect(cashPeriod("2026-12-31", "2026-12-31").end.toISOString()).toBe("2027-01-01T03:00:00.000Z")
    expect(cashPeriod("2028-02-29", "2028-02-29").end.toISOString()).toBe("2028-03-01T03:00:00.000Z")
  })
  test.each([["2026-02-29", "2026-03-01"], ["2026-10-11", "2026-10-10"], ["", ""], ["2026-13-01", "2026-13-02"], ["2026-2-1", "2026-02-02"]])(
    "rechaza fechas inválidas %s / %s", (from: string, to: string) => expect(() => cashPeriod(from, to)).toThrow(),
  )
  test("saldo no duplica caja; mantiene precisión y separa puestos", () => {
    const report = summarizeCashPeriod([
      { barId: "bar-1", paymentMethod: "CASH", amount: "0.10", salesCount: 1 },
      { barId: "bar-1", paymentMethod: "CARD", amount: "0.20", salesCount: 1 },
      { barId: "bar-1", paymentMethod: "SALDO", amount: "1500.00", salesCount: 3 },
      { barId: null, paymentMethod: "CASH", amount: "1000.00", salesCount: 1 },
    ], [{ id: "bar-1", name: "Barra" }], "500.15")
    expect(report.collected).toBe("1000.30")
    expect(report.cashExpected).toBe("1000.10")
    expect(report.balanceSpent).toBe("1500.00")
    expect(report.afterExpenses).toBe("500.15")
    expect(report.salesCount).toBe(6)
    expect(report.byBar.find((bar) => bar.barId === "bar-1")?.cashExpected).toBe("0.10")
    expect(report.byBar.find((bar) => bar.barId === null)?.collected).toBe("1000.00")
  })
  test("sin ventas conserva los gastos del período", () => {
    const report = summarizeCashPeriod([], [], "200.00")
    expect(report.byBar).toEqual([])
    expect(report.collected).toBe("0.00")
    expect(report.afterExpenses).toBe("-200.00")
  })
  test("SQL filtra tenant, evento, estado y límites; usa fecha de cobro online y fecha original POS", async () => {
    const queries: { sql: string; values: unknown[] }[] = []
    const connection = {
      query: async (query: { sql: string }, values: unknown[]) => {
        queries.push({ sql: query.sql, values })
        return [[], []]
      },
    }
    await computeEventCashPeriod(drizzle(connection as never), "tenant-a", "event-a", cashPeriod("2026-10-09", "2026-10-10"))
    expect(queries).toHaveLength(3)
    for (const query of queries) {
      expect(query.values).toContain("tenant-a")
      expect(query.values).toContain("event-a")
      expect(query.sql).toStartWith("select ")
    }
    const sale = queries.find((query) => query.sql.includes("from `sales`"))!
    expect(sale.values).toContain("COMPLETED")
    const dates = sale.values.filter((value): value is Date => value instanceof Date).map((value) => value.toISOString())
    expect(dates).toContain("2026-10-09T03:00:00.000Z")
    expect(dates).toContain("2026-10-11T03:00:00.000Z")
    expect(sale.sql).toContain("coalesce(`sales`.`paid_at`, `sales`.`created_at`)")
    expect(sale.sql).toContain("= 'POS' then `sales`.`created_at`")
    expect(sale.sql).toContain(" >= ")
    expect(sale.sql).toContain(" < ")
    const expense = queries.find((query) => query.sql.includes("from `event_expenses`"))!
    expect(expense.sql).toContain("`event_expenses`.`date` >= ")
  })
})
