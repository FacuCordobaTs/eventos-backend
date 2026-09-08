import { describe, expect, test } from "bun:test"
import { buildMpAuthorizationUrl, getMpOAuthConfig } from "./mp-oauth-config"

const env = {
  MP_CLIENT_ID: "123456789",
  MP_CLIENT_SECRET: "test-secret-only",
  MP_REDIRECT_URI: "https://api.crow.ar/api/mp/callback",
}

describe("Configuración OAuth de Mercado Pago", () => {
  test("el enlace usa la misma configuración que el intercambio, sin exponer secretos", () => {
    const config = getMpOAuthConfig(env)
    const url = new URL(buildMpAuthorizationUrl("tenant-a", config))
    expect(url.origin).toBe("https://auth.mercadopago.com.ar")
    expect(url.searchParams.get("client_id")).toBe(config.clientId)
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri)
    expect(url.searchParams.get("state")).toBe("tenant-a")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("platform_id")).toBe("mp")
    expect(url.toString()).not.toContain(env.MP_CLIENT_SECRET)
  })

  test("respeta cambios del servidor sin un nuevo build del frontend", () => {
    const config = getMpOAuthConfig({ ...env, MP_CLIENT_ID: "987654321", MP_REDIRECT_URI: "https://api.example.com/oauth/callback" })
    const url = new URL(buildMpAuthorizationUrl("tenant-b", config))
    expect(url.searchParams.get("client_id")).toBe("987654321")
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.com/oauth/callback")
  })

  test("quita espacios de configuración sin normalizar la URL registrada", () => {
    const config = getMpOAuthConfig({ ...env, MP_CLIENT_ID: " 123456789 ", MP_REDIRECT_URI: " https://api.crow.ar:443/api/mp/callback/ " })
    expect(config.clientId).toBe("123456789")
    expect(config.redirectUri).toBe("https://api.crow.ar:443/api/mp/callback/")
  })

  test.each(["MP_CLIENT_ID", "MP_CLIENT_SECRET", "MP_REDIRECT_URI"] as const)("rechaza %s vacío antes de redirigir", (key) => {
    expect(() => getMpOAuthConfig({ ...env, [key]: " " })).toThrow(key)
  })

  test("rechaza una public key usada como ID de aplicación", () => {
    expect(() => getMpOAuthConfig({ ...env, MP_CLIENT_ID: "APP_USR-123" })).toThrow("MP_CLIENT_ID")
  })

  test.each(["/api/mp/callback", "http://api.crow.ar/api/mp/callback", "https://user:pass@api.crow.ar/callback", "https://api.crow.ar/callback#fragment"])("rechaza redirect inválido: %s", (redirectUri) => {
    expect(() => getMpOAuthConfig({ ...env, MP_REDIRECT_URI: redirectUri })).toThrow("MP_REDIRECT_URI")
  })
})
