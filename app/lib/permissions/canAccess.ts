// tmc_admin has unrestricted access. TC access is gated by their granted
// permission keys (see employee_permissions table / api/tmc/tcs).
export function canAccess(role: string | undefined, permissions: string[], permissionKey: string): boolean {
  if (role === 'tmc_admin') return true
  if (role === 'tc') return permissions.includes(permissionKey)
  return false
}