import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'

// ── GET /api/tmc/fop-codes ───────────────────────────────────────────────────
// The two code lists a form of payment is built from.
//
// GDS ENTRY is the one that carries meaning people miss: `CC` puts a real card
// element on the ticket so the AIRLINE charges it — pass-through. `INVAGT`
// settles the ticket as an agency invoice and the agency charges the card
// separately — non pass-through. That is the whole difference between "Master
// Pass Through" and "Amex Non Pass Through", and it is a different question
// from whose money it is.
//
// PAYMENT TYPE carries `requires_card`, which is the single source of truth for
// whether card details apply. forms_of_payment.fop_type is derived from it
// rather than picked separately, so the two cannot drift.
//
// Held as rows rather than enums so a TMC can add a payment type without a
// migration — the same call as deal code categories.
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors the seed in 20260908000000. Duplicated on purpose: the migration
// covers TMCs that existed when it ran, this covers every TMC created after.
const DEFAULT_GDS_ENTRIES = [
  { code: 'CC',     label: 'Credit card - passed through to the airline' },
  { code: 'INVAGT', label: 'Agency invoice - agency settles, card charged separately' },
] as const

const DEFAULT_PAYMENT_TYPES = [
  { code: 'CC', label: 'Credit card',  requires_card: true },
  { code: 'CL', label: 'Credit limit', requires_card: false },
] as const

export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_fops')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }

  let [{ data: gdsEntries }, { data: paymentTypes }] = await Promise.all([
    service.from('fop_gds_entries').select('id, code, label, active').eq('tmc_id', auth.tmcId).order('code'),
    service.from('fop_payment_types').select('id, code, label, requires_card, active').eq('tmc_id', auth.tmcId).order('code'),
  ])

  // Seed on first read for a TMC created after the migration ran.
  if (!gdsEntries || gdsEntries.length === 0) {
    await service.from('fop_gds_entries').insert(
      DEFAULT_GDS_ENTRIES.map(e => ({ tmc_id: auth.tmcId, code: e.code, label: e.label }))
    )
    const { data } = await service
      .from('fop_gds_entries').select('id, code, label, active').eq('tmc_id', auth.tmcId).order('code')
    gdsEntries = data ?? []
  }

  if (!paymentTypes || paymentTypes.length === 0) {
    await service.from('fop_payment_types').insert(
      DEFAULT_PAYMENT_TYPES.map(p => ({
        tmc_id: auth.tmcId, code: p.code, label: p.label, requires_card: p.requires_card,
      }))
    )
    const { data } = await service
      .from('fop_payment_types').select('id, code, label, requires_card, active').eq('tmc_id', auth.tmcId).order('code')
    paymentTypes = data ?? []
  }

  return Response.json({
    ok: true,
    gdsEntries: gdsEntries ?? [],
    paymentTypes: paymentTypes ?? [],
  })
}
