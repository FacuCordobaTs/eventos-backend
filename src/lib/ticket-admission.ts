import { z } from "zod"

export type AdmissionWindow = {
  validFrom?: Date | string | null
  validUntil?: Date | string | null
}

// La API exige un huso horario explícito; nunca interpreta fechas con el huso del VPS.
export const admissionWindowFields = {
  validFrom: z.string().datetime({ offset: true }).nullable().optional(),
  validUntil: z.string().datetime({ offset: true }).nullable().optional(),
}

export function isAdmissionWindowOrdered(window: AdmissionWindow): boolean {
  return window.validFrom == null || window.validUntil == null ||
    new Date(window.validFrom).getTime() < new Date(window.validUntil).getTime()
}

function format(value: Date | string): string {
  return new Date(value).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit",
    year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  })
}

export function formatAdmissionWindow(window: AdmissionWindow): string | null {
  const parts = [window.validFrom ? `desde el ${format(window.validFrom)}` : "",
    window.validUntil ? `hasta el ${format(window.validUntil)}` : ""].filter(Boolean)
  return parts.length ? `Ingreso ${parts.join(" ")} (hora Argentina)` : null
}

export function admissionWindowError(window: AdmissionWindow, now = new Date()): string | null {
  if (window.validFrom != null && now.getTime() < new Date(window.validFrom).getTime()) {
    return `Fuera de horario: entrada válida desde el ${format(window.validFrom)} (hora Argentina).`
  }
  // El cierre es exclusivo: a las 22:00 ya no se admite una entrada con límite 22:00.
  if (window.validUntil != null && now.getTime() >= new Date(window.validUntil).getTime()) {
    return `Fuera de horario: entrada válida hasta el ${format(window.validUntil)} (hora Argentina).`
  }
  return null
}

/** Prioriza un PENDING utilizable; una entrada vencida no tapa otras del mismo DNI. */
export function selectAdmissionTicket<T extends AdmissionWindow & { status: string | null }>(
  rows: T[], now = new Date()
): T | undefined {
  const available = rows.filter((row) => admissionWindowError(row, now) === null)
  return available.find((row) => row.status === "PENDING") ?? available.at(-1) ??
    rows.find((row) => row.status === "PENDING") ?? rows.at(-1)
}
