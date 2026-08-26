import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/mysql2"
import { admissionBlacklist } from "../db/schema"

/**
 * Acepta la DB directa (rutas) o el tx de una transacción (validate corre dentro de una).
 * Se infiere desde `drizzle(pool)` schema-less — la misma convención que el resto de las rutas
 * (todos los selects usan tablas explícitas, no las relaciones del schema generic).
 */
type Db = ReturnType<typeof drizzle>
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Queryable = Db | Tx

/**
 * Tarea 1.2 — Busca la entrada ACTIVA de una persona (por DNI) en la blacklist del evento.
 * Compartido por `POST /tickets/validate` (1.2) y el validate-by-dni de puerta (1.4): el DNI es
 * la identidad dentro del evento, así que el chequeo cuelga de él, no del ticket.
 */
export async function findActiveBlacklistEntry(
  db: Queryable,
  eventId: string,
  dni: string
): Promise<typeof admissionBlacklist.$inferSelect | null> {
  const [entry] = await db
    .select()
    .from(admissionBlacklist)
    .where(
      and(
        eq(admissionBlacklist.eventId, eventId),
        eq(admissionBlacklist.dni, dni),
        eq(admissionBlacklist.isActive, true)
      )
    )
    .limit(1)
  return entry ?? null
}
