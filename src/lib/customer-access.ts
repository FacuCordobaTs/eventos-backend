import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import type { MySql2Database } from "drizzle-orm/mysql2"
import { createHash, randomInt, timingSafeEqual } from "crypto"
import { v4 as uuidv4 } from "uuid"
import { customerAccessCodes, customers } from "../db/schema"
import { createAccessToken } from "./jwt"
import {
  CUSTOMER_AUTH_TEMPLATE,
  normalizeWhatsAppPhone,
  sendWhatsAppTemplateMessage,
} from "./whatsapp-service"

/** El `drizzle(pool)` sin schema que usan las rutas públicas. */
type Db = MySql2Database<Record<string, never>>

/** Vida del código. Corta a propósito: se pide y se usa parado en la barra. */
const CODE_TTL_MS = 10 * 60 * 1000
/** Intentos fallidos antes de quemar el código. */
const MAX_ATTEMPTS = 5
/** El cliente queda logueado en su teléfono este tiempo (sesión persistente). */
export const CUSTOMER_SESSION_TTL = "30d" as const

// -----------------------------------------------------------------------------
// Helpers puros
// -----------------------------------------------------------------------------

export type AccessIdentifier = {
  kind: "dni" | "phone"
  /** DNI en dígitos, o celular normalizado al formato de WhatsApp. */
  value: string
  /** Variantes contra las que comparar `customers.phone`, que guarda lo que cargó cada flujo. */
  candidates: string[]
}

/**
 * Interpreta lo que el cliente escribió en un solo campo. El DNI argentino tiene 7 u 8 dígitos y
 * un celular sin prefijo ya tiene 10, así que el largo alcanza para distinguirlos; 9 dígitos es
 * ambiguo y se rechaza en vez de adivinar.
 */
export function normalizeIdentifier(raw: string): AccessIdentifier | null {
  const digits = raw.replace(/\D/g, "")
  if (digits.length >= 6 && digits.length <= 8) {
    return { kind: "dni", value: digits, candidates: [digits] }
  }
  if (digits.length >= 10 && digits.length <= 15) {
    const normalized = normalizeWhatsAppPhone(digits)
    if (!normalized) return null
    const candidates = [...new Set([raw.trim(), digits, normalized])]
    return { kind: "phone", value: normalized, candidates }
  }
  return null
}

/** "Te enviamos un código al +54 9 •••• 1234": alcanza para reconocer el teléfono, no para filtrarlo. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "")
  if (digits.length < 4) return "••••"
  const country = digits.startsWith("54") ? "+54 9 " : ""
  return `${country}•••• ${digits.slice(-4)}`
}

/**
 * sha256 del código con el id de la fila como sal (es un UUID aleatorio, así que el hash no es
 * precomputable). Un código de 6 dígitos con TTL corto, tope de intentos y rate limiting no
 * necesita un KDF lento.
 */
export function hashCode(code: string, id: string): string {
  return createHash("sha256").update(`${code}${id}`).digest("hex")
}

function codeMatches(code: string, id: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashCode(code, id), "hex")
  const expected = Buffer.from(expectedHash, "hex")
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

export function generateCode(): string {
  return String(randomInt(100000, 1000000))
}

// -----------------------------------------------------------------------------
// Pedir el código
// -----------------------------------------------------------------------------

export type AccessWhatsAppConfig = {
  enabled: boolean
  token: string | null
  phoneNumberId: string | null
}

export type RequestAccessInput = {
  eventId: string
  tenantId: string
  whatsapp: AccessWhatsAppConfig
  identifier: AccessIdentifier
  /** Celular que ingresa el cliente cuando su ficha no tiene uno, o en el alta rápida. */
  phone?: string | null
  /** Nombre que ingresa el cliente en el alta rápida. */
  name?: string | null
}

export type RequestAccessResult =
  | { ok: true; challenge: string; to: string }
  | {
      ok: false
      /** `NEEDS_*` le pide un dato más al cliente; el resto es un fallo de envío. */
      reason: "NEEDS_PHONE" | "NEEDS_REGISTRATION" | "WHATSAPP_UNAVAILABLE" | "SEND_FAILED"
      error: string
    }

async function findCustomerByIdentifier(db: Db, identifier: AccessIdentifier) {
  const [row] = await db
    .select()
    .from(customers)
    .where(
      identifier.kind === "dni"
        ? eq(customers.dni, identifier.value)
        : inArray(customers.phone, identifier.candidates)
    )
    .limit(1)
  return row
}

/**
 * Resuelve a quién mandarle el código y lo manda. No crea clientes: el alta rápida se concreta
 * recién al verificar, así un DNI que se escribe y nunca se confirma no deja una ficha huérfana.
 */
export async function requestAccessCode(
  db: Db,
  input: RequestAccessInput
): Promise<RequestAccessResult> {
  const { identifier } = input
  const customer = await findCustomerByIdentifier(db, identifier)

  const typedPhone = input.phone?.trim()
    ? normalizeWhatsAppPhone(input.phone)
    : null

  let to: string
  let pendingName: string | null = null
  let pendingDni: string | null = null

  if (!customer) {
    // Alta rápida: nadie con ese documento/teléfono. Necesitamos nombre y celular para poder
    // verificar algo y para que la ficha no quede sin nombre.
    if (!typedPhone || !input.name?.trim()) {
      return {
        ok: false,
        reason: "NEEDS_REGISTRATION",
        error: "No encontramos tus datos. Completá tu nombre y tu celular.",
      }
    }
    to = typedPhone
    pendingName = input.name.trim().slice(0, 255)
    pendingDni = identifier.kind === "dni" ? identifier.value : null
  } else if (!customer.phone) {
    // Ficha creada en caja solo con DNI: no hay a dónde mandar nada. El celular que ingrese acá
    // se guarda recién al verificar el código y nunca pisa un celular ya existente (por eso este
    // camino sólo se abre cuando `phone` es null).
    if (!typedPhone) {
      return {
        ok: false,
        reason: "NEEDS_PHONE",
        error: "Tu cuenta no tiene un celular asociado. Ingresá el tuyo para verificarlo.",
      }
    }
    to = typedPhone
  } else {
    to = normalizeWhatsAppPhone(customer.phone) ?? customer.phone
  }

  if (!input.whatsapp.enabled || !input.whatsapp.token || !input.whatsapp.phoneNumberId) {
    return {
      ok: false,
      reason: "WHATSAPP_UNAVAILABLE",
      error: "La productora no tiene WhatsApp configurado. Podés cargar saldo en la caja.",
    }
  }

  const challenge = uuidv4()
  const code = generateCode()
  const now = new Date()

  // Un solo código activo por destino y evento: el anterior se quema al pedir uno nuevo.
  await db
    .update(customerAccessCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(customerAccessCodes.eventId, input.eventId),
        eq(customerAccessCodes.phone, to),
        isNull(customerAccessCodes.consumedAt)
      )
    )

  await db.insert(customerAccessCodes).values({
    id: challenge,
    customerId: customer?.id ?? null,
    eventId: input.eventId,
    tenantId: input.tenantId,
    pendingName,
    pendingDni,
    phone: to,
    codeHash: hashCode(code, challenge),
    attempts: 0,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    createdAt: now,
  })

  let sent: { ok: boolean; error?: string } = { ok: false }
  try {
    sent = await sendWhatsAppTemplateMessage({
      token: input.whatsapp.token,
      phoneNumberId: input.whatsapp.phoneNumberId,
      to,
      templateName: CUSTOMER_AUTH_TEMPLATE,
      bodyParameters: [code],
      // El botón "copiar código" es una URL de Meta; el mismo código va como su parámetro.
      urlButton: { parameter: code, index: 0 },
    })
  } catch (error) {
    console.error("[customer-access] no se pudo enviar el código", error)
  }

  if (!sent.ok) {
    // Un código que no llegó no debe poder usarse: se quema y el cliente reintenta.
    await db
      .update(customerAccessCodes)
      .set({ consumedAt: new Date() })
      .where(eq(customerAccessCodes.id, challenge))
    if (sent.error) console.error("[customer-access] WhatsApp rechazó el mensaje", sent.error)
    return {
      ok: false,
      reason: "SEND_FAILED",
      error: "No pudimos enviarte el código. Intentá de nuevo o cargá saldo en la caja.",
    }
  }

  return { ok: true, challenge, to: maskPhone(to) }
}

// -----------------------------------------------------------------------------
// Verificar el código
// -----------------------------------------------------------------------------

export type VerifyAccessResult =
  | { ok: true; token: string; customerId: string; name: string }
  | {
      ok: false
      reason: "INVALID" | "EXPIRED" | "CONFLICT" | "INACTIVE"
      error: string
    }

/**
 * Canjea el código por una sesión de cliente. El celular pendiente (ficha sin teléfono, o alta
 * rápida) se persiste acá adentro, en la misma transacción que consume el código: hasta que el
 * código no se verifica, ese celular no toca `customers`.
 */
export async function verifyAccessCode(
  db: Db,
  input: { challenge: string; code: string }
): Promise<VerifyAccessResult> {
  const [row] = await db
    .select()
    .from(customerAccessCodes)
    .where(
      and(eq(customerAccessCodes.id, input.challenge), isNull(customerAccessCodes.consumedAt))
    )
    .limit(1)

  if (!row) return { ok: false, reason: "INVALID", error: "El código no es válido." }
  if (row.expiresAt.getTime() <= Date.now()) {
    await db
      .update(customerAccessCodes)
      .set({ consumedAt: new Date() })
      .where(eq(customerAccessCodes.id, row.id))
    return { ok: false, reason: "EXPIRED", error: "El código venció. Pedí uno nuevo." }
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: "INVALID", error: "Demasiados intentos. Pedí un código nuevo." }
  }

  // El intento se cuenta antes de comparar: así insistir con el mismo código no reinicia nada ni
  // permite adivinar en paralelo.
  await db
    .update(customerAccessCodes)
    .set({ attempts: sql`${customerAccessCodes.attempts} + 1` })
    .where(eq(customerAccessCodes.id, row.id))

  if (!codeMatches(input.code.trim(), row.id, row.codeHash)) {
    return { ok: false, reason: "INVALID", error: "El código no es válido." }
  }

  try {
    return await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(customerAccessCodes)
        .where(
          and(eq(customerAccessCodes.id, row.id), isNull(customerAccessCodes.consumedAt))
        )
        .for("update")
        .limit(1)

      if (!locked) {
        return { ok: false as const, reason: "INVALID" as const, error: "El código ya se usó." }
      }

      await tx
        .update(customerAccessCodes)
        .set({ consumedAt: new Date() })
        .where(eq(customerAccessCodes.id, locked.id))

      let customerId = locked.customerId
      if (!customerId) {
        // Alta rápida: el DNI no existía cuando se pidió el código. Se revalida acá adentro
        // porque en el medio la persona pudo comprar una entrada y aparecer en `customers` — en
        // ese caso se aborta (el reintento ya le manda el código al celular de su ficha) en vez
        // de pisarle el teléfono. Deliberadamente no usa `findOrCreateCustomer`: su update asigna
        // el celular entrante sobre una ficha existente, que es justo lo que no queremos.
        if (locked.pendingDni) {
          const [existing] = await tx
            .select({ id: customers.id })
            .from(customers)
            .where(eq(customers.dni, locked.pendingDni))
            .limit(1)
          if (existing) {
            return {
              ok: false as const,
              reason: "CONFLICT" as const,
              error: "Encontramos una compra tuya recién ahora. Volvé a pedir el código.",
            }
          }
        }

        customerId = uuidv4()
        await tx.insert(customers).values({
          id: customerId,
          name: locked.pendingName?.trim() || "Invitado",
          // Email sintético, como la caja (`pos-{dni}@crow.local`): `customers.email` es NOT NULL
          // y único, y `isDeliverableEmail` filtra este dominio para que nunca salga un mail.
          email: `acceso-${locked.pendingDni ?? customerId}@crow.local`,
          phone: locked.phone,
          ...(locked.pendingDni ? { dni: locked.pendingDni } : {}),
          isActive: true,
          createdAt: new Date(),
        })
      }

      const [customer] = await tx
        .select({
          id: customers.id,
          name: customers.name,
          phone: customers.phone,
          isActive: customers.isActive,
        })
        .from(customers)
        .where(eq(customers.id, customerId))
        .limit(1)

      if (!customer || customer.isActive === false) {
        return { ok: false as const, reason: "INACTIVE" as const, error: "Tu cuenta no está activa." }
      }

      // Guarda clave: sólo se completa un celular que no existía. Si la ficha ya tiene uno, el
      // que se escribió en el link no la toca.
      if (!customer.phone) {
        await tx
          .update(customers)
          .set({ phone: locked.phone })
          .where(eq(customers.id, customerId))
      }

      return {
        ok: true as const,
        token: await createAccessToken(customerId, "customer", CUSTOMER_SESSION_TTL),
        customerId,
        // Para saludar en el drawer sin un request extra: no es un dato sensible para quien acaba
        // de acreditar el celular de la ficha.
        name: customer.name,
      }
    })
  } catch (error) {
    console.error("[customer-access] no se pudo verificar el código", error)
    return { ok: false, reason: "INVALID", error: "No pudimos verificar el código." }
  }
}
