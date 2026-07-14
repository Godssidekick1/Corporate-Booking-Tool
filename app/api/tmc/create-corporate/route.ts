import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { onboardCompany } from '@/app/lib/onboarding/onboardCompany'
import { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: caller, error: callerError } = await service
    .from('employees')
    .select('role, tmc_id')
    .eq('id', user.id)
    .single()

  if (callerError || !caller) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (caller.role !== 'tmc_admin') {
    return Response.json({ error: 'Only TMC admins can create corporate accounts' }, { status: 403 })
  }
  if (!caller.tmc_id) {
    return Response.json({ error: 'TMC context missing' }, { status: 400 })
  }

  const body = await req.json()

  const result = await onboardCompany(
    service,
    caller.tmc_id,
    process.env.NEXT_PUBLIC_APP_URL!,
    {
      corporateName: body.corporateName,
      adminEmail: body.adminEmail,
      adminName: body.adminName,
      registeredAddress: body.registeredAddress,
      gstNumber: body.gstNumber,
      industry: body.industry,
      primaryContactPhone: body.primaryContactPhone,
      size: body.size,
      bookingMode: body.bookingMode,
    }
  )

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400 })
  }

  return Response.json({
    ok: true,
    companyId: result.companyId,
    message: `"${body.corporateName}" created. Invite sent to ${body.adminEmail}.`,
  }, { status: 201 })
}