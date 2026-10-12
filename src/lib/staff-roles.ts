import { sql } from "drizzle-orm"
import { staff } from "../db/schema"

export const STAFF_ROLES = ["ADMIN", "MANAGER", "BARTENDER", "SECURITY", "TRANSPORTER", "PROMOTER", "GENERAL_PROMOTER"] as const
export type StaffRole = typeof STAFF_ROLES[number]

export function staffRoles(row: { role: string; roles?: string[] | null }): StaffRole[] {
  const roles = row.roles?.length ? row.roles : [row.role]
  return [...new Set(roles.filter((role): role is StaffRole => STAFF_ROLES.includes(role as StaffRole)))]
}

/** A removed selection falls back to a currently granted role, never a stale permission. */
export function resolveStaffRole(row: { role: string; roles?: string[] | null }, selected?: string): StaffRole {
  const roles = staffRoles(row)
  return roles.find((role) => role === selected) ?? roles.find((role) => role === row.role) ?? roles[0]
}

export function staffHasRole(role: StaffRole) {
  return sql`(((${staff.roles} is null or JSON_LENGTH(${staff.roles}) = 0) and ${staff.role} = ${role}) or JSON_CONTAINS(${staff.roles}, ${JSON.stringify(role)}))`
}

export function isPromoterAccount(row: { role: string; roles?: string[] | null }) {
  return staffRoles(row).some((role) => role === "PROMOTER" || role === "GENERAL_PROMOTER")
}
