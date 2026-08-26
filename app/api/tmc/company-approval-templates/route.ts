import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'
import { requireTmcPermission } from '@/app/lib/permissions/requireTmcPermission'
import { getTemplateBandRanks } from '@/app/lib/approval-engine/linkedApprovalTemplates'
import { NextRequest } from 'next/server'

// ── GET /api/tmc/company-approval-templates?companyId=<uuid> ─────────────────
// Every approval template linked to a company, with its category and rank
// coverage, plus the company's bands — so the UI can show which ranks are
// still uncovered in each category rather than making an admin work it out.
//
// ── POST /api/tmc/company-approval-templates ─────────────────────────────────
// Links a template to a company. Rejects if it would cover a rank another
// linked template already covers IN THE SAME CATEGORY. Different categories at
// the same rank are the normal arrangement, not a conflict.
//
// ── DELETE ?companyId=<uuid>&templateId=<uuid> ───────────────────────────────
// Unlinks. Doesn't touch the template or any other company using it.
// ─────────────────────────────────────────────────────────────────────────────

interface LinkBody {
  companyId: string
  templateId: string
}

function sharedRanks(a: number[], b: number[]): number[] {
  const bSet = new Set(b)
  return a.filter(rank => bSet.has(rank))
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const companyId = req.nextUrl.searchParams.get('companyId')
  if (!companyId) {
    return Response.json({ error: 'companyId is required' }, { status: 400 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_approvals', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  // Bands come back alongside the links so the UI can report coverage gaps in
  // the client's own vocabulary ("L3 Senior has no approval route") rather
  // than as bare rank numbers.
  const { data: bands } = await service
    .from('bands')
    .select('code, label, rank')
    .eq('company_id', companyId)
    .order('rank')

  const { data: links, error } = await service
    .from('company_approval_templates')
    .select('template_id, assigned_at')
    .eq('company_id', companyId)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const templateIds = (links ?? []).map(l => l.template_id)

  if (templateIds.length === 0) {
    return Response.json({ ok: true, links: [], bands: bands ?? [] })
  }

  const { data: templates } = await service
    .from('approval_chain_templates')
    .select('id, name, code, category, mode, quorum, tiers')
    .in('id', templateIds)

  const ranksByTemplate = await getTemplateBandRanks(service, templateIds)
  const templateById = new Map((templates ?? []).map(t => [t.id, t]))

  const enriched = (links ?? [])
    .map(l => {
      const template = templateById.get(l.template_id)
      return {
        templateId: l.template_id,
        assignedAt: l.assigned_at,
        template: template
          ? { ...template, bandRanks: ranksByTemplate.get(l.template_id) ?? [] }
          : null,
      }
    })
    .sort((a, b) => {
      const byCategory = (a.template?.category ?? '').localeCompare(b.template?.category ?? '')
      if (byCategory !== 0) return byCategory
      return (a.template?.bandRanks[0] ?? Infinity) - (b.template?.bandRanks[0] ?? Infinity)
    })

  return Response.json({ ok: true, links: enriched, bands: bands ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const body: LinkBody = await req.json()
  const { companyId, templateId } = body

  if (!companyId || !templateId) {
    return Response.json({ error: 'companyId and templateId are required' }, { status: 400 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_approvals', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { data: newTemplate } = await service
    .from('approval_chain_templates')
    .select('id, name, tmc_id, category')
    .eq('id', templateId)
    .maybeSingle()

  if (!newTemplate) {
    return Response.json({ error: 'Approval template not found' }, { status: 404 })
  }

  if (auth.tmcId !== newTemplate.tmc_id) {
    return Response.json({ error: 'This template belongs to a different TMC' }, { status: 403 })
  }

  // A crafted companyId from another TMC's client shouldn't be linkable even
  // if the caller passes the manage_approvals check generically.
  const { data: company } = await service
    .from('companies')
    .select('id, tmc_id')
    .eq('id', companyId)
    .maybeSingle()

  if (!company || company.tmc_id !== auth.tmcId) {
    return Response.json({ error: 'Company not found for this TMC' }, { status: 404 })
  }

  const { data: existingLinks } = await service
    .from('company_approval_templates')
    .select('template_id')
    .eq('company_id', companyId)

  const existingIds = (existingLinks ?? []).map(l => l.template_id)

  if (existingIds.includes(templateId)) {
    return Response.json({ error: `"${newTemplate.name}" is already linked to this company` }, { status: 409 })
  }

  const ranksByTemplate = await getTemplateBandRanks(service, [templateId, ...existingIds])
  const newRanks = ranksByTemplate.get(templateId) ?? []

  if (newRanks.length === 0) {
    return Response.json({
      error: `"${newTemplate.name}" covers no band ranks yet, so linking it would have no effect. Add ranks to the template first.`,
    }, { status: 400 })
  }

  if (existingIds.length > 0) {
    const { data: existingTemplates } = await service
      .from('approval_chain_templates')
      .select('id, name, category')
      .in('id', existingIds)

    for (const existing of existingTemplates ?? []) {
      // Only a clash within the same category matters — a company routinely
      // has one template for flights_hotels and another for misc at the same
      // ranks.
      if (existing.category !== newTemplate.category) continue

      const clash = sharedRanks(newRanks, ranksByTemplate.get(existing.id) ?? [])
      if (clash.length > 0) {
        return Response.json({
          error: `"${newTemplate.name}" overlaps with "${existing.name}" at band rank${clash.length > 1 ? 's' : ''} ${clash.join(', ')} for category ${newTemplate.category}. Each linked template must cover distinct ranks within a category.`,
        }, { status: 409 })
      }
    }
  }

  const { data: caller } = await service
    .from('employees')
    .select('id')
    .eq('id', user.id)
    .maybeSingle()

  const { error: insertError } = await service
    .from('company_approval_templates')
    .insert({
      company_id: companyId,
      template_id: templateId,
      assigned_by: caller?.id ?? null,
    })

  if (insertError) {
    // 23P01 is the company_approval_templates_no_overlap trigger — the
    // backstop for two links racing, where each read the pre-insert state.
    if (insertError.code === '23P01') {
      return Response.json({ error: insertError.message }, { status: 409 })
    }
    return Response.json({ error: insertError.message }, { status: 500 })
  }

  return Response.json({ ok: true }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const companyId = req.nextUrl.searchParams.get('companyId')
  const templateId = req.nextUrl.searchParams.get('templateId')

  if (!companyId || !templateId) {
    return Response.json({ error: 'companyId and templateId are required' }, { status: 400 })
  }

  const service = createServiceClient()
  const auth = await requireTmcPermission(service, user.id, 'manage_approvals', companyId)
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: auth.status ?? 403 })
  }

  const { error } = await service
    .from('company_approval_templates')
    .delete()
    .eq('company_id', companyId)
    .eq('template_id', templateId)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
