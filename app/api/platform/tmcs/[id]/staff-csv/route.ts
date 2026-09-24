import { requirePlatformAdmin } from '@/app/lib/permissions/requirePlatformAdmin'
import { inviteRedirectUrl } from '@/app/lib/onboarding/onboardTmc'
import { PERMISSION_KEYS, isPermissionKey } from '@/app/lib/permissions/permissionKeys'
import { NextRequest } from 'next/server'
import { createServiceClient } from '@/utils/supabase/service'
import { db, transaction } from '@/app/lib/db'
import * as tmcs from '@/app/lib/repositories/tmcs'
import * as employees from '@/app/lib/repositories/employees'
import { route } from '@/app/lib/http/handler'

// ── /api/platform/tmcs/[id]/staff-csv ────────────────────────────────────────
// GET   downloads the TMC's counsellors as CSV
// POST  creates the ones that do not exist yet
//
// THE DOWNLOAD IS THE UPLOAD TEMPLATE — the columns match exactly, so the
// workflow is export, edit in a spreadsheet, re-upload. Handing someone a blank
// template to fill from scratch is how column-name mismatches happen. Same
// decision as the traveller-profile CSV, and the same reason.
//
// WHERE IT DIFFERS FROM THAT ONE, AND WHY
// The traveller CSV refuses to create people: a row for an unknown email is
// reported back rather than acted on, because creating an account has side
// effects that belong to the add-employee flow. Here creating IS the point —
// this exists to stand up a new TMC's desk in one go — so an unknown email
// becomes an invite. An email that already exists is SKIPPED, never updated:
// re-uploading a file must not silently change someone's permissions.
//
// Permissions travel as a semicolon-separated list in one column rather than a
// column per key. A column per key means the file's shape changes every time a
// permission is added, and every previously exported file becomes wrong.
// ─────────────────────────────────────────────────────────────────────────────

const COLUMNS = ['email', 'full_name', 'role', 'status', 'permissions'] as const

const MAX_ROWS = 500

function escapeCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

type Ctx = { params: Promise<{ id: string }> }

export const GET = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const check = await requirePlatformAdmin()
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const tmc = await tmcs.tmc(db, id)
  if (!tmc) {
    return Response.json({ error: 'TMC not found' }, { status: 404 })
  }

  const staff = await employees.staffOfTmc(db, id, 'name')
  const perms = await employees.permissionsFor(db, staff.map(r => r.id))

  const byEmployee = new Map<string, string[]>()
  for (const p of perms) {
    byEmployee.set(p.employee_id, [...(byEmployee.get(p.employee_id) ?? []), p.permission_key])
  }

  const body = [
    COLUMNS.join(','),
    ...staff.map(r => [
      r.email,
      r.full_name,
      r.role,
      r.status,
      (byEmployee.get(r.id) ?? []).join(';'),
    ].map(escapeCell).join(',')),
  ].join('\n')

  const filename = `${tmc.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-staff.csv`

  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
})

interface ImportRow {
  email?: string
  full_name?: string
  role?: string
  permissions?: string
}


export const POST = route(async (req: NextRequest, { params }: Ctx) => {
  const { id } = await params
  const check = await requirePlatformAdmin()
  if (!check.ok) {
    return Response.json({ error: check.error }, { status: check.status })
  }

  const tmc = await tmcs.tmc(db, id)
  if (!tmc) {
    return Response.json({ error: 'TMC not found' }, { status: 404 })
  }

  const { rows }: { rows?: ImportRow[] } = await req.json()

  if (!Array.isArray(rows) || rows.length === 0) {
    return Response.json({ error: 'The file has no rows' }, { status: 400 })
  }
  if (rows.length > MAX_ROWS) {
    return Response.json({ error: `Maximum ${MAX_ROWS} rows per upload` }, { status: 400 })
  }

  const known = new Set((await employees.staffOfTmc(db, id)).map(e => e.email.toLowerCase()))
  const auth = createServiceClient().auth.admin

  const errors: { row: number; email: string; error: string }[] = []
  let created = 0
  let skipped = 0

  // One at a time, not a bulk insert: each row means an auth invite, which is an
  // API call that can fail on its own, and a bad row must not take the rest of
  // the file down with it. Failures are collected and reported per row.
  for (const [i, row] of rows.entries()) {
    const rowNumber = i + 2 // +1 for the header, +1 for 1-based counting
    const email = row.email?.trim().toLowerCase()
    const fullName = row.full_name?.trim()

    if (!email || !fullName) {
      errors.push({ row: rowNumber, email: email ?? '', error: 'Missing email or full_name' })
      continue
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ row: rowNumber, email, error: 'Not a valid email address' })
      continue
    }

    // Already here: skipped, not updated. A re-uploaded export must not rewrite
    // permissions somebody has since changed in the UI.
    if (known.has(email)) { skipped++; continue }

    // tmc_admin is deliberately NOT importable. Creating admins in bulk from a
    // spreadsheet is the wrong shape for the highest tenant privilege — the
    // single-admin invite above is the deliberate path for that.
    const role = (row.role?.trim() || 'tc').toLowerCase()
    if (role !== 'tc') {
      errors.push({ row: rowNumber, email, error: `Only "tc" can be imported, not "${role}"` })
      continue
    }

    const requested = (row.permissions ?? '')
      .split(';')
      .map(p => p.trim())
      .filter(Boolean)

    const invalid = requested.filter(p => !isPermissionKey(p))
    if (invalid.length > 0) {
      errors.push({
        row: rowNumber, email,
        error: `Unknown permission(s): ${invalid.join(', ')}. Valid: ${PERMISSION_KEYS.join(', ')}`,
      })
      continue
    }

    let authUserId: string | null = null

    try {
      const { data: authData, error: inviteError } = await auth.inviteUserByEmail(email, {
        redirectTo: inviteRedirectUrl(),
        data: { full_name: fullName, tmc_id: id, role: 'tc' },
      })

      if (inviteError) throw new InviteRefused(inviteError.message)
      const userId = authData.user.id
      authUserId = userId

      // The person and their permissions together: a row that fails half way
      // no longer leaves a counsellor with none of the access they were given.
      // granted_by is null: that column is a foreign key to `employees`, and a
      // platform admin has no employees row by design.
      await transaction(async (tx) => {
        await employees.insertCounsellor(tx, { id: userId, tmc_id: id, full_name: fullName, email })
        await employees.grantPermissions(tx, userId, requested, null)
      }, { tenantId: id })

      known.add(email)
      created++
    } catch (err) {
      // Compensating rollback for this row only — same reasoning as onboardTmc:
      // the auth user is not inside any database transaction, so it has to be
      // undone explicitly or it becomes an account nothing in the app can see.
      if (authUserId) await auth.deleteUser(authUserId)
      if (!(err instanceof InviteRefused)) console.error('[staff-csv] row failed', { rowNumber, err })
      errors.push({
        row: rowNumber, email,
        error: err instanceof InviteRefused ? err.message : 'Could not create this account',
      })
    }
  }

  return Response.json({ ok: true, created, skipped, errors })
})

// The auth service refused the invite; its message is shown for the row.
class InviteRefused extends Error {}
