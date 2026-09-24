import { createClient } from '@/utils/supabase/server'
import { authoriseClient } from '../route'
import { NextRequest } from 'next/server'
import { db } from '@/app/lib/db'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import { route } from '@/app/lib/http/handler'

// ── /api/tmc/traveler-profiles/csv ───────────────────────────────────────────
// GET  ?clientId=   downloads the current roster as CSV
// POST               applies an edited CSV back
//
// The download IS the upload template — the columns match exactly, so the
// workflow is export, edit in a spreadsheet, re-upload. Handing someone a blank
// template to fill from scratch is how column-name mismatches happen.
//
// Matched on email, which is unique per client, so a re-upload updates people
// rather than duplicating them. Rows for unknown emails are reported back
// rather than creating employees: creating an account has side effects
// (auth user, invite email) that belong to the add-employee flow, not to a
// spreadsheet edit.
//
// meal_preference is deliberately absent. It changes per trip and is asked at
// booking time, so carrying it in a roster file is noise.
// ─────────────────────────────────────────────────────────────────────────────

const COLUMNS = [
  'email', 'full_name', 'band', 'cost_centre', 'department', 'designation',
  'title', 'gender', 'date_of_birth',
  'passport_number', 'passport_expiry', 'nationality', 'issuing_country',
  'mobile', 'address', 'city', 'state', 'zip_code',
] as const

// CSV column -> traveler_profile key. Anything absent here is a column on
// employees itself and handled separately.
const PROFILE_COLUMN_MAP: Record<string, string> = {
  title: 'title',
  gender: 'gender',
  date_of_birth: 'dateOfBirth',
  passport_number: 'passportNumber',
  passport_expiry: 'passportExpiryDate',
  nationality: 'nationality',
  issuing_country: 'issuingCountry',
  mobile: 'mobile',
  address: 'address',
  city: 'city',
  state: 'state',
  zip_code: 'zipCode',
}

function escapeCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  // Quote when the value contains a delimiter, a quote, or a newline —
  // addresses routinely contain commas.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const GET = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) {
    return Response.json({ error: 'clientId is required' }, { status: 400 })
  }

  const access = await authoriseClient(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const [roster, client] = await Promise.all([
    employees.rosterForExport(db, clientId),
    clients.clientName(db, clientId),
  ])

  const rows = roster.map(e => {
    const profile = e.traveler_profile ?? {}
    return COLUMNS.map(col => {
      if (col === 'email') return escapeCell(e.email)
      if (col === 'full_name') return escapeCell(e.full_name)
      if (col === 'band') return escapeCell(e.band_code)
      if (col === 'cost_centre') return escapeCell(e.cost_centre)
      if (col === 'department') return escapeCell(e.department)
      if (col === 'designation') return escapeCell(e.designation)
      return escapeCell(profile[PROFILE_COLUMN_MAP[col]])
    }).join(',')
  })

  const csv = [COLUMNS.join(','), ...rows].join('\r\n')
  const filename = `${(client?.name ?? 'client').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-traveller-profiles.csv`

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
})

interface ImportRow {
  email?: string
  [key: string]: string | undefined
}

interface ImportBody {
  clientId: string
  rows: ImportRow[]
}

export const POST = route(async (req: NextRequest) => {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: ImportBody = await req.json()
  const { clientId, rows } = body

  if (!clientId || !Array.isArray(rows)) {
    return Response.json({ error: 'clientId and rows are required' }, { status: 400 })
  }
  if (rows.length === 0) {
    return Response.json({ error: 'The file has no rows' }, { status: 400 })
  }
  if (rows.length > 1000) {
    return Response.json({ error: 'Maximum 1000 rows per upload' }, { status: 400 })
  }

  const access = await authoriseClient(user.id, clientId)
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status })
  }

  const [people, bands, centres] = await Promise.all([
    employees.profilesByEmail(db, clientId),
    employees.bandsForClient(db, clientId),
    clients.costCentres(db, clientId),
  ])

  const byEmail = new Map(people.map(e => [e.email.toLowerCase(), e]))
  const bandByCode = new Map(bands.map(b => [b.code.toLowerCase(), b]))
  const centreCodes = new Set(centres.map(c => c.code.toLowerCase()))

  const errors: { row: number; email: string; error: string }[] = []
  let updated = 0

  // Applied one row at a time rather than as a bulk upsert: each row merges into
  // that person's existing traveler_profile, and a bad row should not take the
  // rest of the file down with it.
  for (const [i, row] of rows.entries()) {
    const rowNumber = i + 2 // +1 for the header, +1 for 1-based counting
    const email = row.email?.trim().toLowerCase()

    if (!email) {
      errors.push({ row: rowNumber, email: '', error: 'Missing email' })
      continue
    }

    const employee = byEmail.get(email)
    if (!employee) {
      errors.push({ row: rowNumber, email, error: 'No employee at this client with that email' })
      continue
    }

    const update: employees.TravellerEdit = {}

    if (row.full_name?.trim()) update.full_name = row.full_name.trim()
    if (row.department !== undefined) update.department = row.department.trim() || null
    if (row.designation !== undefined) update.designation = row.designation.trim() || null

    if (row.band?.trim()) {
      const band = bandByCode.get(row.band.trim().toLowerCase())
      if (!band) {
        errors.push({ row: rowNumber, email, error: `Band "${row.band.trim()}" is not configured` })
        continue
      }
      update.band_id = band.id
      update.band_code = band.code
      update.band_rank = band.rank
    }

    if (row.cost_centre !== undefined) {
      const code = row.cost_centre.trim()
      if (code && !centreCodes.has(code.toLowerCase())) {
        errors.push({ row: rowNumber, email, error: `Cost centre "${code}" does not exist` })
        continue
      }
      update.cost_centre = code || null
    }

    const existingProfile: employees.ProfileJson = employee.traveler_profile ?? {}
    const profilePatch: employees.ProfileJson = {}

    for (const [column, key] of Object.entries(PROFILE_COLUMN_MAP)) {
      const value = row[column]
      if (value === undefined) continue
      const trimmed = value.trim()
      // An empty cell clears that field rather than being ignored — otherwise a
      // value could never be removed through the spreadsheet.
      if (trimmed) profilePatch[key] = trimmed
      else delete existingProfile[key]
    }

    if (Object.keys(profilePatch).length > 0 || row.date_of_birth !== undefined) {
      update.traveler_profile = { ...existingProfile, ...profilePatch }
    }

    if (Object.keys(update).length === 0) continue

    // A failed row is reported and the rest of the file carries on. The
    // database's own text is logged, not echoed into the report.
    try {
      await employees.applyTravellerEdit(db, employee.id, update)
    } catch (err) {
      console.error('[traveler-profiles/csv] row failed', rowNumber, err)
      errors.push({ row: rowNumber, email, error: 'Could not save this row' })
      continue
    }

    updated++
  }

  return Response.json({ ok: true, updated, skipped: errors.length, errors: errors.slice(0, 50) })
})
