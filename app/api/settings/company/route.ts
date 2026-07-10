import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── PATCH /api/settings/company ─────────────────────────────────────────────
// Corporate admin edits their own company's name, timezone, currency, country.
//
// booking_mode is intentionally NOT editable here. It's set by the TMC at
// onboarding (create-corporate) and changed only from the TMC's company
// management screens. Even if a caller sends booking_mode in the body,
// this route ignores it — ownership of that field lives with the TMC.
// ─────────────────────────────────────────────────────────────────────────────

// Only INR is supported for now — multi-currency is explicitly post-MVP.
// The column stays free-form (char(3)) so this can widen later without a migration.
const ALLOWED_CURRENCIES = ['INR'] as const

interface UpdateCompanyBody {
  name?: string
  timezone?: string
  currency?: string
  country?: string
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: employee, error: empError } = await service
    .from('employees')
    .select('company_id, role')
    .eq('id', user.id)
    .single()

  if (empError || !employee) {
    return Response.json({ error: 'Employee record not found' }, { status: 404 })
  }

  if (employee.role !== 'admin') {
    return Response.json({ error: 'Only admins can edit company settings' }, { status: 403 })
  }

  const body: UpdateCompanyBody = await req.json()
  const { name, timezone, currency, country } = body

  const update: Record<string, string> = {}

  if (name !== undefined) {
    const trimmed = name.trim()
    if (!trimmed) {
      return Response.json({ error: 'Company name cannot be empty' }, { status: 400 })
    }
    update.name = trimmed
  }

  if (timezone !== undefined) {
    if (!timezone.trim()) {
      return Response.json({ error: 'Timezone cannot be empty' }, { status: 400 })
    }
    update.timezone = timezone
  }

  if (currency !== undefined) {
    const upper = currency.trim().toUpperCase()
    if (!ALLOWED_CURRENCIES.includes(upper as typeof ALLOWED_CURRENCIES[number])) {
      return Response.json(
        { error: `Unsupported currency: ${currency}` },
        { status: 400 }
      )
    }
    update.currency = upper
  }

  if (country !== undefined) {
    update.country = country.trim()
  }

  if (Object.keys(update).length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data: updated, error: updateError } = await service
    .from('companies')
    .update(update)
    .eq('id', employee.company_id)
    .select('id, name, timezone, currency, country, booking_mode')
    .single()

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 })
  }

  return Response.json({ ok: true, company: updated })
}