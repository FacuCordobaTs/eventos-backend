/**
 * Tarea 8.1 — Proveedor de WhatsApp (visión §2.3).
 *
 * Abstracción de envío sobre la **Meta WhatsApp Cloud API** (Graph API v21.0).
 * Cada productora guarda sus credenciales por tenant (mismo patrón que Cucuru):
 * System User Access Token + ID del número de WhatsApp Business. Los templates se
 * aprueban en Meta Business Manager:
 *   - `crow_prueba`       (MARKETING, es_AR) — mensaje de prueba desde Configuración.
 *   - `crow_recordatorio` (MARKETING, es_AR) — recordatorio 1 h antes (tarea 8.2),
 *     cuerpo: {{1}} nombre, {{2}} nombre del evento; botón URL dinámico índice 0:
 *     "Ir al evento". El link no forma parte del texto del mensaje.
 *
 * Si mañana se muda a Twilio, se reemplaza la implementación de este archivo sin
 * tocar los callers: las firmas de `validateWhatsAppConnection` y
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

export type WhatsAppConnectionInfo = {
  ok: boolean
  displayPhone?: string
  verifiedName?: string
  qualityRating?: string
  error?: string
}

/**
 * Valida las credenciales contra Meta consultando los datos del número de teléfono.
 * Es la prueba real de conexión: token inválido, sin permisos o ID inexistente
 * fallan acá, antes de guardar la config en el tenant.
 */
export async function validateWhatsAppConnection(
  token: string,
  phoneNumberId: string
): Promise<WhatsAppConnectionInfo> {
  try {
    const url = `${GRAPH_API_BASE}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { ok: false, error: extractGraphErrorMessage(body) || `http_${res.status}` }
    }
    const data = (await res.json()) as {
      display_phone_number?: string
      verified_name?: string
      quality_rating?: string
    }
    return {
      ok: true,
      displayPhone: data.display_phone_number,
      verifiedName: data.verified_name,
      qualityRating: data.quality_rating,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown_error" }
  }
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

export async function sendWhatsAppTemplateMessage(input: {
  token: string
  phoneNumberId: string
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
  try {
    const url = `${GRAPH_API_BASE}/${input.phoneNumberId}/messages`
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
        Authorization: `Bearer ${input.token}`,
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
