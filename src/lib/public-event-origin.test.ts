import { expect, test } from "bun:test"
import { publicEventOrigin, publicEventApiPath } from "./public-event-origin"

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
