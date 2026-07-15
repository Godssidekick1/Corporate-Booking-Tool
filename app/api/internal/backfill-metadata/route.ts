import { createServiceClient } from '@/utils/supabase/service'
import { NextRequest } from 'next/server'

// ── Internal-only route ───────────────────────────────────────────────────────
// One-time backfill: syncs auth.users.user_metadata (role, tmc_id, company_id)
// for every existing employee from the employees table, which is the real
// source of truth. Fixes accounts created before every invite/create path
// consistently set metadata (e.g. the original tmc_admin, TCs invited before
// this fix, corp admins invited before this fix).
//
// Run once via Postman, same auth pattern as create-tmc:
//   POST /api/internal/backfill-metadata
//   Header: x-internal-secret: <INTERNAL_API_SECRET>
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-internal-secret')
  if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const service = createServiceClient()

  const { data: employees, error } = await service
    .from('employees')
    .select('id, role, tmc_id, company_id, full_name')

  if (error || !employees) {
    return Response.json({ error: error?.message || 'Could not load employees' }, { status: 500 })
  }

  const results: { id: string; status: 'updated' | 'failed'; error?: string }[] = []

  for (const emp of employees) {
    const { error: updateError } = await service.auth.admin.updateUserById(emp.id, {
      user_metadata: {
        full_name: emp.full_name,
        role: emp.role,
        tmc_id: emp.tmc_id,
        company_id: emp.company_id,
      },
    })

    if (updateError) {
      results.push({ id: emp.id, status: 'failed', error: updateError.message })
    } else {
      results.push({ id: emp.id, status: 'updated' })
    }
  }

  const updated = results.filter(r => r.status === 'updated').length
  const failed = results.filter(r => r.status === 'failed').length

  return Response.json({ ok: true, updated, failed, results })
}