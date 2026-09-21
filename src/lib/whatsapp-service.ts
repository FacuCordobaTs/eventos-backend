/**
 * Tarea 8.1 — Proveedor de WhatsApp (visión §2.3).
 *
 * Abstracción de envío sobre la **Meta WhatsApp Cloud API** (Graph API v21.0).
 * Las credenciales son **de la plataforma y viven en el `.env` del VPS**
 * (`WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`): las productoras no cargan
 * las suyas, así que todos los tenants salen por el mismo número de WhatsApp Business.
 * Si faltan esas variables, el envío queda apagado para toda la plataforma. Los
 * templates se aprueban una sola vez en el Meta Business Manager de Crow:
 *   - `crow_prueba`       (MARKETING, es_AR) — mensaje de prueba desde Configuración.
 *   - `crow_recordatorio` (MARKETING, es_AR) — recordatorio 1 h antes (tarea 8.2),
 *     cuerpo: {{1}} nombre, {{2}} nombre del evento; botón URL dinámico índice 0:
 *     "Ir al evento". El link no forma parte del texto del mensaje.
 *   - `crow_acceso_perfil` (UTILITY, es_AR) — link al perfil del cliente, con botón URL
 *     dinámico "Ver mis eventos".
 *   - `crow_codigo_acceso` (AUTHENTICATION, es_AR) — código de 6 dígitos para entrar con
 *     DNI o celular desde el link por evento; botón "copiar código" de Meta, que se
 *     completa con el mismo código que el cuerpo.
 *
 * Si mañana se muda a Twilio, se reemplaza la implementación de este archivo sin
 * tocar los callers: las firmas de `isWhatsAppConfigured` y
 * `sendWhatsAppTemplateMessage` no cambian.
 */

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0"

/** Template aprobado para el recordatorio de puertas (tarea 8.2). */
export const REMINDER_TEMPLATE = "crow_recordatorio"
/** Template del mensaje de prueba desde Configuración. */
export const TEST_TEMPLATE = "crow_prueba"
/**
 * Template UTILITY `crow_acceso_perfil` (es_AR): cuerpo con {{1}} = nombre y botón URL
 * dinámico "Ver mis eventos" configurado como `https://crow.ar/{{1}}`.
 */
export const CUSTOMER_PROFILE_TEMPLATE = "crow_acceso_perfil"
/**
 * Template AUTHENTICATION `crow_codigo_acceso` (es_AR): cuerpo con {{1}} = código de 6 dígitos y
 * botón "copiar código" (que Meta resuelve con su propia URL, por eso el mismo valor va también
 * como parámetro del botón). Es el que usa el acceso de cliente por DNI/celular desde el link por
 * evento. Tiene que estar aprobado en WhatsApp Manager con la categoría AUTHENTICATION.
 */
export const CUSTOMER_AUTH_TEMPLATE = "crow_codigo_acceso"

/**
 * Normaliza un número argentino a formato internacional de WhatsApp (sin +):
 * "1155555555" → "5491155555555"; "541155555555" → "5491155555555";
 * "+54 9 11 5555-5555" → "5491155555555".
 */
export function normalizeWhatsAppPhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "")
  if (!digits) return null
  if (digits.startsWith("00")) digits = digits.slice(2)
  if (digits.startsWith("54")) {
    // 54 9 11 … (ok) o 54 11 … (falta el 9 de celular)
    if (digits.length > 2 && digits[2] !== "9") {
      digits = digits.slice(0, 2) + "9" + digits.slice(2)
    }
  } else {
    digits = "549" + digits
  }
  return digits
}

/**
 * Credenciales del número de WhatsApp Business de la plataforma. `WHATSAPP_PHONE` es sólo
 * informativo: el número visible que Configuración le muestra a la productora.
 */
export type WhatsAppPlatformConfig = {
  token: string
  phoneNumberId: string
  phone: string | null
}

/**
 * Lee las credenciales del entorno. `null` significa que el envío no está disponible para
 * nadie (falta el `.env` del VPS); es el único interruptor de WhatsApp que queda.
 */
export function getWhatsAppPlatformConfig(): WhatsAppPlatformConfig | null {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim()
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim()
  if (!token || !phoneNumberId) return null
  return { token, phoneNumberId, phone: process.env.WHATSAPP_PHONE?.trim() || null }
}

/** ¿Está configurado el número de la plataforma? Es la condición que habilita todo envío. */
export function isWhatsAppConfigured(): boolean {
  return getWhatsAppPlatformConfig() !== null
}

export type SendTemplateResult = { ok: boolean; messageId?: string; error?: string }

type WhatsAppTemplateComponent =
  | {
      type: "body"
      parameters: { type: "text"; text: string }[]
    }
  | {
      type: "button"
      sub_type: "url"
      index: string
      parameters: [{ type: "text"; text: string }]
    }

/**
 * Manda un template aprobado. Las credenciales salen del entorno: ningún caller las pasa ni
 * puede mandar por un número distinto al de la plataforma.
 */
export async function sendWhatsAppTemplateMessage(input: {
  to: string
  templateName: string
  language?: string
  /** Parámetros del cuerpo del template, en orden. Cada uno se manda como texto. */
  bodyParameters?: string[]
  /**
   * Parte dinámica del botón URL del template. Meta concatena este valor a la URL base
   * configurada en WhatsApp Manager (por ejemplo `https://crow.ar/{{1}}`).
   */
  urlButton?: { parameter: string; index?: number }
}): Promise<SendTemplateResult> {
  const config = getWhatsAppPlatformConfig()
  if (!config) return { ok: false, error: "whatsapp_not_configured" }
  try {
    const url = `${GRAPH_API_BASE}/${config.phoneNumberId}/messages`
    const components: WhatsAppTemplateComponent[] = []
    if (input.bodyParameters && input.bodyParameters.length > 0) {
      components.push({
        type: "body",
        parameters: input.bodyParameters.map((text) => ({ type: "text", text })),
      })
    }
    if (input.urlButton) {
      components.push({
        type: "button",
        sub_type: "url",
        index: String(input.urlButton.index ?? 0),
        parameters: [{ type: "text", text: input.urlButton.parameter }],
      })
    }

    const body = {
      messaging_product: "whatsapp",
      to: normalizeWhatsAppPhone(input.to) ?? input.to,
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.language ?? "es_AR" },
        ...(components.length > 0 ? { components } : {}),
      },
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      return { ok: false, error: extractGraphErrorMessage(errBody) || `http_${res.status}` }
    }
    const data = (await res.json()) as { messages?: { id?: string }[] }
    return { ok: true, messageId: data.messages?.[0]?.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown_error" }
  }
}

/** Extrae el `message` del body de error de la Graph API (si es JSON) o recorta el texto crudo. */
function extractGraphErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    return parsed.error?.message?.slice(0, 300) ?? ""
  } catch {
    return body.slice(0, 300)
  }
}
