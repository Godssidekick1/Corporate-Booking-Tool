import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { policy, approvalModel } = await req.json()

  if (!policy || !Array.isArray(policy) || policy.length === 0) {
    return Response.json({ error: 'Policy data is required' }, { status: 400 })
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
    return Response.json({ error: 'Only admins can update policy' }, { status: 403 })
  }

  const companyId = employee.company_id

  const { data: bands, error: bandsError } = await service
    .from('bands')
    .select('id, code')
    .eq('company_id', companyId)

  if (bandsError || !bands) {
    return Response.json({ error: 'Could not load bands' }, { status: 500 })
  }

  const bandMap = Object.fromEntries(bands.map(b => [b.code, b.id]))

  const rows: object[] = []

  for (const row of policy) {
    const bandId = bandMap[row.band]
    if (!bandId) continue

    const limits: Array<{ limit_key: string; travel_type: string; value: number }> = [
      { limit_key: 'max_fare',                  travel_type: 'flight_domestic',      value: row.domesticFlight },
      { limit_key: 'intl_max_fare',             travel_type: 'flight_international', value: row.intlFlight },
      { limit_key: 'flight_class_short_haul',   travel_type: 'flight_domestic',      value: row.flightClassShortHaul === 'Economy' ? 0 : row.flightClassShortHaul === 'Business' ? 1 : 2 },
      { limit_key: 'flight_class_long_haul',    travel_type: 'flight_international', value: row.flightClassLongHaul === 'Economy' ? 0 : row.flightClassLongHaul === 'Business' ? 1 : 2 },
      { limit_key: 'advance_booking_days',      travel_type: 'flight_domestic',      value: row.advanceBookingDays },
      { limit_key: 'hotel_major_city_max_rate', travel_type: 'hotel',                value: row.hotelMajorCity },
      { limit_key: 'hotel_other_city_max_rate', travel_type: 'hotel',                value: row.hotelOtherCity },
      { limit_key: 'hotel_max_stars',           travel_type: 'hotel',                value: row.hotelStars },
      { limit_key: 'car_rental_max_per_day',    travel_type: 'car_rental',           value: row.carRentalPerDay },
      { limit_key: 'auto_approve_limit',        travel_type: 'flight_domestic',      value: row.autoApproveLimit },
      { limit_key: 'finance_approve_limit',     travel_type: 'flight_domestic',      value: row.managerApproveLimit },
    ]

    for (const { limit_key, travel_type, value } of limits) {
      rows.push({
        company_id: companyId,
        band_id: bandId,
        travel_type,
        limit_key,
        limit_value: Number(value),
        locked: false,
        version: 1,
        updated_by: user.id,
      })
    }
  }

  const { error: deleteError } = await service
    .from('policy_rules')
    .delete()
    .eq('company_id', companyId)
    .eq('version', 1)

  if (deleteError) {
    return Response.json({ error: deleteError.message }, { status: 500 })
  }

  const { error: insertError } = await service
    .from('policy_rules')
    .insert(rows)

  if (insertError) {
    return Response.json({ error: insertError.message }, { status: 500 })
  }

  // Fetch current settings before merging
  const { data: company } = await service
    .from('companies')
    .select('settings')
    .eq('id', companyId)
    .single()

  const { error: updateError } = await service
    .from('companies')
    .update({
      settings: {
        ...(company?.settings ?? {}),
        approvalModel,
      },
    })
    .eq('id', companyId)

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}