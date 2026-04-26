import { drizzle } from "drizzle-orm/mysql2"
import { eq } from "drizzle-orm"
import { pool } from "../db"
import { tenants } from "../db/schema"

const MP_OAUTH_TOKEN_URL = "https://api.mercadopago.com/oauth/token"
const MP_USERS_ME_URL = "https://api.mercadopago.com/users/me"

type MpTokenResponse = {
  access_token?: string
  refresh_token?: string
  public_key?: string
  user_id?: number | string
}

function mpClientId(): string {
  const v = process.env.MP_CLIENT_ID
  if (!v) throw new Error("MP_CLIENT_ID no configurado")
  return v
}

function mpClientSecret(): string {
  const v = process.env.MP_CLIENT_SECRET
  if (!v) throw new Error("MP_CLIENT_SECRET no configurado")
  return v
}

async function postMpOAuth(body: URLSearchParams): Promise<Response> {
  return fetch(MP_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  })
}

async function parseJson(res: Response): Promise<MpTokenResponse | null> {
  try {
    return (await res.json()) as MpTokenResponse
  } catch {
    return null
  }
}

/**
 * Intercambia el refresh token por nuevos tokens y persiste en el tenant.
 * Si MP responde 400/401, marca `mp_connected` en false (scope por `eq(tenants.id, tenantId)`).
 */
export async function refrescarTokenTenant(
  tenantId: string,
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string } | null> {
  const db = drizzle(pool)

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: mpClientId(),
    client_secret: mpClientSecret(),
    refresh_token: refreshToken,
  })

  const res = await postMpOAuth(body)

  if (res.status === 400 || res.status === 401) {
    await db
      .update(tenants)
      .set({ mpConnected: false, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId))
    return null
  }

  if (!res.ok) {
    return null
  }

  const data = await parseJson(res)
  const accessToken = data?.access_token
  const newRefresh = data?.refresh_token ?? refreshToken
  if (!accessToken) {
    return null
  }

  const publicKey =
    typeof data?.public_key === "string" ? data.public_key : undefined
  const userIdRaw = data?.user_id
  const mpUserId =
    userIdRaw !== undefined && userIdRaw !== null
      ? String(userIdRaw)
      : undefined

  await db
    .update(tenants)
    .set({
      mpAccessToken: accessToken,
      mpRefreshToken: newRefresh,
      ...(publicKey !== undefined ? { mpPublicKey: publicKey } : {}),
      ...(mpUserId !== undefined ? { mpUserId } : {}),
      mpConnected: true,
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId))

  return { accessToken, refreshToken: newRefresh }
}

/**
 * Devuelve un access_token válido para el tenant, refrescando con `/oauth/token` si `/users/me` falla.
 */
export async function obtenerTokenValido(tenantId: string): Promise<string | null> {
  const db = drizzle(pool)

  const [row] = await db
    .select({
      mpAccessToken: tenants.mpAccessToken,
      mpRefreshToken: tenants.mpRefreshToken,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)

  if (!row?.mpAccessToken) {
    return null
  }

  const meRes = await fetch(MP_USERS_ME_URL, {
    headers: {
      Authorization: `Bearer ${row.mpAccessToken}`,
      Accept: "application/json",
    },
  })

  if (meRes.ok) {
    return row.mpAccessToken
  }

  if ((meRes.status === 400 || meRes.status === 401) && row.mpRefreshToken) {
    const refreshed = await refrescarTokenTenant(tenantId, row.mpRefreshToken)
    return refreshed?.accessToken ?? null
  }

  return null
}

export async function intercambiarCodigoPorTokens(params: {
  code: string
  tenantId: string
}): Promise<{ accessToken: string; refreshToken: string; publicKey?: string; userId?: string } | null> {
  const redirectUri = process.env.MP_REDIRECT_URI
  if (!redirectUri) {
    throw new Error("MP_REDIRECT_URI no configurado")
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: mpClientId(),
    client_secret: mpClientSecret(),
    code: params.code,
    redirect_uri: redirectUri,
  })

  const res = await postMpOAuth(body)
  if (!res.ok) {
    return null
  }

  const data = await parseJson(res)
  const accessToken = data?.access_token
  const refreshToken = data?.refresh_token
  if (!accessToken || !refreshToken) {
    return null
  }

  const publicKey =
    typeof data?.public_key === "string" ? data.public_key : undefined
  const userIdRaw = data?.user_id
  const userId =
    userIdRaw !== undefined && userIdRaw !== null
      ? String(userIdRaw)
      : undefined

  const db = drizzle(pool)
  await db
    .update(tenants)
    .set({
      mpAccessToken: accessToken,
      mpRefreshToken: refreshToken,
      ...(publicKey !== undefined ? { mpPublicKey: publicKey } : {}),
      ...(userId !== undefined ? { mpUserId: userId } : {}),
      mpConnected: true,
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, params.tenantId))

  return { accessToken, refreshToken, publicKey, userId }
}

/**
 * Si el body de /oauth/token no trae `user_id` o `public_key`, rellenamos con GET /users/me.
 */
export async function enriquecerTenantConUsersMe(
  tenantId: string,
  accessToken: string
): Promise<void> {
  const res = await fetch(MP_USERS_ME_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  })
  if (!res.ok) {
    return
  }
  const data = (await res.json()) as { id?: number; public_key?: string }
  const db = drizzle(pool)
  const [row] = await db
    .select({ mpPublicKey: tenants.mpPublicKey, mpUserId: tenants.mpUserId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  if (!row) {
    return
  }

  const userId: string | undefined =
    row.mpUserId == null && data.id != null ? String(data.id) : undefined
  const publicKey: string | undefined =
    row.mpPublicKey == null &&
    typeof data.public_key === "string" &&
    data.public_key.length > 0
      ? data.public_key
      : undefined
  if (userId === undefined && publicKey == undefined) {
    return
  }
  await db
    .update(tenants)
    .set({
      ...(userId != null ? { mpUserId: userId } : {}),
      ...(publicKey != null ? { mpPublicKey: publicKey } : {}),
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId))
}
