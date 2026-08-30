import { Resend } from "resend"

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}

/** Email deliberadamente breve: el enlace privado es la única acción principal. */
export async function sendCustomerProfileEmail(input: {
  to: string
  name: string
  url: string
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey?.trim()) {
    console.warn("[customer-profile] RESEND_API_KEY no está seteada; se omite el envío")
    return
  }

  const resend = new Resend(apiKey)
  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM ?? "Crow <entradas@crow.ar>",
    to: input.to,
    subject: "Tus eventos en Crow",
    html: `
      <div style="background:#0b0b0c;color:#f4f1ea;font-family:Arial,sans-serif;padding:40px 20px">
        <div style="margin:0 auto;max-width:440px">
          <p style="color:#a1a1aa;font-size:13px;margin:0 0 12px">CROW</p>
          <h1 style="font-size:28px;line-height:1.15;margin:0 0 12px">Hola, ${escapeHtml(input.name)}</h1>
          <p style="color:#b4b4bb;font-size:15px;line-height:1.55;margin:0 0 28px">Desde acá podés ver todos tus eventos, entradas, consumos y saldo.</p>
          <a href="${escapeHtml(input.url)}" style="background:#ffffff;border-radius:12px;color:#09090b;display:inline-block;font-size:15px;font-weight:700;padding:14px 22px;text-decoration:none">Ver mis eventos</a>
          <p style="color:#66666d;font-size:12px;line-height:1.5;margin:28px 0 0">Este enlace es personal. No lo compartas. Si no lo pediste, podés ignorar este mensaje.</p>
        </div>
      </div>`,
  })
  if (error) throw new Error(error.message)
}
