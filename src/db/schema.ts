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
  currentStock: decimal('current_stock', { precision: 10, scale: 2 }).notNull().default('0'), // Ej: 7500 (10 botellas de 750ml)
});

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

export const productRecipes = mysqlTable('product_recipes', {
  id: varchar('id', { length: 36 }).primaryKey(),
  productId: varchar('product_id', { length: 36 }).notNull().references(() => products.id),
  inventoryItemId: varchar('inventory_item_id', { length: 36 }).notNull().references(() => inventoryItems.id),
  quantityUsed: decimal('quantity_used', { precision: 10, scale: 2 }).notNull(), // Ej: 150.00
});

// -----------------------------------------------------------------------------
// 4. VENTAS (El POS y la caja)
// -----------------------------------------------------------------------------

export const sales = mysqlTable('sales', {
  id: varchar('id', { length: 36 }).primaryKey(),
  eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
  tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
  staffId: varchar('staff_id', { length: 36 }).references(() => staff.id), // Quién cobró
  customerId: varchar('customer_id', { length: 36 }).references(() => customers.id),
  source: mysqlEnum('source', ['POS', 'APP', 'WEB']).notNull().default('POS'),
  totalAmount: decimal('total_amount', { precision: 10, scale: 2 }).notNull(),
  paymentMethod: mysqlEnum('payment_method', ['CASH', 'CARD', 'MERCADOPAGO', 'TRANSFER']).notNull(),
  status: mysqlEnum('status', ['COMPLETED', 'REFUNDED']).default('COMPLETED'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const saleItems = mysqlTable('sale_items', {
  id: varchar('id', { length: 36 }).primaryKey(),
  saleId: varchar('sale_id', { length: 36 }).notNull().references(() => sales.id),
  productId: varchar('product_id', { length: 36 }).notNull().references(() => products.id),
  quantity: int('quantity').notNull(),
  priceAtTime: decimal('price_at_time', { precision: 10, scale: 2 }).notNull(),
});

export const digitalConsumptions = mysqlTable('digital_consumptions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  customerId: varchar('customer_id', { length: 36 }).notNull().references(() => customers.id),
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
}));

export const productsRelations = relations(products, ({ many }) => ({
  recipes: many(productRecipes),
  eventProducts: many(eventProducts),
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

export const salesRelations = relations(sales, ({ many }) => ({
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