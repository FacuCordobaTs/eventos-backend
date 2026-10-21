/** DNS labels used by event pages; infrastructure names keep their existing sites. */
const RESERVED = new Set(["www", "admin", "api", "mail", "smtp", "imap", "pop", "ftp", "cdn", "assets", "static", "status", "support", "docs", "autodiscover", "autoconfig", "dev", "staging"])

export function isEventSubdomain(slug: string): boolean {
  return slug.length >= 2 && slug.length <= 63 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && !RESERVED.has(slug)
}

export function eventSlugFromHostname(hostname: string): string | null {
  const host = hostname.toLowerCase()
  const suffix = host.endsWith(".localhost") ? ".localhost" : ".crow.ar"
  if (!host.endsWith(suffix)) return null
  const slug = host.slice(0, -suffix.length)
  return isEventSubdomain(slug) ? slug : null
}
