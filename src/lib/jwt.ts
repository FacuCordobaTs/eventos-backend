import * as jwt from "jsonwebtoken";

export async function createAccessToken(payload: any) {
  return new Promise((resolve, reject) => {
    jwt.sign(payload, process.env.JWT_SECRET || 'fallback-secret', { expiresIn: "365d" }, (err, token) => {
      if (err) reject(err);
      resolve(token);
    });
  });
}

export function verifyToken(token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret', (err, decoded) => {
      if (err) reject(err);
      resolve(decoded);
    });
  });
}