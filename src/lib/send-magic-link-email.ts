import { Resend } from "resend"

/**
 * Envía el email con el enlace de acceso (magic link, spec §1). Best-effort: si no hay
 * RESEND_API_KEY configurada, no manda nada (solo avisa por consola) para no bloquear el flujo.
 * No arroja: los callers no deben depender del envío (en dev el token se devuelve por API).
 */
export async function sendMagicLinkEmail(input: {
  to: string
  url: string
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey?.trim()) {
    console.warn("[magic-link] RESEND_API_KEY no está seteada; se omite el envío")
    return
  }
  try {
    const resend = new Resend(apiKey)
    const from = process.env.RESEND_FROM ?? "Crow <no-reply@crow.ar>"
    await resend.emails.send({
      from,
      to: input.to,
      subject: "Tu enlace de acceso a Crow",
      html:
        `<p>Tocá el botón para entrar. El enlace vence en 15 minutos y se usa una sola vez.</p>` +
        `<p><a href="${input.url}">Entrar a Crow</a></p>` +
        `<p style="color:#888;font-size:12px">Si no pediste esto, ignorá este mensaje.</p>`,
    })
  } catch (err) {
    console.error("[magic-link] fallo al enviar el email:", err)
  }
}
