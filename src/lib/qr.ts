import QRCode from "qrcode"

const baseUrl = () =>
  (process.env.TICKET_QR_BASE_URL ?? "https://crow.ar/v").replace(/\/$/, "")

/** URL de validación futura (escáner puede resolver el hash). */
export function ticketValidationUrl(qrHash: string): string {
  return `${baseUrl()}/${encodeURIComponent(qrHash)}`
}

/** Genera PNG en data URL. Para entradas, `payload` debe ser el `qrHash`. */
export async function qrCodeDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    type: "image/png",
    // 592 px = 37 módulos (29 de datos + 4 de quiet zone por lado) × 16 px exactos.
    width: 592,
    margin: 4,
    errorCorrectionLevel: "M",
    color: { dark: "#0a0a0a", light: "#ffffff" },
  })
}
