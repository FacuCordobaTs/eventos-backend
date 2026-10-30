import { eventSlugFromHostname } from "./event-domain"

/** Event hosts may call public APIs; they do not acquire access to staff APIs. */
export function publicEventOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === "https:" && url.port === "" &&
      url.origin === origin && url.hostname.endsWith(".crow.ar") &&
      eventSlugFromHostname(url.hostname) !== null
  } catch {
    return false
  }
}

export function publicEventApiPath(path: string): boolean {
  return path.startsWith("/public/") || path === "/api/mp/process-brick"
}

/**
 * A dónde vuelve el navegador después de pagar: al mismo host desde el que se compró (la página
 * propia del evento o la tienda de Crow), así conserva lo que el teléfono guardó en ese origen.
 * Sólo se aceptan los hosts de evento ya validados; cualquier otro origen vuelve a la tienda.
 */
export function clientReturnOrigin(origin: string | null | undefined): string {
  return origin && publicEventOrigin(origin) ? origin : "https://crow.ar"
}
