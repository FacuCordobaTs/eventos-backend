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
  // Tarea 8.1 — WhatsApp (visión §2.3): credenciales de la Meta WhatsApp Cloud API
  // por tenant (mismo patrón que Cucuru). El token es un System User Access Token.
  whatsappPhone: varchar('whatsapp_phone', { length: 32 }), // ej. 5491155555555 (normalizado)
  whatsappPhoneNumberId: varchar('whatsapp_phone_number_id', { length: 64 }),
  whatsappToken: varchar('whatsapp_token', { length: 512 }),
  whatsappTemplateName: varchar('whatsapp_template_name', { length: 64 }), // template del recordatorio (8.2); null = default
  whatsappEnabled: boolean('whatsapp_enabled').default(false),
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
// PROMOTORES (tarea 9.1) — personas que venden entradas a comisión por la productora
// -----------------------------------------------------------------------------

/**
 * Tarea 9.1 — Promotores (visión §2.8: "cuánto vendió cada promotor"). A nivel TENANT
 * (una productora tiene sus promotores, que trabajan en varios eventos), no por evento:
 * `sales.promoter_id` y `tickets.promoter_id` los atribuyen por venta. Se "borran" con
 * `isActive = false` (soft delete): las ventas históricas siguen referenciándolos.
 */
export const promoters = mysqlTable(
  'promoters',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    name: varchar('name', { length: 255 }).notNull(),
    phone: varchar('phone', { length: 32 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    tenantIdIdx: index('promoters_tenant_id_idx').on(table.tenantId),
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
  /**
   * Tarea 1.1 — El DNI es la identidad del cliente dentro del evento (visión §2.0).
   * Único GLOBAL (un cliente es una persona) pero nullable: los clientes pre-existentes
   * no tienen DNI. Multiple NULLs son válidos en un unique key de MySQL.
   */
  dni: varchar('dni', { length: 20 }).unique(),
  /** Fecha de nacimiento para la validación +18 en puerta (tarea 1.1). Null hasta que se conozca. */
  birthDate: timestamp('birth_date'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow(),
});

// -----------------------------------------------------------------------------
// 2. EVENTOS Y ENTRADAS (El control de acceso)
// -----------------------------------------------------------------------------

/**
 * Tarea 10.1 — Cierre de caja POR PUESTO (visión §2.8: "Cómo cerró cada caja: cuánto debería
 * haber y cuánto contó el cajero. Si falta, se ve dónde."). Cada entrada es el cajón físico de
 * un puesto/barra: el `expected` es el efectivo (CASH) que debería haber según las `sales` de
 * esa barra, `byMethod` desglosa lo esperado por método de pago (para "se ve dónde") y `counted`
 * es lo que contó el cajero a mano (null = no se contó).
 */
export type CashClosingEntry = {
  /** null = caja de puerta: ventas sin puesto asignado (cargas de saldo en caja, etc.). */
  barId: string | null
  barName: string
  /** Efectivo esperado en ese cajón (ventas CASH de la barra). */
  expected: string
  /** Contado manual por el cajero; null = sin contar. */
  counted: string | null
  /** Desglose esperado por método de pago (solo métodos con ventas). */
  byMethod: {
    method: "CASH" | "CARD" | "MERCADOPAGO" | "TRANSFER" | "SALDO"
    expected: string
  }[]
}

/**
 * Tarea 9.2 — Venta por promotor (visión §2.8: "cuánto vendió cada promotor"). Espejo del shape
 * que devuelve `GET /events/:id/promoter-sales`: por promotor del tenant (entradas no canceladas
 * valuadas al precio del tipo + ventas de barra completadas valuadas por líneas al precio de
 * venta). El cierre (10.3) lo congela en `closingReport.byPromoter` — misma forma que la API.
 */
export type PromoterSalesRow = {
  id: string
  name: string
  phone: string | null
  isActive: boolean
  ticketsCount: number
  ticketRevenue: string
  barSalesCount: number
  barItemsCount: number
  barRevenue: string
  totalRevenue: string
}

/**
 * Liquidación congelada de la ceremonia de cierre (tarea 4.4). Todas las cifras monetarias van
 * como string decimal (misma convención que el resto de la API). `insumos` guarda el conteo real
 * vs. la estimación del sistema por insumo, para el reporte de merma. Ver `POST /events/:id/closing`.
 * `cashes` (10.1) reemplaza al `cash` único: un cierre por puesto/barra. `cash` se mantiene como
 * agregado a nivel evento por back-compat — los eventos cerrados antes de 10.1 no tienen `cashes`.
 * Los desgloses de 10.3 (`incomeBySource`, `incomeByMethod`, `salesByHour`, `topProducts`,
 * `barPerformance`, `byPromoter`) son snapshot congelado al cerrar — no rederivables — y todos
 * opcionales por back-compat: los eventos cerrados antes de 10.3 no los tienen.
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
  /** Tarea 10.1 — Cierres de caja por puesto/barra (vacío = sin cajas con efectivo). */
  cashes: CashClosingEntry[]
  /**
   * Tarea 10.2 — Pendiente de entrega (visión §2.8: "Cuánto vendiste y todavía no entregaste").
   * Tragos vendidos y NO retirados: `digital_consumptions` en PENDING al cerrar. `quantity` =
   * unidades sin canjear; `amount` = su valor al momento de la venta (plata cobrada que todavía
   * se debe). Snapshot congelado al cerrar — el canje posterior no lo altera.
   */
  pendingDelivery: { quantity: number; amount: string }
  /**
   * Tarea 10.3 — Ingresos por ORIGEN (visión §2.8: "cuánto entró, separado por entradas / tragos
   * / saldo"): `tickets` = entradas no canceladas valuadas al precio del tipo; `tragos` = ventas
   * de barra completadas valuadas por líneas (incluye los tragos pagados con saldo — son tragos
   * reales vendidos); `saldo` = cargas de saldo completadas (snapshot `kind: "deposit"` — plata
   * que entró de verdad, sin items de producto); `total` = la suma.
   */
  incomeBySource?: {
    tickets: string
    tragos: string
    saldo: string
    total: string
  }
  /**
   * Tarea 10.3 — Ingresos por MÉTODO de pago: ventas completadas agrupadas por método (incluye
   * las cargas de saldo por su método: un depósito en efectivo es efectivo que entró). SALDO
   * figura por transparencia pero no es plata nueva — es tragos pagados con saldo ya cargado.
   */
  incomeByMethod?: {
    method: "CASH" | "CARD" | "MERCADOPAGO" | "TRANSFER" | "SALDO"
    amount: string
  }[]
  /** Tarea 10.3 — Ventas completadas por hora (mismo shape que `analytics/dashboard`). */
  salesByHour?: { hour: number; label: string; revenue: number }[]
  /** Tarea 10.3 — Top productos por unidades vendidas (mismo shape que `bar-sales`). */
  topProducts?: { productName: string; quantitySold: number; revenue: string }[]
  /**
   * Tarea 10.3 — Rendimiento por barra/puesto, ordenado por recaudado desc. `barId` null =
   * "Puerta" (ventas sin puesto: caja de puerta, cargas de saldo en caja).
   */
  barPerformance?: {
    barId: string | null
    barName: string
    revenue: string
    salesCount: number
  }[]
  /** Tarea 10.3 — Ventas por promotor (mismo shape que `GET /events/:id/promoter-sales`). */
  byPromoter?: PromoterSalesRow[]
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
    /** Nombre visible del lugar, ej. "Salón del Puerto". */
    venue: varchar('venue', { length: 255 }),
    /** Dirección geográfica usada para el mapa y "Cómo llegar". */
    location: varchar('location', { length: 255 }),
    ticketsAvailableFrom: timestamp('tickets_available_from'),
    consumptionsAvailableFrom: timestamp('consumptions_available_from'),
    createdAt: timestamp('created_at').defaultNow(),
    imageUrl: varchar('image_url', { length: 512 }),
    /** Diseño de la página pública del evento. MINIMAL = clásico (default), GLASS = glassmorphism. */
    designType: mysqlEnum('design_type', ['GLASS', 'MINIMAL']).notNull().default('MINIMAL'),
    /**
     * Estado del ciclo de vida del evento. Fuente de verdad de la máquina de estados
     * (ver `backend/src/lib/event-status.ts`). Los valores DEBEN coincidir con
     * `EVENT_STATUSES` de ese módulo. Un evento nace en 'draft'.
     */
    status: mysqlEnum('status', ['draft', 'on_sale', 'live', 'closed']).notNull().default('draft'),
    /**
     * Tarea 1.3 — Reingreso (visión §2.4: "Si ya entró con esa entrada, avisa").
     * Si está activado, la puerta deja re-validar un ticket USED: `POST /tickets/validate`
     * registra otro pase IN en `gate_logs` y la respuesta avisa `reentry: true` (el scanner
     * muestra "Ya entró — reingreso" pero deja pasar). False (default) = una entrada entra
     * una sola vez y un ticket USED sigue dando 409.
     */
    allowReentry: boolean('allow_reentry').notNull().default(false),
    /**
     * Tarea 3.1 — Restricción de edad (visión §2.4: "Si el evento es +18, el DNI trae la fecha
     * de nacimiento y lo valida solo"). Edad mínima para entrar (ej. 18) o null = sin restricción.
     * El escáner de DNI del admin la usa para bloquear menores ANTES de validar el ticket.
     */
    ageRestriction: int('age_restriction'),
    /** Apertura PROGRAMADA: hora de puertas. Único trigger automático (on_sale → live). Null = sin programar. */
    doorsAt: timestamp('doors_at'),
    /** Efectiva: instante real en que la venta se abrió (draft → on_sale). */
    salesOpenedAt: timestamp('sales_opened_at'),
    /** Efectiva: instante real en que el evento pasó a En vivo (on_sale → live). */
    wentLiveAt: timestamp('went_live_at'),
    /** Efectiva: instante real en que el evento se cerró (live → closed). */
    closedAt: timestamp('closed_at'),
    /**
     * Tarea 8.2 — Idempotencia del recordatorio de WhatsApp (visión §2.3): el instante en que
     * el runner (`lib/jobs-runner.ts`) envió el mensaje "1 h antes" a los compradores del
     * evento. Null = todavía no se envió. El estado vive en DB (no en memoria): un restart
     * del servicio no re-envía el recordatorio.
     */
    whatsappReminderSentAt: timestamp('whatsapp_reminder_sent_at'),
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
    /**
     * Tarea 1.1 — Snapshot del DNI del comprador al emitir la entrada, para el lookup por DNI
     * en puerta SIN join a `customers` (índice `tickets_event_buyer_dni_idx`).
     */
    buyerDni: varchar('buyer_dni', { length: 20 }),
    customerId: varchar('customer_id', { length: 36 }).references(() => customers.id),
    /** Tarea 9.1 — Promotor que vendió esta entrada (venta manual/caja); null = venta directa. */
    promoterId: varchar('promoter_id', { length: 36 }).references(() => promoters.id),
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
    buyerDniIdx: index('tickets_event_buyer_dni_idx').on(table.eventId, table.buyerDni),
    promoterIdx: index('tickets_promoter_id_idx').on(table.promoterId),
  })
);

// -----------------------------------------------------------------------------
// 2.b ADMISIÓN (tarea 1.2) — registro de gente que no puede entrar
// -----------------------------------------------------------------------------

/**
 * Tarea 1.2 — Blacklist / registro de admisión (visión §2.4): "Si está en la lista de gente que
 * no puede entrar, avisa con el motivo y la foto". Keyed por DNI (la identidad en puerta): la
 * validación de una entrada (`POST /tickets/validate`) rechaza con motivo + foto cuando el
 * `buyer_dni` del ticket tiene una entrada ACTIVA. La foto se sube a R2 (`photo_url`).
 * Aditiva; un DNI puede tener varias filas (motivos distintos) — el chequeo usa cualquier
 * fila activa.
 */
export const admissionBlacklist = mysqlTable(
  'admission_blacklist',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    /** DNI de la persona — identidad en puerta (no necesita tener ticket). */
    dni: varchar('dni', { length: 20 }).notNull(),
    fullName: varchar('full_name', { length: 255 }),
    /** Foto de la persona (R2). Nullable: el alta no exige foto. */
    photoUrl: varchar('photo_url', { length: 512 }),
    /** Motivo de la entrada en la lista. Se muestra en puerta. */
    reason: varchar('reason', { length: 512 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** Staff que cargó la entrada. */
    createdBy: varchar('created_by', { length: 36 }).references(() => staff.id),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    eventTenantIdx: index('admission_blacklist_event_tenant_idx').on(table.eventId, table.tenantId),
    eventDniIdx: index('admission_blacklist_event_dni_idx').on(table.eventId, table.dni),
  })
);

// -----------------------------------------------------------------------------
// 2.c PUERTA (tarea 1.3) — reingreso y registro de pases
// -----------------------------------------------------------------------------

/**
 * Tarea 1.3 — Registro de pases de puerta (visión §2.4): "Si ya entró con esa entrada, avisa".
 * Cada pase (IN/OUT) de una entrada queda acá — NO altera el estado del ticket: es el detalle
 * de quién pasó, cuándo y con qué entrada, para el reingreso y el conteo de gente.
 * `POST /tickets/validate` registra el IN del primer ingreso (junto al USED) y, cuando el
 * evento tiene `allowReentry`, un ticket USED se re-valida registrando otro IN y devolviendo
 * `reentry: true`. El OUT lo registra el scanner al salir (`POST /tickets/out`). El conteo de
 * pases del ticket sale de contar las filas IN por `ticket_id`.
 */
export const gateLogs = mysqlTable(
  'gate_logs',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    ticketId: varchar('ticket_id', { length: 36 }).notNull().references(() => tickets.id),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    /** IN = ingreso (primer pase y cada reingreso), OUT = salida registrada desde el scanner. */
    action: mysqlEnum('action', ['IN', 'OUT']).notNull(),
    /** Staff que escaneó el pase. */
    scannedBy: varchar('scanned_by', { length: 36 }).references(() => staff.id),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    ticketIdx: index('gate_logs_ticket_idx').on(table.ticketId),
    eventTenantIdx: index('gate_logs_event_tenant_idx').on(table.eventId, table.tenantId),
  })
);

// Tarea 7.1 — Tragos de regalo de una cortesía: qué consumiciones emite el canje además de la
// entrada. `quantity` es por producto; el canje crea UNA `digitalConsumption` por unidad.
export type CourtesyDrinkLine = {
  productId: string
  quantity: number
}

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
    // DNI opcional: permite que la entrada emitida conserve la identidad del invitado y que
    // una cortesía pueda incluir saldo de regalo para esa misma persona.
    guestDni: varchar('guest_dni', { length: 20 }),
    // Token del link público de canje. Único.
    token: varchar('token', { length: 64 }).notNull().unique(),
    status: mysqlEnum('status', ['PENDING', 'REDEEMED', 'REVOKED']).notNull().default('PENDING'),
    // Entrada emitida al canjear. Null hasta que se canjea.
    ticketId: varchar('ticket_id', { length: 36 }).references(() => tickets.id),
    // Tragos de regalo (tarea 7.1): [{productId, quantity}] de consumiciones que el canje
    // emite además de la entrada. Null = invitación solo con entrada (como antes).
    drinkLines: json('drink_lines').$type<CourtesyDrinkLine[] | null>(),
    // Sale de $0 (source WEB, sin sale_items) que ancla las digital_consumptions de los tragos
    // de regalo (la FK `digital_consumptions.sale_id` es NOT NULL y el canje 1×1 en barra la
    // joinnea contra `sales`). La sale de $0 no aporta recaudación: el cierre suma
    // sale_items × precio y el total CASH. Null hasta que se canjea una cortesía con tragos.
    drinkSaleId: varchar('drink_sale_id', { length: 36 }).references(() => sales.id),
    redeemedAt: timestamp('redeemed_at'),
    // Última vez que se envió la invitación por email (tarea 7.3). Null = no enviada.
    inviteSentAt: timestamp('invite_sent_at'),
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
  /**
   * Tarea 6.1 — Discrimina el tipo de venta PENDING que cumple el webhook: `checkout` (default,
   * las sales viejas no lo tienen) = compra de entradas/tragos que emite tickets/consumos;
   * `deposit` = carga de saldo (visión §2.7) que acredita `customer_balances` en vez de emitir.
   */
  kind?: "checkout" | "deposit"
  ticketLines: { ticketTypeId: string; quantity: number }[]
  drinkLines: { productId: string; quantity: number }[]
  contact: { name: string; email: string; phone: string; dni?: string }
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
    /** Tarea 9.1 — Promotor que originó la venta (caja/POS); null = venta sin promotor. */
    promoterId: varchar('promoter_id', { length: 36 }).references(() => promoters.id),
    receiptToken: varchar('receipt_token', { length: 36 }).notNull().unique(),
    source: mysqlEnum('source', ['POS', 'APP', 'WEB']).notNull().default('POS'),
    totalAmount: decimal('total_amount', { precision: 10, scale: 2 }).notNull(),
    paymentMethod: mysqlEnum('payment_method', ['CASH', 'CARD', 'MERCADOPAGO', 'TRANSFER', 'SALDO']).notNull(),
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
    promoterIdx: index('sales_promoter_id_idx').on(table.promoterId),
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

// -----------------------------------------------------------------------------
// 4.c RETIRO EN BARRA (visión §2.5) — pedidos de retiro ("¿Qué te llevás ahora?")
// -----------------------------------------------------------------------------

export type PickupItemsJson = {
  consumptionId: string
  productId: string
  quantity: number
}[]

// Pedido de retiro (tarea 4.1/4.2): el cliente elige qué tragos comprados y no canjeados se
// lleva ahora, y el sistema le genera UN QR de pedido. La lista se guarda en `items_json`
// ([{consumptionId, productId, quantity}]) y la barra la lee con el token del QR: el canje en
// lote marca REDEEMED las consumiciones y descuenta stock una sola vez por producto.
// Lo no retirado sigue PENDING en `digital_consumptions` — un pedido nunca "gasta" tragos.
export const pickupOrders = mysqlTable(
  'pickup_orders',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    customerId: varchar('customer_id', { length: 36 }).notNull().references(() => customers.id),
    // Token del QR de pedido (el QR codifica este token). Único.
    token: varchar('token', { length: 64 }).notNull().unique(),
    status: mysqlEnum('status', ['PENDING', 'DELIVERED', 'CANCELLED']).notNull().default('PENDING'),
    // Consumiciones del pedido, agrupadas por producto. Orden estable (por consumptionId) para
    // poder comparar pedidos idénticos (idempotencia del POST /public/pickups).
    itemsJson: json('items_json').$type<PickupItemsJson>(),
    deliveredAt: timestamp('delivered_at'),
    deliveredBy: varchar('delivered_by', { length: 36 }).references(() => staff.id),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    eventTenantIdx: index('pickup_orders_event_tenant_idx').on(table.eventId, table.tenantId),
    customerIdx: index('pickup_orders_customer_idx').on(table.customerId),
    statusIdx: index('pickup_orders_status_idx').on(table.status),
  })
);

// -----------------------------------------------------------------------------
// 4.d SALDO (visión §2.7) — plata cargada dentro del evento, asociada al DNI
// -----------------------------------------------------------------------------

/**
 * Tarea 6.1 — Saldo vigente del cliente dentro de un evento (visión §2.7: "plata cargada dentro
 * del evento, asociada a su DNI"). Una fila por (customer, evento) — único. Se carga desde el
 * celular (WEB), en la caja física (CAJA) o de regalo por la productora (REGALO); se gasta al
 * pagar con saldo (CONSUMO). Cada movimiento queda en `balance_movements`; este saldo es la
 * suma de sus cargas menos sus gastos.
 */
export const customerBalances = mysqlTable(
  'customer_balances',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    customerId: varchar('customer_id', { length: 36 })
      .notNull()
      .references(() => customers.id),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    amount: decimal('amount', { precision: 10, scale: 2 }).notNull().default('0'),
    updatedAt: timestamp('updated_at').onUpdateNow(),
  },
  (table) => ({
    customerEventUnique: uniqueIndex('customer_balances_customer_event_unique').on(
      table.customerId,
      table.eventId
    ),
    eventTenantIdx: index('customer_balances_event_tenant_idx').on(table.eventId, table.tenantId),
  })
);

/**
 * Tarea 6.1 — Registro de cada movimiento de saldo (auditoría y reporte). `type` distingue el
 * origen: WEB (carga desde el celular, acreditada por webhook MP/Cucuru), CAJA (carga en
 * efectivo/tarjeta en la caja física), REGALO (cortesía de la productora, sin plata que entre)
 * y CONSUMO (gasto al pagar con saldo). `paymentMethod` es el medio de la carga (null en REGALO)
 * y `saleId` ata el movimiento a la venta que lo originó.
 */
export const balanceMovements = mysqlTable(
  'balance_movements',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    customerId: varchar('customer_id', { length: 36 })
      .notNull()
      .references(() => customers.id),
    eventId: varchar('event_id', { length: 36 }).notNull().references(() => events.id),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    type: mysqlEnum('type', ['WEB', 'CAJA', 'REGALO', 'CONSUMO']).notNull(),
    paymentMethod: mysqlEnum('payment_method', ['CASH', 'CARD', 'MERCADOPAGO', 'TRANSFER', 'SALDO']),
    amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
    staffId: varchar('staff_id', { length: 36 }).references(() => staff.id),
    saleId: varchar('sale_id', { length: 36 }).references(() => sales.id),
    note: varchar('note', { length: 255 }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    customerEventIdx: index('balance_movements_customer_event_idx').on(
      table.customerId,
      table.eventId
    ),
    eventTenantIdx: index('balance_movements_event_tenant_idx').on(table.eventId, table.tenantId),
  })
);

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

// Invitación de staff (spec §1): el administrador define nombre y rol y comparte un link o QR.
// Cada fila es un link nominado dentro del tenant; el primer acceso crea una fila en `staff`
// y los accesos posteriores vuelven a iniciar sesión con ese mismo link, sin nombre ni PIN.
// Usa email/hash sintéticos para respetar las columnas NOT NULL y queda enlazada por
// `accepted_staff_id`. Aditiva: no toca `staff` ni datos existentes.
export const staffInvitations = mysqlTable(
  'staff_invitations',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id),
    role: mysqlEnum('role', ['ADMIN', 'MANAGER', 'BARTENDER', 'SECURITY']).notNull(),
    // Datos del destinatario: permiten identificar la invitación y enviarla por WhatsApp.
    inviteeName: varchar('invitee_name', { length: 255 }),
    inviteePhone: varchar('invitee_phone', { length: 32 }),
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
