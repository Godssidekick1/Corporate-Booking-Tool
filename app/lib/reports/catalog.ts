import type { FilterKey } from './types'

// ── The reports on each side, their tabs and filters ─────────────────────────
// Free of server imports, so the screens read it too (the tab row is known
// before anything loads). The builders are attached in registry.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface CatalogEntry { key: string; title: string; filters: readonly FilterKey[] }

const PEOPLE = ['department', 'costCentre', 'band'] as const
const CLIENTS = ['clientId', 'clientGroupId'] as const

export const CORPORATE_CATALOG = [
  { key: 'spend', title: 'Spend', filters: PEOPLE },
  { key: 'compliance', title: 'Policy compliance', filters: ['department', 'band'] },
  { key: 'savings', title: 'Savings', filters: ['department'] },
  { key: 'approvals', title: 'Approvals', filters: [] },
  { key: 'trips', title: 'Trips & budgets', filters: ['costCentre', 'billable'] },
  { key: 'patterns', title: 'Travel patterns', filters: ['department'] },
] as const satisfies readonly CatalogEntry[]

export const TMC_CATALOG = [
  { key: 'revenue', title: 'Revenue', filters: CLIENTS },
  { key: 'activity', title: 'Client activity', filters: CLIENTS },
  { key: 'airlines', title: 'Airlines & deals', filters: CLIENTS },
  { key: 'desk', title: 'Desk productivity', filters: CLIENTS },
  { key: 'compliance', title: 'Compliance across clients', filters: CLIENTS },
  { key: 'payments', title: 'Payments', filters: CLIENTS },
] as const satisfies readonly CatalogEntry[]
