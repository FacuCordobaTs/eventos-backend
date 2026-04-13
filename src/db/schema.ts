import { 
    mysqlTable, 
    varchar, 
    int, 
    timestamp, 
    decimal, 
    boolean, 
    mysqlEnum,
    index,
    uniqueIndex,
  } from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';

export const tenants = mysqlTable('tenants', {
  id: varchar('id', { length: 36 }).primaryKey(), // Recomiendo UUIDs o CUIDs
  name: varchar('name', { length: 255 }).notNull(), // Ej: "Lauta Eventos"
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').onUpdateNow(),
});

export const staff = mysqlTable(
  'staff',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 36 }).references(() => tenants.id),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    role: mysqlEnum('role', ['ADMIN', 'MANAGER', 'BARTENDER', 'SECURITY']).notNull(),
    pinCode: varchar('pin_code', { length: 6 }), // Para acceso rápido en el POS
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    tenantIdIdx: index('staff_tenant_id_idx').on(table.tenantId),
  })
);

// -----------------------------------------------------------------------------
// 6. CLIENTES (App B2B2C)
// -----------------------------------------------------------------------------

export const customers = mysqlTable('customers', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

// -----------------------------------------------------------------------------
// 2. EVENTOS Y ENTRADAS (El control de acceso)
// -----------------------------------------------------------------------------

export const events = mysqlTable(
  'events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    name: varchar('name', { length: 255 }).notNull(), // Ej: "Fiesta de la Primavera"
    date: timestamp('date').notNull(),
    location: varchar('location', { length: 255 }),
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    tenantIdIdx: index('events_tenant_id_idx').on(table.tenantId),
  })
);

export const ticketTypes = mysqlTable(
  'ticket_types',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    name: varchar('name', { length: 100 }).notNull(), // "General", "VIP", "Mesa"
    price: decimal('price', { precision: 10, scale: 2 }).notNull(),
    stockLimit: int('stock_limit'), // null = ilimitado
  },
  (table) => ({
    tenantIdIdx: index('ticket_types_tenant_id_idx').on(table.tenantId),
    eventTenantIdx: index('ticket_types_event_tenant_idx').on(table.eventId, table.tenantId),
  })
);

export const tickets = mysqlTable(
  'tickets',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    ticketTypeId: varchar('ticket_type_id', { length: 36 }).notNull().references(() => ticketTypes.id),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    qrHash: varchar('qr_hash', { length: 255 }).notNull().unique(),
    status: mysqlEnum('status', ['PENDING', 'USED', 'CANCELLED']).default('PENDING'),
    buyerName: varchar('buyer_name', { length: 255 }),
    buyerEmail: varchar('buyer_email', { length: 255 }),
    customerId: varchar('customer_id', { length: 36 }).references(() => customers.id),
    scannedAt: timestamp('scanned_at'),
    scannedBy: varchar('scanned_by', { length: 36 }).references(() => staff.id),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    tenantIdIdx: index('tickets_tenant_id_idx').on(table.tenantId),
    eventTenantIdx: index('tickets_event_tenant_idx').on(table.eventId, table.tenantId),
    customerIdx: index('tickets_customer_id_idx').on(table.customerId),
  })
);

// -----------------------------------------------------------------------------
// 3. INVENTARIO PRO
// -----------------------------------------------------------------------------

export const inventoryItems = mysqlTable('inventory_items', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(),
  unit: mysqlEnum('unit', ['ML', 'UNIDAD', 'GRAMOS']).notNull(), // Para saber si descontar mililitros o latas
});

export const eventInventory = mysqlTable(
  'event_inventory',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    eventId: varchar('event_id', { length: 36 })
      .notNull()
      .references(() => events.id),
    inventoryItemId: varchar('inventory_item_id', { length: 36 })
      .notNull()
      .references(() => inventoryItems.id),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id),
    stockAllocated: decimal('stock_allocated', { precision: 10, scale: 2 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    uniqueEventItem: uniqueIndex('event_inventory_event_item_unique').on(
      table.eventId,
      table.inventoryItemId
    ),
    tenantIdx: index('event_inventory_tenant_idx').on(table.tenantId),
  })
);

export const products = mysqlTable('products', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(),
  price: decimal('price', { precision: 10, scale: 2 }).notNull(),
  isActive: boolean('is_active').default(true),
});

export const eventProducts = mysqlTable(
  'event_products',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    eventId: varchar('event_id', { length: 36 })
      .notNull()
      .references(() => events.id),
    productId: varchar('product_id', { length: 36 })
      .notNull()
      .references(() => products.id),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id),
    priceOverride: decimal('price_override', { precision: 10, scale: 2 }),
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    eventTenantIdx: index('event_products_event_tenant_idx').on(
      table.eventId,
      table.tenantId
    ),
    uniqueEventProduct: uniqueIndex('event_products_event_product_unique').on(
      table.eventId,
      table.productId
    ),
  })
);

export const bars = mysqlTable(
  'bars',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    eventId: varchar('event_id', { length: 36 })
      .notNull()
      .references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id),
    name: varchar('name', { length: 255 }).notNull(),
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').onUpdateNow(),
  },
  (table) => ({
    eventTenantIdx: index('bars_event_tenant_idx').on(table.eventId, table.tenantId),
  })
);

export const barProducts = mysqlTable(
  'bar_products',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    barId: varchar('bar_id', { length: 36 })
      .notNull()
      .references(() => bars.id),
    productId: varchar('product_id', { length: 36 })
      .notNull()
      .references(() => products.id),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id),
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    barTenantIdx: index('bar_products_tenant_idx').on(table.barId, table.tenantId),
    uniqueBarProduct: uniqueIndex('bar_products_bar_product_unique').on(
      table.barId,
      table.productId
    ),
  })
);

export const barInventory = mysqlTable(
  'bar_inventory',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    barId: varchar('bar_id', { length: 36 })
      .notNull()
      .references(() => bars.id),
    inventoryItemId: varchar('inventory_item_id', { length: 36 })
      .notNull()
      .references(() => inventoryItems.id),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id),
    currentStock: decimal('current_stock', { precision: 10, scale: 2 })
      .notNull()
      .default('0'),
    updatedAt: timestamp('updated_at').onUpdateNow(),
  },
  (table) => ({
    barTenantIdx: index('bar_inventory_tenant_idx').on(table.barId, table.tenantId),
    uniqueBarInventory: uniqueIndex('bar_inventory_bar_item_unique').on(
      table.barId,
      table.inventoryItemId
    ),
  })
);

export const eventStaff = mysqlTable(
  'event_staff',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    eventId: varchar('event_id', { length: 36 })
      .notNull()
      .references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id),
    staffId: varchar('staff_id', { length: 36 })
      .notNull()
      .references(() => staff.id),
    barId: varchar('bar_id', { length: 36 }).references(() => bars.id),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    eventTenantIdx: index('event_staff_event_tenant_idx').on(
      table.eventId,
      table.tenantId
    ),
    uniqueEventStaff: uniqueIndex('event_staff_event_staff_unique').on(
      table.eventId,
      table.staffId
    ),
  })
);

export const eventExpenses = mysqlTable(
  'event_expenses',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    eventId: varchar('event_id', { length: 36 })
      .notNull()
      .references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 })
      .notNull()
      .references(() => tenants.id),
    description: varchar('description', { length: 255 }).notNull(),
    category: mysqlEnum('category', [
      'MUSIC',
      'LIGHTS',
      'FOOD',
      'STAFF',
      'MARKETING',
      'INFRASTRUCTURE',
      'OTHER',
    ])
      .notNull()
      .default('OTHER'),
    amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
    date: timestamp('date').notNull().defaultNow(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    eventTenantIdx: index('event_expenses_tenant_idx').on(
      table.eventId,
      table.tenantId
    ),
  })
);

export const productRecipes = mysqlTable('product_recipes', {
  id: varchar('id', { length: 36 }).primaryKey(),
  productId: varchar('product_id', { length: 36 }).notNull().references(() => products.id),
  inventoryItemId: varchar('inventory_item_id', { length: 36 }).notNull().references(() => inventoryItems.id),
  quantityUsed: decimal('quantity_used', { precision: 10, scale: 2 }).notNull(), // Ej: 150.00
});

// -----------------------------------------------------------------------------
// 4. VENTAS (El POS y la caja)
// -----------------------------------------------------------------------------

export const sales = mysqlTable(
  'sales',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    barId: varchar('bar_id', { length: 36 }).references(() => bars.id),
    staffId: varchar('staff_id', { length: 36 }).references(() => staff.id), // Quién cobró
    customerId: varchar('customer_id', { length: 36 }).references(() => customers.id),
    source: mysqlEnum('source', ['POS', 'APP', 'WEB']).notNull().default('POS'),
    totalAmount: decimal('total_amount', { precision: 10, scale: 2 }).notNull(),
    paymentMethod: mysqlEnum('payment_method', ['CASH', 'CARD', 'MERCADOPAGO', 'TRANSFER']).notNull(),
    status: mysqlEnum('status', ['COMPLETED', 'REFUNDED']).default('COMPLETED'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    barIdx: index('sales_bar_id_idx').on(table.barId),
  })
);

export const saleItems = mysqlTable('sale_items', {
  id: varchar('id', { length: 36 }).primaryKey(),
  saleId: varchar('sale_id', { length: 36 }).notNull().references(() => sales.id),
  productId: varchar('product_id', { length: 36 }).notNull().references(() => products.id),
  quantity: int('quantity').notNull(),
  priceAtTime: decimal('price_at_time', { precision: 10, scale: 2 }).notNull(),
});

export const digitalConsumptions = mysqlTable('digital_consumptions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  /** Null cuando la consumición proviene del POS (venta sin cliente en app). */
  customerId: varchar('customer_id', { length: 36 }).references(() => customers.id),
  eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
  tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
  productId: varchar('product_id', { length: 36 }).notNull().references(() => products.id),
  saleId: varchar('sale_id', { length: 36 }).notNull().references(() => sales.id),
  qrHash: varchar('qr_hash', { length: 255 }).notNull().unique(),
  status: mysqlEnum('status', ['PENDING', 'REDEEMED', 'CANCELLED']).default('PENDING'),
  redeemedAt: timestamp('redeemed_at'),
  redeemedBy: varchar('redeemed_by', { length: 36 }).references(() => staff.id),
  createdAt: timestamp('created_at').defaultNow(),
});

// -----------------------------------------------------------------------------
// 5. RELACIONES
// -----------------------------------------------------------------------------

export const eventsRelations = relations(events, ({ many }) => ({
  eventProducts: many(eventProducts),
  eventInventory: many(eventInventory),
  bars: many(bars),
  eventStaff: many(eventStaff),
  expenses: many(eventExpenses),
}));

export const productsRelations = relations(products, ({ many }) => ({
  recipes: many(productRecipes),
  eventProducts: many(eventProducts),
  barProducts: many(barProducts),
}));

export const eventProductsRelations = relations(eventProducts, ({ one }) => ({
  event: one(events, {
    fields: [eventProducts.eventId],
    references: [events.id],
  }),
  product: one(products, {
    fields: [eventProducts.productId],
    references: [products.id],
  }),
  tenant: one(tenants, {
    fields: [eventProducts.tenantId],
    references: [tenants.id],
  }),
}));

export const barsRelations = relations(bars, ({ one, many }) => ({
  event: one(events, {
    fields: [bars.eventId],
    references: [events.id],
  }),
  tenant: one(tenants, {
    fields: [bars.tenantId],
    references: [tenants.id],
  }),
  eventStaff: many(eventStaff),
  barProducts: many(barProducts),
  barInventory: many(barInventory),
  sales: many(sales),
}));

export const barProductsRelations = relations(barProducts, ({ one }) => ({
  bar: one(bars, {
    fields: [barProducts.barId],
    references: [bars.id],
  }),
  product: one(products, {
    fields: [barProducts.productId],
    references: [products.id],
  }),
  tenant: one(tenants, {
    fields: [barProducts.tenantId],
    references: [tenants.id],
  }),
}));

export const barInventoryRelations = relations(barInventory, ({ one }) => ({
  bar: one(bars, {
    fields: [barInventory.barId],
    references: [bars.id],
  }),
  inventoryItem: one(inventoryItems, {
    fields: [barInventory.inventoryItemId],
    references: [inventoryItems.id],
  }),
  tenant: one(tenants, {
    fields: [barInventory.tenantId],
    references: [tenants.id],
  }),
}));

export const inventoryItemsRelations = relations(inventoryItems, ({ many }) => ({
  barInventory: many(barInventory),
  eventInventory: many(eventInventory),
}));

export const eventInventoryRelations = relations(eventInventory, ({ one }) => ({
  event: one(events, {
    fields: [eventInventory.eventId],
    references: [events.id],
  }),
  inventoryItem: one(inventoryItems, {
    fields: [eventInventory.inventoryItemId],
    references: [inventoryItems.id],
  }),
  tenant: one(tenants, {
    fields: [eventInventory.tenantId],
    references: [tenants.id],
  }),
}));

export const staffRelations = relations(staff, ({ many }) => ({
  eventAssignments: many(eventStaff),
}));

export const eventStaffRelations = relations(eventStaff, ({ one }) => ({
  event: one(events, {
    fields: [eventStaff.eventId],
    references: [events.id],
  }),
  staff: one(staff, {
    fields: [eventStaff.staffId],
    references: [staff.id],
  }),
  bar: one(bars, {
    fields: [eventStaff.barId],
    references: [bars.id],
  }),
  tenant: one(tenants, {
    fields: [eventStaff.tenantId],
    references: [tenants.id],
  }),
}));

export const eventExpensesRelations = relations(eventExpenses, ({ one }) => ({
  event: one(events, {
    fields: [eventExpenses.eventId],
    references: [events.id],
  }),
  tenant: one(tenants, {
    fields: [eventExpenses.tenantId],
    references: [tenants.id],
  }),
}));

export const productRecipesRelations = relations(productRecipes, ({ one }) => ({
  product: one(products, {
    fields: [productRecipes.productId],
    references: [products.id],
  }),
  inventoryItem: one(inventoryItems, {
    fields: [productRecipes.inventoryItemId],
    references: [inventoryItems.id],
  }),
}));

export const salesRelations = relations(sales, ({ one, many }) => ({
  bar: one(bars, {
    fields: [sales.barId],
    references: [bars.id],
  }),
  items: many(saleItems),
}));

export const saleItemsRelations = relations(saleItems, ({ one }) => ({
  sale: one(sales, {
    fields: [saleItems.saleId],
    references: [sales.id],
  }),
  product: one(products, {
    fields: [saleItems.productId],
    references: [products.id],
  }),
}));