type MpOAuthEnv = {
  MP_CLIENT_ID?: string
  MP_CLIENT_SECRET?: string
  MP_REDIRECT_URI?: string
}

/** Una sola configuración para autorizar y para intercambiar el código. */
export function getMpOAuthConfig(env: MpOAuthEnv = process.env) {
  const clientId = env.MP_CLIENT_ID?.trim()
  const clientSecret = env.MP_CLIENT_SECRET?.trim()
  const redirectUri = env.MP_REDIRECT_URI?.trim()
  if (!clientId || !/^\d+$/.test(clientId)) {
    throw new Error("MP_CLIENT_ID debe ser el ID numérico de la aplicación")
  }
  if (!clientSecret) throw new Error("MP_CLIENT_SECRET no configurado")
  if (!redirectUri) throw new Error("MP_REDIRECT_URI no configurado")
  let redirect: URL
  try {
    redirect = new URL(redirectUri)
  } catch {
    throw new Error("MP_REDIRECT_URI debe ser una URL absoluta")
  }
  if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash) {
    throw new Error("MP_REDIRECT_URI debe usar HTTPS, sin credenciales ni fragmento")
  }
  // Conservar el texto exacto: MP lo compara con la URL registrada.
  return { clientId, clientSecret, redirectUri }
}

export function buildMpAuthorizationUrl(
  tenantId: string,
  config: Pick<ReturnType<typeof getMpOAuthConfig>, "clientId" | "redirectUri">
) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    platform_id: "mp",
    state: tenantId,
    redirect_uri: config.redirectUri,
  })
  return `https://auth.mercadopago.com.ar/authorization?${params}`
}

/** La sesión del proveedor vive en el navegador, aunque Crow borre sus tokens. */
export function buildMpConnectionUrl(
  tenantId: string,
  config: Pick<ReturnType<typeof getMpOAuthConfig>, "clientId" | "redirectUri">
) {
  const params = new URLSearchParams({
    go: buildMpAuthorizationUrl(tenantId, config),
  })
  // Mercado Pago comparte el servicio de sesión de Mercado Libre. El logout
  // en mercadopago.com.ar devuelve una página inexistente; usar el servicio central.
  return `https://www.mercadolibre.com/jms/mla/lgz/logout?${params}`
}
