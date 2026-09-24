import { authAdmin } from '@/utils/supabase/admin'
import { db, transaction } from '@/app/lib/db'
import * as clients from '@/app/lib/repositories/clients'
import * as employees from '@/app/lib/repositories/employees'
import * as policy from '@/app/lib/repositories/policy'
import { mostSeniorBand } from './mostSeniorBand'

export interface BandInput {
  code: string
  label: string
  rank: number
}

export interface OnboardClientInput {
  corporateName: string
  adminEmail: string
  adminName: string
  registeredAddress?: string
  gstNumber?: string
  industry?: string
  primaryContactPhone?: string
  size?: string
  bookingMode?: 'sbt' | 'cbt' | 'both'
  client_groupId?: string | null
  // Required. Bands used to be hardcoded L1..L5 here with no way to change
  // them afterwards, which forced every client into one naming scheme. They
  // are now the caller's own vocabulary — "A1", "C", "Band 3" are all valid.
  // Only `rank` is structural: it is the client-agnostic integer that policy
  // groups match on.
  bands: BandInput[]
  // Optional. Links an existing policy group at creation so a new client can
  // be policy-covered from day one instead of silently unprotected until
  // someone remembers to link one.
  policyGroupId?: string | null
  // Set by the caller only after a human has seen the duplicate warning below
  // and said go ahead. Absent means "I have not been asked yet", which is why
  // the check refuses rather than proceeding by default.
  confirmDuplicateName?: boolean
}

// What an existing same-named client looks like when we refuse to create a
// second one silently. Enough to tell them apart without leaving the screen —
// which is the whole point, since a name alone is exactly what is ambiguous.
export interface DuplicateClient {
  id: string
  name: string
  client_code: string | null
  city: string | null
  created_at: string
}

export interface OnboardClientResult {
  ok: boolean
  clientId?: string
  error?: string
  // Present only on the duplicate-name refusal. The caller shows these, asks,
  // and retries with confirmDuplicateName: true.
  duplicates?: DuplicateClient[]
}

const VALID_SIZES = ['1-50', '51-200', '201-1000', '1001+']
const VALID_BOOKING_MODES = ['sbt', 'cbt', 'both']

// ── validateBands ─────────────────────────────────────────────────────────────
// Ranks must be unique because two bands at the same rank would both match any
// policy group covering it, which resolveEffectivePolicy can't arbitrate. Codes
// must be unique because employees reference their band by code.
// ─────────────────────────────────────────────────────────────────────────────
export function validateBands(bands: BandInput[] | undefined): string | null {
  if (!Array.isArray(bands) || bands.length === 0) {
    return 'At least one band is required — employees need a band for policy to apply'
  }

  const seenCodes = new Set<string>()
  const seenRanks = new Set<number>()

  for (const band of bands) {
    const code = band.code?.trim()
    const label = band.label?.trim()

    if (!code) return 'Every band needs a code'
    if (!label) return `Band "${code}" needs a label`
    if (!Number.isInteger(Number(band.rank)) || Number(band.rank) < 0) {
      return `Band "${code}" needs a non-negative whole-number rank`
    }

    const lowered = code.toLowerCase()
    if (seenCodes.has(lowered)) return `Duplicate band code: "${code}"`
    seenCodes.add(lowered)

    if (seenRanks.has(Number(band.rank))) {
      return `Two bands share rank ${band.rank} — each band needs its own rank`
    }
    seenRanks.add(Number(band.rank))
  }

  return null
}

// ── onboardClient ────────────────────────────────────────────────────────────
// Creates a client with the bands the TMC defined, optionally links a policy
// group, and invites the corporate admin.
// Shared by the single-client form and CSV bulk import so both stay in sync —
// never fork this logic between the two entry points.
//
// ONE TRANSACTION for every database write, with the invite inside it, last
// before the admin's own row. Any failure rolls the client, its GSTIN, its
// bands and its policy link back together -- this used to delete the client
// by hand in a catch block and rely on cascades to reach the rest. The invite
// is not a database write and cannot be rolled back, so it is the one thing
// still compensated by hand: if it succeeded and the admin's row then failed,
// the account is deleted. Doing every other write first means a constraint
// failure is found BEFORE anyone is sent an email.
// ─────────────────────────────────────────────────────────────────────────────

export async function onboardClient(
  tmcId: string,
  appUrl: string,
  input: OnboardClientInput
): Promise<OnboardClientResult> {
  const { corporateName, adminEmail, adminName } = input

  if (!corporateName?.trim() || !adminEmail?.trim() || !adminName?.trim()) {
    return { ok: false, error: 'corporateName, adminEmail, and adminName are required' }
  }

  if (input.size && !VALID_SIZES.includes(input.size)) {
    return { ok: false, error: `Invalid size: ${input.size}. Must be one of ${VALID_SIZES.join(', ')}` }
  }

  const bookingMode = input.bookingMode ?? 'sbt'
  if (!VALID_BOOKING_MODES.includes(bookingMode)) {
    return { ok: false, error: `Invalid booking_mode: ${bookingMode}` }
  }

  const bandError = validateBands(input.bands)
  if (bandError) {
    return { ok: false, error: bandError }
  }

  // ── Duplicate name ─────────────────────────────────────────────────────────
  // A WARNING, NOT A RULE. Nothing constrains clients.name and nothing should:
  // subsidiaries, regional arms and renamed entities legitimately share a name,
  // and the only uniqueness the schema asserts is (tmc_id, client_code) — which
  // is nullable, so two codeless "Acme"s were both accepted in silence.
  //
  // That silence is what costs money later. The two rows are indistinguishable
  // in every picker in the app, so a deal code, a commercial rule or a policy
  // gets attached to the wrong Acme and nobody finds out until a fare is wrong.
  //
  // Refusing ONCE and returning the existing rows turns an invisible collision
  // into a decision. Case-insensitive: "acme" and "Acme" are the same collision.
  if (!input.confirmDuplicateName) {
    const sameName = await clients.sameName(db, tmcId, corporateName.trim())
    if (sameName.length > 0) {
      return {
        ok: false,
        error: `You already have a client named "${corporateName.trim()}".`,
        duplicates: sameName,
      }
    }
  }

  // Confirm the policy group belongs to this TMC before the client exists, so
  // a bad id fails fast rather than after a partial create.
  if (input.policyGroupId && (await policy.groupOwner(db, input.policyGroupId))?.tmc_id !== tmcId) {
    return { ok: false, error: 'Policy group not found for this TMC' }
  }

  // If a client_groupId was given, confirm it actually belongs to this TMC —
  // prevents cross-tenant assignment via a forged id.
  if (input.client_groupId && !(await clients.groupInTmc(db, input.client_groupId, tmcId))) {
    return { ok: false, error: 'client_group not found for this TMC' }
  }

  const email = adminEmail.trim().toLowerCase()
  const auth = authAdmin()
  let authUserId: string | null = null

  try {
    const clientId = await transaction(async (tx) => {
      const { id } = await clients.insertClient(tx, {
        tmc_id: tmcId,
        name: corporateName.trim(),
        registered_address: input.registeredAddress?.trim() || null,
        industry: input.industry?.trim() || null,
        primary_contact_phone: input.primaryContactPhone?.trim() || null,
        size: input.size || null,
        booking_mode: bookingMode,
        client_group_id: input.client_groupId || null,
      })

      // The GSTIN given at onboarding becomes the client's first — and, being
      // the only one, primary — registration. A corporate bills through
      // several, each with its own cost centre and validity window.
      if (input.gstNumber?.trim()) {
        await clients.insertGst(tx, id, {
          gstin: input.gstNumber.trim().toUpperCase(),
          gst_holder: corporateName.trim(),
          is_primary: true,
        })
      }

      const bands = await employees.insertBands(tx, id, input.bands.map(b => ({
        code: b.code.trim(), label: b.label.trim(), rank: Number(b.rank),
      })))

      // The corporate admin goes on the most senior band. The only durable
      // definition of "most senior" is the highest rank: a client names its own
      // bands, so there is no fixed code to look for.
      const adminBand = mostSeniorBand(bands)
      if (!adminBand) throw new Error('Band seeding failed')

      if (input.policyGroupId) {
        await policy.link(tx, id, input.policyGroupId, null)
      }

      // redirectTo points at /auth/callback, not /login — see inviteRedirectUrl.
      const { data: authData, error: inviteError } = await auth.inviteUserByEmail(email, {
        redirectTo: `${appUrl}/auth/callback?next=/auth/set-password`,
      })
      if (inviteError) throw new InviteRefused(inviteError.message)
      authUserId = authData.user.id

      await employees.insertClientAdmin(tx, {
        id: authUserId,
        client_id: id,
        band: adminBand,
        full_name: adminName.trim(),
        email,
      })

      return id
    }, { tenantId: tmcId })

    return { ok: true, clientId }
  } catch (err) {
    console.error('onboardClient failed, rolled back', err)
    if (authUserId) await auth.deleteUser(authUserId)

    // GoTrue's own message is the useful one ("already registered", "rate
    // limit"); anything from the database is not for the browser.
    return {
      ok: false,
      error: err instanceof InviteRefused ? err.message : 'The client could not be created. Nothing was saved.',
    }
  }
}

// The admin's invite was refused by the auth service; its message is shown.
class InviteRefused extends Error {}
