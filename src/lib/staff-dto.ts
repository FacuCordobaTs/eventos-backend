import { staff } from "../db/schema"
import { staffRoles } from "./staff-roles"

export type StaffRow = typeof staff.$inferSelect

export function sanitizeStaff(row: StaffRow) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    email: row.email,
    role: row.role,
    roles: staffRoles(row),
    isActive: row.isActive,
    createdAt: row.createdAt,
  }
}
