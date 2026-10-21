// Promos de entradas "llevás X, pagás Y" (2x1 = 2/1, 3x2 = 3/2) por tipo de entrada.
// Se emiten las X entradas completas; sólo cambia cuántas unidades se cobran. Por cada
// grupo completo de `promoBuy` se cobran `promoPay`; el resto que no completa grupo paga precio lleno.

export type TicketPromo = { promoBuy: number | null; promoPay: number | null }

export const PROMO_INVALID_MESSAGE =
  "La promo debe tener 'llevás' (2 a 20) y 'pagás' (1 o más, menor que 'llevás'), o ninguno de los dos."

export function isValidTicketPromo(p: TicketPromo): boolean {
  if (p.promoBuy == null && p.promoPay == null) return true
  if (p.promoBuy == null || p.promoPay == null) return false
  return (
    Number.isInteger(p.promoBuy) &&
    Number.isInteger(p.promoPay) &&
    p.promoBuy >= 2 &&
    p.promoBuy <= 20 &&
    p.promoPay >= 1 &&
    p.promoPay < p.promoBuy
  )
}

/** Unidades que se cobran por `quantity` entradas del tipo (== quantity si no hay promo válida). */
export function ticketPaidUnits(promo: TicketPromo, quantity: number): number {
  if (!isValidTicketPromo(promo) || promo.promoBuy == null || promo.promoPay == null) {
    return quantity
  }
  return Math.floor(quantity / promo.promoBuy) * promo.promoPay + (quantity % promo.promoBuy)
}

/** Entradas que entrega una cortesía de este tipo: las X de la promo, o 1 si no hay. */
export function courtesyTicketCount(promo: TicketPromo): number {
  return isValidTicketPromo(promo) && promo.promoBuy != null ? promo.promoBuy : 1
}
