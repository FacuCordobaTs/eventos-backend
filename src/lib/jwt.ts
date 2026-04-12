import * as jwt from "jsonwebtoken"

const secret = () => process.env.JWT_SECRET ?? "fallback-secret"

export type AccessTokenPayload = {
  sub: string
}

export function createAccessToken(payload: AccessTokenPayload): Promise<string> {
  return new Promise((resolve, reject) => {
    jwt.sign(
      payload,
      secret(),
      { expiresIn: "365d" },
      (err, token) => {
        if (err) reject(err)
        else if (!token) reject(new Error("Token vacío"))
        else resolve(token)
      }
    )
  })
}

export function verifyToken(token: string): Promise<AccessTokenPayload> {
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
        if (!sub) reject(new Error("Token sin sujeto"))
        else resolve({ sub })
      }
    })
  })
}
