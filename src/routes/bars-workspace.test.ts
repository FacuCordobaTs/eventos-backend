import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getTableName, type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { Context, Next } from "hono";
import {
  digitalConsumptions as consumptionTable,
  sales as saleTable,
} from "../db/schema";

// Endpoints reales, sin credenciales ni DB. Se evalúan los filtros SQL sencillos del flujo
// (tenant, evento, producto, activo) y se registran las escrituras de la transacción.
type Row = Record<string, any>;
const dialect = new MySqlDialect();
let tables: Record<string, Row[]>;
let staff: Row;
let writes: { table: string; values: Row }[];
let queries: { table: string; sql: string; params: unknown[] }[];
const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function matching(table: string, row: Row, condition?: SQL): boolean {
  if (!condition) return true;
  const query = dialect.sqlToQuery(condition);
  // Los joins se proyectan abajo; acá sólo se filtran columnas de la tabla fuente.
  const pattern = /`([^`]+)`\.`([^`]+)` (= \?|<> \?|in \([^)]*\))/g;
  for (const match of query.sql.matchAll(pattern)) {
    if (match[1] !== table) continue;
    const firstParam = (query.sql.slice(0, match.index).match(/\?/g) ?? [])
      .length;
    const count = (match[3].match(/\?/g) ?? []).length;
    const allowed = query.params.slice(firstParam, firstParam + count);
    const value = row[camel(match[2])];
    if (match[3].startsWith("<>") && !allowed.includes(value)) continue;
    if (match[3].startsWith("<>")) return false;
    if (
      !allowed.some(
        (param) =>
          param === value ||
          (typeof value === "boolean" && Number(value) === param),
      )
    )
      return false;
  }
  return true;
}

function fakeDb() {
  const db = {
    select: (fields?: Row) => {
      let table = "";
      let condition: SQL | undefined;
      const chain: Row = {};
      chain.from = (source: never) => {
        table = getTableName(source);
        return chain;
      };
      chain.where = (sql: SQL) => {
        condition = sql;
        return chain;
      };
      for (const method of [
        "innerJoin",
        "leftJoin",
        "orderBy",
        "limit",
        "for",
        "groupBy",
      ])
        chain[method] = () => chain;
      chain.then = (
        resolve: (rows: Row[]) => unknown,
        reject: (e: unknown) => unknown,
      ) => {
        const query = condition
          ? dialect.sqlToQuery(condition)
          : { sql: "", params: [] };
        queries.push({ table, ...query });
        const rows = (tables[table] ?? []).filter((row) =>
          matching(table, row, condition),
        );
        const projected = rows.map((row) => {
          if (!fields) return { ...row };
          const result: Row = {};
          for (const [alias, field] of Object.entries(fields)) {
            if (field === consumptionTable) {
              result[alias] = { ...row };
              continue;
            }
            if (field === saleTable) {
              result[alias] = tables.sales.find(
                (sale) => sale.id === row.saleId,
              );
              continue;
            }
            if (alias === "n") {
              result[alias] = String(rows.length);
              continue;
            }
            if (field?.name && field?.table) {
              const fieldTable = getTableName(field.table);
              const source =
                fieldTable === table
                  ? row
                  : (tables[fieldTable] ?? []).find((joined) =>
                      fieldTable === "event_products"
                        ? joined.productId === row.id
                        : fieldTable === "bar_products"
                          ? joined.productId === row.id
                          : fieldTable === "product_categories"
                            ? joined.id === row.categoryId
                            : fieldTable === "inventory_items"
                              ? joined.id === row.inventoryItemId
                              : fieldTable === "sales"
                                ? joined.id === row.saleId
                                : fieldTable === "bars"
                                  ? joined.id === row.barId
                                  : false,
                    );
              result[alias] = source?.[camel(field.name)] ?? null;
            } else if (alias === "m")
              result[alias] = Math.max(
                0,
                ...rows.map((r) => Number(r.sortOrder)),
              );
            else if (alias === "price") {
              const sql = dialect.sqlToQuery(field).sql;
              expect(sql).toContain("coalesce");
              result[alias] =
                tables.event_products.find((p) => p.productId === row.id)
                  ?.priceOverride ?? row.price;
            }
          }
          return result;
        });
        return Promise.resolve(projected).then(resolve, reject);
      };
      return chain;
    },
    insert: (source: never) => ({
      values: async (values: Row | Row[]) => {
        const table = getTableName(source);
        for (const row of Array.isArray(values) ? values : [values]) {
          writes.push({ table, values: row });
          (tables[table] ??= []).push({ ...row });
        }
      },
    }),
    update: (source: never) => ({
      set: (values: Row) => ({
        where: async (condition: SQL) => {
          const table = getTableName(source);
          writes.push({ table, values });
          for (const row of tables[table] ?? [])
            if (matching(table, row, condition)) Object.assign(row, values);
        },
      }),
    }),
    delete: (source: never) => ({
      where: async (condition: SQL) => {
        const table = getTableName(source);
        tables[table] = (tables[table] ?? []).filter(
          (r) => !matching(table, r, condition),
        );
      },
    }),
    transaction: async (run: (tx: any) => unknown): Promise<any> => {
      const snapshot = structuredClone(tables);
      const count = writes.length;
      try {
        return await run(db);
      } catch (e) {
        tables = snapshot;
        writes.length = count;
        throw e;
      }
    },
  };
  return db;
}

mock.module("../db", () => ({ pool: {} }));
mock.module("drizzle-orm/mysql2", () => ({ drizzle: fakeDb }));
mock.module("../middleware/auth", () => ({
  authMiddleware: async (c: Context, next: Next) => {
    Object.assign(c, { staff });
    await next();
  },
}));
mock.module("../lib/event-stock-broadcast", () => ({
  emitCommittedStockDeltas: async () => {},
}));
mock.module("../lib/public-qr-broadcast", () => ({
  broadcastReceiptUpdate: () => {},
  broadcastPickupUpdate: () => {},
}));
// @ts-expect-error Isolated route instance under Bun.
const { barsRoute } = await import("./bars?workspace");
// @ts-expect-error Isolated route instance under Bun.
const { inventoryRoute } = await import("./inventory?workspace");
const inventoryRequest = (path: string, method: string, body?: unknown) =>
  inventoryRoute.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const request = (path: string, method: string, body?: unknown) =>
  barsRoute.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const count = (quantity = "12", expectedCurrentStock = "0", extras: Row = {}) =>
  request("/bar-1/stock", "PUT", {
    inventoryItemId: "rum",
    quantity,
    expectedCurrentStock,
    stockInputAs: "PACKAGES",
    ...extras,
  });

beforeEach(() => {
  staff = { id: "staff-1", tenantId: "tenant-1", role: "ADMIN" };
  writes = [];
  queries = [];
  tables = {
    events: [
      { id: "event-1", tenantId: "tenant-1", operationMode: "FULL_OPERATION" },
    ],
    bars: [{ id: "bar-1", tenantId: "tenant-1", eventId: "event-1" }],
    inventory_items: [
      {
        id: "rum",
        tenantId: "tenant-1",
        name: "Ron",
        baseUnit: "UNIT",
        packageSize: "1.00",
        countingUnit: "unidades",
        isActive: true,
      },
    ],
    products: [
      {
        id: "drink",
        tenantId: "tenant-1",
        name: "Cuba libre",
        price: "15.10",
        saleType: "GLASS",
        isActive: true,
      },
    ],
    product_recipes: [
      {
        id: "recipe-1",
        productId: "drink",
        inventoryItemId: "rum",
        // Trago: 10 ventas terminan una botella.
        quantityUsed: "0.100000",
        yieldPerPackage: "10.000",
      },
    ],
    event_products: [],
    bar_products: [],
    bar_inventory: [],
    event_inventory: [],
    purchases: [],
    event_expenses: [],
    sales: [],
    sale_items: [],
    digital_consumptions: [],
  };
});

describe("Barra: menú y stock directo", () => {
  test("habilita un producto desde la barra sin una activación previa del evento", async () => {
    const res = await request("/bar-1/products/toggle", "POST", {
      productId: "drink",
      isActive: true,
    });
    expect(res.status).toBe(200);
    expect(tables.event_products[0]).toMatchObject({
      tenantId: "tenant-1",
      eventId: "event-1",
      productId: "drink",
      isActive: true,
    });
    expect(tables.bar_products[0]).toMatchObject({
      tenantId: "tenant-1",
      barId: "bar-1",
      productId: "drink",
      isActive: true,
    });
    await request("/bar-1/products/toggle", "POST", {
      productId: "drink",
      isActive: true,
    });
    expect(tables.bar_products).toHaveLength(1);
    expect(tables.event_products).toHaveLength(1);
  });
  for (const role of [
    "BARTENDER",
    "SECURITY",
    "PROMOTER",
    "GENERAL_PROMOTER",
  ]) {
    test(`${role} no modifica menú ni existencias`, async () => {
      staff.role = role;
      expect((await count()).status).toBe(403);
      expect(
        (
          await request("/bar-1/products/toggle", "POST", {
            productId: "drink",
            isActive: true,
          })
        ).status,
      ).toBe(403);
      expect(writes).toHaveLength(0);
    });
  }
  test("carga 12 unidades y crea ambas filas en una transacción", async () => {
    expect((await count()).status).toBe(200);
    expect(tables.bar_inventory[0].currentStock).toBe("12.000000");
    expect(tables.event_inventory[0].stockAllocated).toBe("12.000000");
  });
  test("el catálogo de caja expresa las botellas que consume cada venta", async () => {
    tables.products[0].saleType = "BOTTLE";
    tables.product_recipes[0].quantityUsed = "1";
    tables.event_products.push({
      id: "ep",
      eventId: "event-1",
      tenantId: "tenant-1",
      productId: "drink",
      isActive: true,
    });
    const response = await request("/bar-1/products?eventId=event-1", "GET");
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as Row).products[0].recipes[0].quantityUsed,
    ).toBe("1");
  });
  test("un reintento del mismo conteo no duplica existencias ni gastos", async () => {
    expect((await count("12", "0", { totalCost: "120.35" })).status).toBe(200);
    const countWrites = writes.length;
    expect((await count("12", "0", { totalCost: "120.35" })).status).toBe(200);
    expect(writes).toHaveLength(countWrites);
    expect(tables.purchases).toHaveLength(1);
    expect(tables.purchases[0]).toMatchObject({
      quantity: "12.00",
      totalCost: "120.35",
      countingUnit: "unidades",
    });
    expect(tables.event_expenses[0]).toMatchObject({
      purchaseId: tables.purchases[0].id,
      amount: "120.35",
    });
  });
  test("un conteo viejo no pisa el stock después de una venta", async () => {
    await count();
    tables.bar_inventory[0].currentStock = "11.900000";
    tables.event_inventory[0].stockAllocated = "11.900000";
    const prior = writes.length;
    expect((await count("15", "12.000000")).status).toBe(409);
    expect(writes).toHaveLength(prior);
    expect(tables.bar_inventory[0].currentStock).toBe("11.900000");
  });
  test("corregir un conteo mantiene el stock de las demás barras y el remanente histórico", async () => {
    await count();
    tables.bar_inventory.push({
      id: "other",
      tenantId: "tenant-1",
      barId: "bar-2",
      inventoryItemId: "rum",
      currentStock: "2.000000",
    });
    tables.bars.push({ id: "bar-2", eventId: "event-1", tenantId: "tenant-1" });
    tables.event_inventory[0].stockAllocated = "16.000000";
    expect((await count("4", "12.000000")).status).toBe(200);
    expect(tables.bar_inventory[0].currentStock).toBe("4.000000");
    expect(tables.bar_inventory[1].currentStock).toBe("2.000000");
    expect(tables.event_inventory[0].stockAllocated).toBe("8.000000");
  });
  test("rechaza barra e insumo de otro tenant sin escribir", async () => {
    tables.bars[0].tenantId = "tenant-2";
    expect((await count()).status).toBe(404);
    tables.bars[0].tenantId = "tenant-1";
    tables.inventory_items[0].tenantId = "tenant-2";
    expect((await count()).status).toBe(404);
    expect(writes).toHaveLength(0);
  });
  test("no fabrica stock en eventos sin seguimiento de inventario", async () => {
    tables.events[0].operationMode = "TICKETS_AND_CONSUMPTIONS";
    expect((await count()).status).toBe(400);
    expect(writes).toHaveLength(0);
  });
  test("conserva fracciones reales y permite corregir a cero", async () => {
    expect((await count("0.5")).status).toBe(200);
    expect(tables.bar_inventory[0].currentStock).toBe("0.500000");
    expect((await count("0", "0.500000")).status).toBe(200);
    expect(tables.bar_inventory[0].currentStock).toBe("0.000000");
  });
  test("no admite cantidades negativas, inválidas o costo sobre una reducción", async () => {
    expect((await count("-1")).status).toBe(400);
    expect((await count("abc")).status).toBe(400);
    await count();
    const before = writes.length;
    expect((await count("1", "12.000000", { totalCost: "10" })).status).toBe(400);
    expect(writes).toHaveLength(before);
  });
});

describe("Entrega de ventas ya descontadas en caja", () => {
  function posSale() {
    tables.sales.push({
      id: "sale-1",
      tenantId: "tenant-1",
      eventId: "event-1",
      barId: "bar-1",
      source: "POS",
      receiptToken: "receipt",
      totalAmount: "15.10",
    });
    tables.digital_consumptions.push({
      id: "cons-1",
      tenantId: "tenant-1",
      eventId: "event-1",
      productId: "drink",
      saleId: "sale-1",
      qrHash: "qr",
      status: "PENDING",
    });
    tables.sale_items.push({
      saleId: "sale-1",
      productId: "drink",
      priceAtTime: "15.10",
      quantity: 1,
    });
    tables.bar_inventory.push({
      id: "stock",
      tenantId: "tenant-1",
      barId: "bar-1",
      inventoryItemId: "rum",
      currentStock: "0.00",
    });
    tables.event_inventory.push({
      id: "event-stock",
      tenantId: "tenant-1",
      eventId: "event-1",
      inventoryItemId: "rum",
      stockAllocated: "0.00",
    });
  }
  test("un QR individual POS se entrega sin descontar dos veces", async () => {
    posSale();
    const res = await request("/bar-1/redeem", "POST", { qrHash: "qr" });
    expect(res.status).toBe(200);
    expect(tables.digital_consumptions[0].status).toBe("REDEEMED");
    expect(
      writes.some((row) =>
        ["bar_inventory", "event_inventory"].includes(row.table),
      ),
    ).toBe(false);
    expect(
      (await request("/bar-1/redeem", "POST", { qrHash: "qr" })).status,
    ).toBe(400);
  });
  test("un pedido de retiro POS no vuelve a descontar stock al entregarse", async () => {
    posSale();
    tables.pickup_orders = [
      {
        id: "pickup",
        token: "pickup-token",
        eventId: "event-1",
        tenantId: "tenant-1",
        status: "PENDING",
        itemsJson: [
          { consumptionId: "cons-1", productId: "drink", quantity: 1 },
        ],
      },
    ];
    const preview = await request("/bar-1/pickups/pickup-token", "GET");
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as Row).stockShortages).toEqual([]);
    expect(
      (await request("/bar-1/pickups/pickup-token/deliver", "POST")).status,
    ).toBe(200);
    expect(
      writes.some((row) =>
        ["bar_inventory", "event_inventory"].includes(row.table),
      ),
    ).toBe(false);
    expect(
      (await request("/bar-1/pickups/pickup-token/deliver", "POST")).status,
    ).toBe(409);
  });
  test("un QR web sí descuenta la receta y un reintento no repite el descuento", async () => {
    posSale();
    tables.sales[0].source = "WEB";
    tables.event_inventory[0].stockAllocated = "1.000000";
    tables.bar_inventory[0].currentStock = "1.000000";
    expect(
      (await request("/bar-1/redeem", "POST", { qrHash: "qr" })).status,
    ).toBe(200);
    expect(tables.bar_inventory[0].currentStock).toBe("0.900000");
    expect(tables.event_inventory[0].stockAllocated).toBe("0.900000");
    expect(
      (await request("/bar-1/redeem", "POST", { qrHash: "qr" })).status,
    ).toBe(400);
    expect(tables.bar_inventory[0].currentStock).toBe("0.900000");
  });
  test("el comprobante POS se puede entregar aunque el stock reservado ya esté en cero", async () => {
    posSale();
    const preview = await request("/bar-1/sales/receipt", "GET");
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as Row).stockShortages).toEqual([]);
    const delivered = await request("/bar-1/sales/receipt/deliver", "POST");
    expect(delivered.status).toBe(200);
    expect(
      writes.some((row) =>
        ["bar_inventory", "event_inventory"].includes(row.table),
      ),
    ).toBe(false);
    expect((await request("/bar-1/sales/receipt/deliver", "POST")).status).toBe(
      409,
    );
  });
});

describe("Productos que se venden por unidad", () => {
  function unitProduct() {
    tables.inventory_items.push({
      id: "coke",
      tenantId: "tenant-1",
      name: "Coca lata",
      baseUnit: "UNIT",
      packageSize: "1.00",
      countingUnit: "unidades",
      isActive: true,
    });
    tables.products.push({
      id: "can",
      tenantId: "tenant-1",
      name: "Coca lata",
      price: "3.00",
      saleType: "UNIT",
      isActive: true,
    });
    tables.product_recipes.push({
      id: "own",
      productId: "can",
      inventoryItemId: "coke",
      quantityUsed: "1.000000",
      yieldPerPackage: null,
    });
    tables.bars.push({ id: "bar-2", eventId: "event-1", tenantId: "tenant-1" });
    tables.bar_inventory.push(
      { id: "bi1", tenantId: "tenant-1", barId: "bar-1", inventoryItemId: "coke", currentStock: "4.000000" },
      { id: "bi2", tenantId: "tenant-1", barId: "bar-2", inventoryItemId: "coke", currentStock: "8.000000" },
    );
    tables.event_inventory.push({
      id: "ei",
      tenantId: "tenant-1",
      eventId: "event-1",
      inventoryItemId: "coke",
      stockAllocated: "12.000000",
    });
  }
  test("entregar una compra web descuenta 1 de su insumo sólo en la barra que entrega", async () => {
    unitProduct();
    tables.sales.push({
      id: "unit-sale",
      tenantId: "tenant-1",
      eventId: "event-1",
      source: "WEB",
      barId: null,
      receiptToken: "unit-receipt",
    });
    tables.digital_consumptions.push({
      id: "unit-cons",
      tenantId: "tenant-1",
      eventId: "event-1",
      productId: "can",
      saleId: "unit-sale",
      status: "PENDING",
      qrHash: "unit-qr",
    });
    expect(
      (await request("/bar-1/redeem", "POST", { qrHash: "unit-qr" })).status,
    ).toBe(200);
    expect(tables.bar_inventory[0].currentStock).toBe("3.000000");
    expect(tables.bar_inventory[1].currentStock).toBe("8.000000");
    expect(tables.event_inventory[0].stockAllocated).toBe("11.000000");
  });
  test("su insumo se puede usar en la receta de otro producto", async () => {
    unitProduct();
    expect(
      (
        await inventoryRequest("/products/drink/recipe", "PUT", {
          recipes: [
            { inventoryItemId: "rum", yieldPerPackage: "10" },
            { inventoryItemId: "coke", yieldPerPackage: "2" },
          ],
        })
      ).status,
    ).toBe(200);
    expect(
      tables.product_recipes.filter((row) => row.productId === "drink"),
    ).toHaveLength(2);
    expect(
      tables.product_recipes.find((row) => row.productId === "can"),
    ).toMatchObject({ inventoryItemId: "coke", quantityUsed: "1.000000" });
  });
  test("el conteo por producto ya no se escribe: se carga en su insumo", async () => {
    unitProduct();
    tables.bar_products.push({
      id: "bp",
      barId: "bar-1",
      tenantId: "tenant-1",
      productId: "can",
      isActive: true,
      directStock: null,
    });
    expect(
      (
        await request("/bar-1/product-stock", "PUT", {
          productId: "can",
          quantity: "10",
          expectedCurrentStock: null,
        })
      ).status,
    ).toBe(400);
    expect(writes).toHaveLength(0);
  });
});

describe("Modos de venta e insumos por unidad", () => {
  test("un insumo nuevo sólo pide nombre y se cuenta en unidades", async () => {
    const res = await inventoryRequest("/items", "POST", {
      name: "Fernet",
      baseUnit: "ML",
      packageSize: "750",
    });
    expect(res.status).toBe(201);
    expect(tables.inventory_items[1]).toMatchObject({
      tenantId: "tenant-1",
      name: "Fernet",
      baseUnit: "UNIT",
      packageSize: "1.00",
      countingUnit: "unidades",
    });
    expect(
      (await inventoryRequest("/items", "POST", { name: "fernét " })).status,
    ).toBe(409);
    expect(tables.inventory_items).toHaveLength(2);
  });
  test("la receta de un trago guarda 1/N truncado y N", async () => {
    const res = await inventoryRequest("/products/drink/recipe", "PUT", {
      recipes: [{ inventoryItemId: "rum", yieldPerPackage: "3" }],
    });
    expect(res.status).toBe(200);
    expect(tables.product_recipes).toHaveLength(1);
    expect(tables.product_recipes[0]).toMatchObject({
      inventoryItemId: "rum",
      quantityUsed: "0.333333",
      yieldPerPackage: "3.000",
    });
  });
  test("las botellas guardan unidades enteras por venta", async () => {
    tables.products[0].saleType = "BOTTLE";
    expect(
      (
        await inventoryRequest("/products/drink/recipe", "PUT", {
          recipes: [{ inventoryItemId: "rum", quantityUsed: "1.5" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await inventoryRequest("/products/drink/recipe", "PUT", {
          recipes: [{ inventoryItemId: "rum", quantityUsed: "2" }],
        })
      ).status,
    ).toBe(200);
    expect(tables.product_recipes[0]).toMatchObject({
      quantityUsed: "2.000000",
      yieldPerPackage: null,
    });
  });
  test("pasar a unidad crea su insumo propio y descarta la receta anterior", async () => {
    tables.bar_products.push({
      id: "bp1",
      barId: "bar-1",
      tenantId: "tenant-1",
      productId: "drink",
      isActive: true,
      directStock: "5.00",
    });
    const toUnit = await inventoryRequest("/products/drink/sale-type", "PUT", {
      saleType: "UNIT",
    });
    expect(toUnit.status).toBe(200);
    expect(tables.products[0].saleType).toBe("UNIT");
    const own = tables.inventory_items.find((row) => row.name === "Cuba libre");
    expect(own).toMatchObject({ tenantId: "tenant-1", baseUnit: "UNIT", isActive: true });
    expect(tables.product_recipes).toHaveLength(1);
    expect(tables.product_recipes[0]).toMatchObject({
      productId: "drink",
      inventoryItemId: own!.id,
      quantityUsed: "1.000000",
    });
    expect(tables.bar_products[0].directStock).toBeNull();
    expect(
      (
        await inventoryRequest("/products/drink/recipe", "PUT", {
          recipes: [{ inventoryItemId: "rum", yieldPerPackage: "10" }],
        })
      ).status,
    ).toBe(400);
    await inventoryRequest("/products/drink/sale-type", "PUT", {
      saleType: "NONE",
    });
    expect(tables.product_recipes).toHaveLength(0);
    expect(tables.inventory_items.find((row) => row.id === own!.id)).toBeDefined();
  });
  test("pasar a unidad reutiliza el insumo con el mismo nombre", async () => {
    tables.inventory_items.push({
      id: "same",
      tenantId: "tenant-1",
      name: "cuba líbre",
      baseUnit: "UNIT",
      packageSize: "1.00",
      countingUnit: "unidades",
      isActive: true,
    });
    await inventoryRequest("/products/drink/sale-type", "PUT", {
      saleType: "UNIT",
    });
    expect(tables.inventory_items).toHaveLength(2);
    expect(tables.product_recipes[0].inventoryItemId).toBe("same");
  });
  test("renombrar un producto por unidad renombra su insumo y conserva el enlace", async () => {
    await inventoryRequest("/products/drink/sale-type", "PUT", {
      saleType: "UNIT",
    });
    const ownId = tables.product_recipes[0].inventoryItemId;
    const res = await inventoryRequest("/products/drink", "PUT", {
      name: "Cuba lata",
      price: "15.10",
      saleType: "UNIT",
      recipes: [],
    });
    expect(res.status).toBe(200);
    expect(tables.product_recipes).toHaveLength(1);
    expect(tables.product_recipes[0].inventoryItemId).toBe(ownId);
    expect(tables.inventory_items.find((row) => row.id === ownId)?.name).toBe(
      "Cuba lata",
    );
  });
  test("roles operativos no cambian modos, recetas ni insumos", async () => {
    staff.role = "BARTENDER";
    expect(
      (
        await inventoryRequest("/products/drink/sale-type", "PUT", {
          saleType: "NONE",
        })
      ).status,
    ).toBe(403);
    expect(
      (await inventoryRequest("/items", "POST", { name: "Hielo" })).status,
    ).toBe(403);
    expect(writes).toHaveLength(0);
    expect(tables.products[0].saleType).toBe("GLASS");
  });
});
