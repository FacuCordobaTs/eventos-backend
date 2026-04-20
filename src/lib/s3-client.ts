import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"

function requireEnv(name: string): string {
  const v = process.env[name]
  if (v == null || v === "") {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return v
}

let _client: S3Client | null = null

export function getS3Client(): S3Client {
  if (_client) return _client
  _client = new S3Client({
    region: "auto",
    endpoint: requireEnv("R2_ENDPOINT"),
    credentials: {
      accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    },
  })
  return _client
}

export function getR2BucketName(): string {
  return requireEnv("R2_BUCKET_NAME")
}

export function publicUrlForKey(key: string): string {
  const base = requireEnv("R2_PUBLIC_DOMAIN").replace(/\/$/, "")
  return `${base}/${key}`
}

export async function uploadFile(
  file: Buffer,
  key: string,
  contentType: string
): Promise<void> {
  const client = getS3Client()
  await client.send(
    new PutObjectCommand({
      Bucket: getR2BucketName(),
      Key: key,
      Body: file,
      ContentType: contentType,
    })
  )
}

export async function deleteFileByKey(key: string): Promise<void> {
  const client = getS3Client()
  await client.send(
    new DeleteObjectCommand({
      Bucket: getR2BucketName(),
      Key: key,
    })
  )
}

/** Extrae la key del objeto a partir de una URL pública configurada con R2_PUBLIC_DOMAIN. */
export function keyFromPublicUrl(storedUrl: string): string | null {
  const base = process.env.R2_PUBLIC_DOMAIN?.replace(/\/$/, "")
  if (!base || !storedUrl.startsWith(`${base}/`)) return null
  return storedUrl.slice(base.length + 1)
}
