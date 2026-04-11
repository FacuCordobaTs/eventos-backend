import { 
    mysqlTable, 
    varchar, 
    int, 
    timestamp, 
    decimal, 
    boolean, 
    mysqlEnum 
  } from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';

export const tenants = mysqlTable('tenants', {
  id: varchar('id', { length: 36 }).primaryKey(), // Recomiendo UUIDs o CUIDs
  name: varchar('name', { length: 255 }).notNull(), // Ej: "Lauta Eventos"
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').onUpdateNow(),
});

export const staff = mysqlTable('staff', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 }).references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  role: mysqlEnum('role', ['ADMIN', 'MANAGER', 'BARTENDER', 'SECURITY']).notNull(),
  pinCode: varchar('pin_code', { length: 6 }), // Para acceso rápido en el POS
  createdAt: timestamp('created_at').defaultNow(),
});

// -----------------------------------------------------------------------------
// 2. EVENTOS Y ENTRADAS (El control de acceso)
// -----------------------------------------------------------------------------

export const events = mysqlTable('events', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(), // Ej: "Fiesta de la Primavera"
  date: timestamp('date').notNull(),
  location: varchar('location', { length: 255 }),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

export const ticketTypes = mysqlTable('ticket_types', {
  id: varchar('id', { length: 36 }).primaryKey(),
  eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
  tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
  name: varchar('name', { length: 100 }).notNull(), // "General", "VIP", "Mesa"
  price: decimal('price', { precision: 10, scale: 2 }).notNull(),
  stockLimit: int('stock_limit'), // null = ilimitado
});

export const tickets = mysqlTable('tickets', {
  id: varchar('id', { length: 36 }).primaryKey(),
  ticketTypeId: varchar('ticket_type_id', { length: 36 }).notNull().references(() => ticketTypes.id),
  eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
  tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
  qrHash: varchar('qr_hash', { length: 255 }).notNull().unique(),
  status: mysqlEnum('status', ['PENDING', 'USED', 'CANCELLED']).default('PENDING'),
  scannedAt: timestamp('scanned_at'),
  scannedBy: varchar('scanned_by', { length: 36 }).references(() => staff.id),
  createdAt: timestamp('created_at').defaultNow(),
});

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

// -----------------------------------------------------------------------------
// 5. RELACIONES
// -----------------------------------------------------------------------------

export const productsRelations = relations(products, ({ many }) => ({
  recipes: many(productRecipes),
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