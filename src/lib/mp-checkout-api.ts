/**
 * Mercado Pago Checkout Pro (Preferences) + Payments API helpers.
 */

const MP_API = "https://api.mercadopago.com"

export type MpPaymentResource = {
  id: number | string
  status?: string
  external_reference?: string | null
  transaction_amount?: number
  currency_id?: string
  metadata?: Record<string, unknown>
  preference_id?: string | null
}

export async function mpGetPayment(
  accessToken: string,
  paymentId: string
): Promise<MpPaymentResource | null> {
  const res = await fetch(`${MP_API}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  })
  if (!res.ok) {
    return null
  }
  return (await res.json()) as MpPaymentResource
}

export async function mpCreateCheckoutPreference(input: {
  accessToken: string
  items: {
    title: string
    quantity: number
    unit_price: number
    currency_id: string
  }[]
  externalReference: string
  notificationUrl: string
  marketplaceFee: number
  backUrls: { success: string; failure: string; pending: string }
}): Promise<{ id: string; init_point: string } | null> {
  const body: Record<string, unknown> = {
    items: input.items,
    external_reference: input.externalReference,
    notification_url: input.notificationUrl,
    marketplace_fee: input.marketplaceFee,
    back_urls: input.backUrls,
    auto_return: "approved",
  }

  const res = await fetch(`${MP_API}/checkout/preferences`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    return null
  }

  const data = (await res.json()) as { id?: string; init_point?: string }
  if (!data.id || !data.init_point) {
    return null
  }
  return { id: data.id, init_point: data.init_point }
}
