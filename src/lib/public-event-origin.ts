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
