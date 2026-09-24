import { createClient } from '@/utils/supabase/server'
import * as fops from '@/app/lib/repositories/fop'
import { route } from '@/app/lib/http/handler'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { db, transaction } from '@/app/lib/db'

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

export const GET = route(async () => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const auth = await requireTmcPermission(db, user.id, 'manage_fops')
  if (!auth.authorized || !auth.tmcId) {
    return Response.json({ error: auth.error ?? 'Forbidden' }, { status: auth.status ?? 403 })
  }
  const tmcId = auth.tmcId

  let [gdsEntries, paymentTypes] = await Promise.all([fops.gdsEntries(db, tmcId), fops.paymentTypes(db, tmcId)])

  // Seed on first read for a TMC created after the migration ran. Each list is
  // seeded only when it is the empty one, in one idempotent transaction.
  if (gdsEntries.length === 0 || paymentTypes.length === 0) {
    await transaction(tx => fops.seedCodes(tx, tmcId,
      gdsEntries.length === 0 ? DEFAULT_GDS_ENTRIES : [],
      paymentTypes.length === 0 ? DEFAULT_PAYMENT_TYPES : [],
    ), { tenantId: tmcId, userId: user.id })
    ;[gdsEntries, paymentTypes] = await Promise.all([fops.gdsEntries(db, tmcId), fops.paymentTypes(db, tmcId)])
  }

  return Response.json({ ok: true, gdsEntries, paymentTypes })
})
