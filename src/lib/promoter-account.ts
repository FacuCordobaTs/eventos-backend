import { eq } from "drizzle-orm"
import { v4 as uuidv4 } from "uuid"
import { promoters } from "../db/schema"

/**
 * Mantiene la identidad comercial del promotor ligada a su cuenta de staff: cada cuenta de rol
 * `PROMOTER` (y también cada `GENERAL_PROMOTER`, que tiene link de venta propio) necesita su fila
 * en `promoters` — es la que atribuyen `tickets.promoter_id` y `sales.promoter_id`.
 *
 * `ownerStaffId` (promotor general que lo dio de alta) se fija sólo al crear: sobrevive a las
 * reactivaciones, porque la pertenencia no cambia con el nombre ni con el estado de la cuenta.
 * Vive en `lib/` y no en la ruta de staff porque la ruta de promotores también la necesita para
 * reparar cuentas viejas (promotores generales creados antes de que tuvieran fila propia).
 */
export async function ensurePromoterAccount(
  db: any,
  input: {
    staffId: string
    tenantId: string
    name: string
    isActive?: boolean
    ownerStaffId?: string | null
  }
) {
  const [existing] = await db
    .select({ id: promoters.id })
    .from(promoters)
    .where(eq(promoters.staffId, input.staffId))
    .limit(1)

  if (existing) {
    await db
      .update(promoters)
      .set({ name: input.name, ...(input.isActive !== undefined ? { isActive: input.isActive } : {}) })
      .where(eq(promoters.id, existing.id))
    return existing.id
  }

  const id = uuidv4()
  await db.insert(promoters).values({
    id,
    tenantId: input.tenantId,
    staffId: input.staffId,
    name: input.name,
    ownerStaffId: input.ownerStaffId ?? null,
    isActive: input.isActive ?? true,
    createdAt: new Date(),
  })
  return id
}
