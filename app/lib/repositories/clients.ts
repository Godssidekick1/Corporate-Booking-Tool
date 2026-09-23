import { sql, maybeOne, type Queryable } from '@/app/lib/db/sql'
import type { Row } from '@/app/lib/db/types.generated'

// ── Clients ──────────────────────────────────────────────────────────────────
// Owns: clients, client_groups, client_gst_registrations,
// client_mandatory_info, cost_centres, buckets, bucket_clients.
//
// A client is a corporate customer of a TMC. Everything tenant-scoped on the
// corporate side hangs off clients.id.
// ─────────────────────────────────────────────────────────────────────────────

// ═══ Corporate Settings gates ═══════════════════════════════════════════════
// The switches app/lib/clients/clientGates.ts turns into decisions. Read on
// every booking, ticket, policy evaluation and form-of-payment resolution.

export type ClientGateSettings = Pick<Row<'clients'>,
  | 'status'
  | 'booking_activation' | 'hold_activation' | 'dom_ticketing' | 'intl_ticketing'
  | 'policy_controlling' | 'personal_bookings_allowed'
  | 'agency_fop_allowed' | 'corporate_fop_allowed'
  | 'bta_cta_allowed' | 'bta_cta_manual_allowed' | 'fop_priority'
  | 'markup_active' | 'discount_active' | 'processing_fee_active'
>

export async function gateSettings(db: Queryable, clientId: string): Promise<ClientGateSettings | null> {
  return maybeOne<ClientGateSettings>(db, sql`
    select status,
           booking_activation, hold_activation, dom_ticketing, intl_ticketing,
           policy_controlling, personal_bookings_allowed,
           agency_fop_allowed, corporate_fop_allowed,
           bta_cta_allowed, bta_cta_manual_allowed, fop_priority,
           markup_active, discount_active, processing_fee_active
    from clients where id = ${clientId}`)
}
