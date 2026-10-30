import { expect, test } from "bun:test"
import { clientReturnOrigin, publicEventOrigin, publicEventApiPath } from "./public-event-origin"

test("CORS accepts only HTTPS event origins on the platform domain", () => {
  expect(publicEventOrigin("https://dripeo.crow.ar")).toBe(true)
  for (const origin of ["null", "https://evil.com", "https://dripeo.crow.ar.evil.com", "https://a.b.crow.ar", "http://dripeo.crow.ar", "https://dripeo.crow.ar:8443", "https://admin.crow.ar", "https://dripeo.localhost", "https://dripeo.crow.ar/path", "https://user@dripeo.crow.ar"]) {
    expect(publicEventOrigin(origin)).toBe(false)
  }
})

test("event hosts can use checkout payments but not staff or MP administration", () => {
  expect(publicEventApiPath("/public/events/dripeo")).toBe(true)
  expect(publicEventApiPath("/api/mp/process-brick")).toBe(true)
  for (const path of ["/events", "/staff", "/api/mp/disconnect", "/api/mp/auth-url", "/api/mp/status"]) {
    expect(publicEventApiPath(path)).toBe(false)
  }
})

test("el retorno del pago sólo vuelve a hosts de evento validados", () => {
  expect(clientReturnOrigin("https://perronegro3110.crow.ar")).toBe("https://perronegro3110.crow.ar")
  expect(clientReturnOrigin("https://crow.ar")).toBe("https://crow.ar")
  for (const origin of ["https://admin.crow.ar", "https://api.crow.ar", "https://evil.example", "http://perronegro3110.crow.ar", "", null, undefined]) {
    expect(clientReturnOrigin(origin)).toBe("https://crow.ar")
  }
})
