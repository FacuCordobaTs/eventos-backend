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
    json,
  } from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';

export const tenants = mysqlTable('tenants', {
  id: varchar('id', { length: 36 }).primaryKey(), // Recomiendo UUIDs o CUIDs
  name: varchar('name', { length: 255 }).notNull(), // Ej: "Lauta Eventos"
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').onUpdateNow(),
  mpAccessToken: varchar('mp_access_token', { length: 512 }),
  mpRefreshToken: varchar('mp_refresh_token', { length: 512 }),
  mpPublicKey: varchar('mp_public_key', { length: 255 }),
  mpUserId: varchar('mp_user_id', { length: 255 }),
  mpConnected: boolean('mp_connected').default(false),
  cucuruApiKey: varchar('cucuru_api_key', { length: 255 }),
  cucuruCollectorId: varchar('cucuru_collector_id', { length: 255 }),
  cucuruEnabled: boolean('cucuru_enabled').default(false),
});

export const staff = mysqlTable(
  'staff',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 36 }).references(() => tenants.id),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    role: mysqlEnum('role', ['ADMIN', 'MANAGER', 'BARTENDER', 'SECURITY']).notNull(),
    pinCode: varchar('pin_code', { length: 6 }), // Para acceso rápido en el POS
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    tenantIdIdx: index('staff_tenant_id_idx').on(table.tenantId),
    emailTenantIdx: uniqueIndex('staff_email_tenant_unique').on(table.email, table.tenantId),
  })
);

// -----------------------------------------------------------------------------
// 6. CLIENTES (App B2B2C)
// -----------------------------------------------------------------------------

export const customers = mysqlTable('customers', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  phone: varchar('phone', { length: 255 }),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

// -----------------------------------------------------------------------------
// 2. EVENTOS Y ENTRADAS (El control de acceso)
// -----------------------------------------------------------------------------

/**
 * Liquidación congelada de la ceremonia de cierre (tarea 4.4). Todas las cifras monetarias van
 * como string decimal (misma convención que el resto de la API). `insumos` guarda el conteo real
 * vs. la estimación del sistema por insumo, para el reporte de merma. Ver `POST /events/:id/closing`.
 */
export type EventClosingReport = {
  closedAt: string
  income: { tickets: string; bar: string; gross: string }
  expenses: {
    operational: string
    merchandisePurchased: string
    merchandiseConsumed: string
  }
  leftoverValue: string
  netReal: string
  netProjected: string
  cash: { expected: string; counted: string } | null
  insumos: {
    inventoryItemId: string
    name: string
    countingUnit: string
    estimated: number
    counted: number
    purchased: number
    unitCost: string
    consumedCost: string
    leftoverValue: string
    mermaUnits: number
    mermaValue: string
  }[]
}

export const events = mysqlTable(
  'events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    name: varchar('name', { length: 255 }).notNull(), // Ej: "Fiesta de la Primavera"
    slug: varchar('slug', { length: 100 }).unique(), // URL-friendly: crow.ar/e/divino
    date: timestamp('date').notNull(),
    location: varchar('location', { length: 255 }),
    ticketsAvailableFrom: timestamp('tickets_available_from'),
    consumptionsAvailableFrom: timestamp('consumptions_available_from'),
    isActive: boolean('is_active').default(true),
    createdAt: timestamp('created_at').defaultNow(),
    imageUrl: varchar('image_url', { length: 512 }),
    /** Diseño de la página pública del evento. GLASS = glassmorphism (default), MINIMAL = plano/minimalista. */
    designType: mysqlEnum('design_type', ['GLASS', 'MINIMAL']).notNull().default('GLASS'),
    /**
     * Estado del ciclo de vida del evento. Fuente de verdad de la máquina de estados
     * (ver `backend/src/lib/event-status.ts`). Los valores DEBEN coincidir con
     * `EVENT_STATUSES` de ese módulo. Un evento nace en 'draft'.
     */
    status: mysqlEnum('status', ['draft', 'on_sale', 'live', 'closed']).notNull().default('draft'),
    /** Apertura PROGRAMADA: hora de puertas. Único trigger automático (on_sale → live). Null = sin programar. */
    doorsAt: timestamp('doors_at'),
    /** Efectiva: instante real en que la venta se abrió (draft → on_sale). */
    salesOpenedAt: timestamp('sales_opened_at'),
    /** Efectiva: instante real en que el evento pasó a En vivo (on_sale → live). */
    wentLiveAt: timestamp('went_live_at'),
    /** Efectiva: instante real en que el evento se cerró (live → closed). */
    closedAt: timestamp('closed_at'),
    /**
     * Tarea 4.4 — Liquidación de la ceremonia de cierre (spec §5 "Cierre"/"Cerrado").
     * Snapshot JSON congelado al cerrar: conteo real de insumos, estimación del sistema, costo
     * de mercadería CONSUMIDA (no comprada), sobrante valuado, caja, ingresos, gastos, neto y
     * merma. Se persiste porque el conteo manual NO se puede rederivar después. Null hasta que
     * el evento pasa por la ceremonia. La vista "Cerrado" (4.5) lo lee como reporte.
     */
    closingReport: json('closing_report').$type<EventClosingReport | null>(),
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

// Tandas: escalera de precios por tipo de entrada (spec §4.2).
// "Early $8.000 (200 cupos) → al agotarse, abre General $10.000; también por fecha".
// El sistema la ejecuta solo (evaluación perezosa en lectura), ver src/lib/ticket-tiers.ts.
// Un tipo de entrada SIN filas acá se comporta como hoy: precio/stock plano del ticketType.
export const ticketTiers = mysqlTable(
  'ticket_tiers',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    ticketTypeId: varchar('ticket_type_id', { length: 36 }).notNull().references(() => ticketTypes.id),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    name: varchar('name', { length: 100 }).notNull(), // "Early", "General"
    price: decimal('price', { precision: 10, scale: 2 }).notNull(),
    // Orden en la escalera (0 = primera). Las tandas se consumen en secuencia.
    position: int('position').notNull().default(0),
    // Cupos de ESTA tanda; null = ilimitada. Al agotarse, abre la siguiente por posición.
    stockLimit: int('stock_limit'),
    // Ventana por fecha (opcional). Fuera de ella la tanda no está activa.
    activeFrom: timestamp('active_from'),
    activeUntil: timestamp('active_until'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    tenantIdIdx: index('ticket_tiers_tenant_id_idx').on(table.tenantId),
    ticketTypeIdx: index('ticket_tiers_ticket_type_idx').on(table.ticketTypeId, table.position),
    eventTenantIdx: index('ticket_tiers_event_tenant_idx').on(table.eventId, table.tenantId),
  })
);

export const tickets = mysqlTable(
  'tickets',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    ticketTypeId: varchar('ticket_type_id', { length: 36 }).notNull().references(() => ticketTypes.id),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    saleId: varchar('sale_id', { length: 36 }).references(() => sales.id),
    qrHash: varchar('qr_hash', { length: 255 }).notNull().unique(),
    status: mysqlEnum('status', ['PENDING', 'USED', 'CANCELLED']).default('PENDING'),
    buyerName: varchar('buyer_name', { length: 255 }),
    buyerEmail: varchar('buyer_email', { length: 255 }),
    customerId: varchar('customer_id', { length: 36 }).references(() => customers.id),
    scannedAt: timestamp('scanned_at'),
    scannedBy: varchar('scanned_by', { length: 36 }).references(() => staff.id),
    createdAt: timestamp('created_at').defaultNow(),
    /** Set when staff or checkout flow sends the ticket QR by email. */
    emailSentAt: timestamp('email_sent_at'),
  },
  (table) => ({
    tenantIdIdx: index('tickets_tenant_id_idx').on(table.tenantId),
    eventTenantIdx: index('tickets_event_tenant_idx').on(table.eventId, table.tenantId),
    customerIdx: index('tickets_customer_id_idx').on(table.customerId),
    saleIdIdx: index('tickets_sale_id_idx').on(table.saleId),
  })
);

// Cortesías / invitaciones (spec §4.2): "links nominados que emiten una entrada,
// contados aparte". Cada fila es una invitación a nombre de una persona; su `token`
// arma el link público. Al canjearse (público, sin auth) emite UNA entrada real en
// `tickets` (para que el escáner/acceso funcione igual) y queda enlazada por `ticketId`.
// "Contados aparte": una entrada es cortesía sii existe una fila acá apuntándola, así
// el reporte las separa de las ventas pagas sin ensuciar la recaudación.
export const courtesies = mysqlTable(
  'courtesies',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    // Qué tipo de entrada emite el canje.
    ticketTypeId: varchar('ticket_type_id', { length: 36 }).notNull().references(() => ticketTypes.id),
    // Nombre del nominado (la cortesía es "a nombre de"). Requerido.
    guestName: varchar('guest_name', { length: 255 }).notNull(),
    // Email opcional del invitado (para mandarle el QR al canjear).
    guestEmail: varchar('guest_email', { length: 255 }),
    // Token del link público de canje. Único.
    token: varchar('token', { length: 64 }).notNull().unique(),
    status: mysqlEnum('status', ['PENDING', 'REDEEMED', 'REVOKED']).notNull().default('PENDING'),
    // Entrada emitida al canjear. Null hasta que se canjea.
    ticketId: varchar('ticket_id', { length: 36 }).references(() => tickets.id),
    redeemedAt: timestamp('redeemed_at'),
    // Staff que la creó (opcional).
    createdBy: varchar('created_by', { length: 36 }).references(() => staff.id),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    tenantIdIdx: index('courtesies_tenant_id_idx').on(table.tenantId),
    eventTenantIdx: index('courtesies_event_tenant_idx').on(table.eventId, table.tenantId),
    ticketTypeIdx: index('courtesies_ticket_type_idx').on(table.ticketTypeId),
    ticketIdIdx: index('courtesies_ticket_id_idx').on(table.ticketId),
  })
);

// -----------------------------------------------------------------------------
// 3. INVENTARIO PRO
// -----------------------------------------------------------------------------

export const inventoryItems = mysqlTable('inventory_items', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(),
  /**
   * Unidad CONTABLE en la que el usuario cuenta el stock: siempre un envase físico entero
   * ("botella", "lata", "bolsa de hielo"). Es la unidad de la spec §2/§4.3: el stock se cuenta
   * y se compra en estas unidades, nunca en ml/gramos. Un insumo NUEVO (modelo 1.4+) nace con
   * `baseUnit='UNIT'` y su etiqueta contable acá.
   */
  countingUnit: varchar('counting_unit', { length: 50 }).notNull().default('unidad'),
  /**
   * @deprecated Unidad de laboratorio del modelo viejo (ml/gramos/unidad). Se conserva por
   * back-compat con recetas/deducciones existentes (inventory-deduction.ts). Los insumos del
   * modelo nuevo usan 'UNIT' + `countingUnit`. Migra a "rinde N por envase" en tarea 1.5.
   */
  baseUnit: mysqlEnum('base_unit', ['ML', 'GRAMS', 'UNIT']).notNull(),
  /** @deprecated ml/gramos por envase (modelo viejo). 0 = sin envase fijo. Ver `countingUnit`. */
  packageSize: decimal('package_size', { precision: 10, scale: 2 }).notNull().default('0'),
  isActive: boolean('is_active').notNull().default(true),
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

/** Categorías opcionales para agrupar productos del catálogo (ej: Tragos, Cervezas, Sin alcohol). */
export const productCategories = mysqlTable(
  'product_categories',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    name: varchar('name', { length: 100 }).notNull(),
    /** Orden de visualización (menor primero). */
    sortOrder: int('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    tenantIdx: index('product_categories_tenant_idx').on(table.tenantId),
  })
);

export const products = mysqlTable('products', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
  name: varchar('name', { length: 255 }).notNull(),
  price: decimal('price', { precision: 10, scale: 2 }).notNull(),
  isActive: boolean('is_active').default(true),
  /** GLASS: la receta descuenta quantityUsed en la unidad del insumo; BOTTLE: quantityUsed es botellas × tamaño estándar. */
  saleType: mysqlEnum('sale_type', ['BOTTLE', 'GLASS']).notNull().default('GLASS'),
  imageUrl: varchar('image_url', { length: 512 }),
  /** Categoría opcional. Null = sin categoría. */
  categoryId: varchar('category_id', { length: 36 }).references(() => productCategories.id),
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
    /** Stock directo para productos sin receta (e.g. latas). Null = ilimitado. */
    directStock: decimal('direct_stock', { precision: 10, scale: 2 }),
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
    // La barra implícita del evento: la única que "vende todo" por defecto.
    // Un evento tiene a lo sumo una barra con isDefault=true. Los "puestos"
    // (subdivisión avanzada) nacen con isDefault=false heredando su menú.
    // Se materializa on-demand vía ensureDefaultBar() (routes/events.ts).
    isDefault: boolean('is_default').notNull().default(false),
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
    /**
     * Tarea 1.6 — Compra de mercadería como registro único. Si este gasto nació de una COMPRA
     * (fila de `purchases`), apunta a ella. Null = gasto operativo cargado a mano (sonido, DJ,
     * alquiler, seguridad). La spec §4.6 pide que la mercadería NO se cargue a mano en Finanzas:
     * entra sola por las compras de la Barra. La UI de Finanzas (3.5) filtra `purchaseId IS NULL`
     * para mostrar solo gastos operativos, y la mercadería aparece en la Barra. El `/summary`
     * sigue sumando TODOS los gastos (mercadería incluida) desde acá, así que el costo se cuenta
     * una sola vez (la tabla `purchases` NO se suma: es el registro físico + valuación).
     */
    purchaseId: varchar('purchase_id', { length: 36 }).references(() => purchases.id),
  },
  (table) => ({
    eventTenantIdx: index('event_expenses_tenant_idx').on(
      table.eventId,
      table.tenantId
    ),
    purchaseIdx: index('event_expenses_purchase_idx').on(table.purchaseId),
  })
);

/**
 * Tarea 1.6 — Compra de mercadería como registro ÚNICO (spec §0/§4.3/§4.6).
 * Una compra es UN hecho físico: sube stock del evento y asienta el costo, a la vez. El insumo
 * nace implícito la primera vez que se lo menciona (findOrCreateInventoryItemByName), y la
 * cantidad se carga en la UNIDAD CONTABLE (botellas/latas/bolsas), no en ml/gramos. Cada compra
 * enlaza el gasto que generó vía `eventExpenses.purchaseId` (relación 1:1, para no duplicar).
 * La liquidación de cierre (4.4) usa `quantity`/`totalCost` para valuar el sobrante.
 */
export const purchases = mysqlTable(
  'purchases',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    inventoryItemId: varchar('inventory_item_id', { length: 36 })
      .notNull()
      .references(() => inventoryItems.id),
    /** Cantidad comprada en unidad contable (ej: 10 botellas). Snapshot de la `countingUnit` del insumo. */
    quantity: decimal('quantity', { precision: 12, scale: 2 }).notNull(),
    /** Etiqueta de la unidad contable al momento de comprar ("botella", "lata"). Snapshot informativo. */
    countingUnit: varchar('counting_unit', { length: 50 }).notNull().default('unidad'),
    /** Costo total de la compra (el gasto que se asienta). 0 = ajuste sin costo (no genera gasto). */
    totalCost: decimal('total_cost', { precision: 12, scale: 2 }).notNull().default('0'),
    /** Nota opcional. */
    note: varchar('note', { length: 255 }),
    /** Staff que la cargó (opcional). */
    createdBy: varchar('created_by', { length: 36 }).references(() => staff.id),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    tenantIdx: index('purchases_tenant_idx').on(table.tenantId),
    eventTenantIdx: index('purchases_event_tenant_idx').on(table.eventId, table.tenantId),
    itemIdx: index('purchases_item_idx').on(table.inventoryItemId),
  })
);

export const productRecipes = mysqlTable('product_recipes', {
  id: varchar('id', { length: 36 }).primaryKey(),
  productId: varchar('product_id', { length: 36 }).notNull().references(() => products.id),
  inventoryItemId: varchar('inventory_item_id', { length: 36 }).notNull().references(() => inventoryItems.id),
  /**
   * @deprecated Modelo viejo: cantidad consumida por porción en la unidad de laboratorio del
   * insumo (ml/gramos/UNIT). Ej: 150.00 = 150 ml por trago. Se conserva porque la deducción de
   * stock (inventory-deduction.ts) todavía descuenta en base units. El modelo nuevo (1.5) es
   * `yieldPerPackage` ("rinde N por envase"); `quantityUsed` se mantiene sincronizado (derivado)
   * para no romper la deducción hasta que la Barra (3.2) mueva el stock a unidad contable.
   */
  quantityUsed: decimal('quantity_used', { precision: 10, scale: 2 }).notNull(), // Ej: 150.00
  /**
   * Modelo 1.5 "rinde N por envase": cuántas porciones (tragos) salen de UN envase contable del
   * insumo — la pregunta que el usuario ya sabe responder ("10 tragos por botella"). La deducción
   * por porción es 1/yieldPerPackage unidades contables. Null en recetas del modelo viejo aún no
   * backfilleadas. Ver `baseUnitsPerServingFromYield` / `yieldPerPackageFromQuantityUsed`.
   */
  yieldPerPackage: decimal('yield_per_package', { precision: 10, scale: 3 }),
});

// -----------------------------------------------------------------------------
// 4. VENTAS (El POS y la caja)
// -----------------------------------------------------------------------------

export type GuestCheckoutSnapshotJson = {
  ticketLines: { ticketTypeId: string; quantity: number }[]
  drinkLines: { productId: string; quantity: number }[]
  contact: { name: string; email: string; phone: string }
}

export const sales = mysqlTable(
  'sales',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    barId: varchar('bar_id', { length: 36 }).references(() => bars.id),
    staffId: varchar('staff_id', { length: 36 }).references(() => staff.id), // Quién cobró
    customerId: varchar('customer_id', { length: 36 }).references(() => customers.id),
    receiptToken: varchar('receipt_token', { length: 36 }).notNull().unique(),
    source: mysqlEnum('source', ['POS', 'APP', 'WEB']).notNull().default('POS'),
    totalAmount: decimal('total_amount', { precision: 10, scale: 2 }).notNull(),
    paymentMethod: mysqlEnum('payment_method', ['CASH', 'CARD', 'MERCADOPAGO', 'TRANSFER']).notNull(),
    status: mysqlEnum('status', [
      'PENDING',
      'PAYMENT_FAILED',
      'COMPLETED',
      'REFUNDED',
    ]).default('COMPLETED'),
    /** Carrito + contacto para completar la venta tras pago MP (Checkout Pro). */
    guestCheckoutSnapshot: json('guest_checkout_snapshot').$type<GuestCheckoutSnapshotJson | null>(),
    mpPreferenceId: varchar('mp_preference_id', { length: 64 }),
    cucuruAlias: varchar('cucuru_alias', { length: 100 }),
    cucuruCvu: varchar('cucuru_cvu', { length: 22 }),
    cucuruPaymentId: varchar('cucuru_payment_id', { length: 100 }),
    createdAt: timestamp('created_at').defaultNow(),
    paid: boolean('paid').default(false),
    paidAt: timestamp('paid_at')
  },
  (table) => ({
    barIdx: index('sales_bar_id_idx').on(table.barId),
    mpPreferenceIdx: index('sales_mp_preference_id_idx').on(table.mpPreferenceId),
  })
);

export const mpProcessedPayments = mysqlTable('mp_processed_payments', {
  paymentId: varchar('payment_id', { length: 64 }).primaryKey(),
  saleId: varchar('sale_id', { length: 36 }).notNull(),
  processedAt: timestamp('processed_at').defaultNow(),
})

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

export const accountPool = mysqlTable("account_pool", {
  id: int("id").primaryKey().autoincrement(),
  tenantId: varchar("tenant_id", { length: 36 }).references(() => tenants.id),
  accountNumber: varchar("account_number", { length: 255 }),
  alias: varchar("alias", { length: 255 }),
  status: mysqlEnum("status", ["available", "assigned"]).default("available"),
  saleIdAssigned: varchar("sale_id_assigned", { length: 36 }),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// -----------------------------------------------------------------------------
// 4.b STAFF SIN FRICCIÓN (spec §1) — invitaciones, magic link y sesión de puesto
// -----------------------------------------------------------------------------

// Invitación de staff (spec §1): "el administrador lo invita desde Equipo con un link o un QR.
// La persona abre el link, pone su nombre y un PIN de 4-6 dígitos, y ya existe con su rol."
// Cada fila es un link nominado a un rol dentro del tenant; al aceptarse crea una fila en `staff`
// (email sintético + hash random: el alta es por PIN, no por contraseña) y queda enlazada por
// `accepted_staff_id`. Aditiva: no toca `staff` ni datos existentes.
export const staffInvitations = mysqlTable(
  'staff_invitations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    role: mysqlEnum('role', ['ADMIN', 'MANAGER', 'BARTENDER', 'SECURITY']).notNull(),
    // Token del link/QR público de aceptación. Único.
    token: varchar('token', { length: 64 }).notNull().unique(),
    status: mysqlEnum('status', ['PENDING', 'ACCEPTED', 'REVOKED']).notNull().default('PENDING'),
    // Staff creado al aceptar. Null hasta que se acepta.
    acceptedStaffId: varchar('accepted_staff_id', { length: 36 }).references(() => staff.id),
    acceptedAt: timestamp('accepted_at'),
    // Vencimiento opcional del link (null = no vence).
    expiresAt: timestamp('expires_at'),
    createdBy: varchar('created_by', { length: 36 }).references(() => staff.id),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    tenantIdIdx: index('staff_invitations_tenant_id_idx').on(table.tenantId),
    statusIdx: index('staff_invitations_status_idx').on(table.tenantId, table.status),
  })
);

// Magic link de login (spec §1): "Recibir un enlace de acceso". Está keyed por email (no por
// staff) para reflejar el mismo flujo multi-tenant que `/staff/login`: al consumir el token se
// resuelve como el login normal (una coincidencia entra directo; varias piden elegir productora).
// Token de un solo uso y de vida corta (~15 min). Aditiva.
export const magicLinks = mysqlTable(
  'magic_links',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    email: varchar('email', { length: 255 }).notNull(),
    token: varchar('token', { length: 64 }).notNull().unique(),
    usedAt: timestamp('used_at'),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    emailIdx: index('magic_links_email_idx').on(table.email),
  })
);

// Sesión de puesto (spec §1): "el administrador abre el POS en un teléfono o tablet y lo fija a un
// puesto concreto; a partir de ahí el personal rota sobre ese dispositivo identificándose solo con
// su PIN." Cada fila fija un dispositivo a un evento y (opcionalmente) a una barra/puesto; su
// `token` vive en el dispositivo. El personal entra por PIN contra el tenant de la sesión. Aditiva.
export const posSessions = mysqlTable(
  'pos_sessions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    // Puesto concreto. Null = barra implícita / nivel evento (camino por defecto del POS).
    barId: varchar('bar_id', { length: 36 }).references(() => bars.id),
    // Token del dispositivo (lo fija el admin al abrir el POS). Único.
    token: varchar('token', { length: 64 }).notNull().unique(),
    label: varchar('label', { length: 255 }),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: varchar('created_by', { length: 36 }).references(() => staff.id),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    tenantIdIdx: index('pos_sessions_tenant_id_idx').on(table.tenantId),
    eventTenantIdx: index('pos_sessions_event_tenant_idx').on(table.eventId, table.tenantId),
  })
);

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

export const productsRelations = relations(products, ({ one, many }) => ({
  recipes: many(productRecipes),
  eventProducts: many(eventProducts),
  barProducts: many(barProducts),
  category: one(productCategories, {
    fields: [products.categoryId],
    references: [productCategories.id],
  }),
}));

export const productCategoriesRelations = relations(productCategories, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [productCategories.tenantId],
    references: [tenants.id],
  }),
  products: many(products),
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

export const purchasesRelations = relations(purchases, ({ one }) => ({
  event: one(events, {
    fields: [purchases.eventId],
    references: [events.id],
  }),
  tenant: one(tenants, {
    fields: [purchases.tenantId],
    references: [tenants.id],
  }),
  inventoryItem: one(inventoryItems, {
    fields: [purchases.inventoryItemId],
    references: [inventoryItems.id],
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