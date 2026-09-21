import * as jwt from "jsonwebtoken"

const secret = () => process.env.JWT_SECRET ?? "fallback-secret"

/**
 * "staff" es el personal (admin, POS, puerta). "customer" es el cliente final que se autenticó
 * con el código de WhatsApp desde el link por evento; su `sub` es `customers.id`.
 */
export type TokenAudience = "staff" | "customer"

export type AccessTokenPayload = {
  sub: string
  aud: TokenAudience
}

export function createAccessToken(
  sub: string,
  aud: TokenAudience = "staff",
  expiresIn: "365d" | "60d" | "30d" = "365d"
): Promise<string> {
  return new Promise((resolve, reject) => {
    jwt.sign(
      { sub, aud },
      secret(),
      { expiresIn },
      (err, token) => {
        if (err) reject(err)
        else if (!token) reject(new Error("Token vacío"))
        else resolve(token)
      }
    )
  })
}

/**
 * Verifica un token y exige que su audiencia sea la esperada. El default sigue siendo "staff",
 * así que los llamadores existentes (middleware de staff y WS de stock) no cambian.
 */
export function verifyToken(
  token: string,
  expectedAud: TokenAudience = "staff"
): Promise<AccessTokenPayload> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, secret(), (err, decoded) => {
      if (err) reject(err)
      else {
        const d = decoded as Record<string, unknown>
        const sub =
          typeof d.sub === "string"
            ? d.sub
            : typeof d.id === "string"
              ? d.id
              : null
        if (!sub) {
          reject(new Error("Token sin sujeto"))
          return
        }
        if (d.aud !== expectedAud) {
          reject(new Error("Token inválido"))
          return
        }
        resolve({ sub, aud: expectedAud })
      }
    })
  })
}
