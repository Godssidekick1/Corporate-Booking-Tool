import { describe, it, expect, beforeAll } from 'vitest'
import { GET as companyGet } from '@/app/api/settings/company/route'
import { GET as bandsGet } from '@/app/api/settings/bands/route'
import { GET as usersGet } from '@/app/api/settings/users/route'
import { PATCH as userPatch } from '@/app/api/settings/users/[id]/route'
import { GET as orgGet } from '@/app/api/org/route'
import { GET as orgPeopleGet } from '@/app/api/org/people/route'
import { call } from '../harness/call'
import { actors, type Actors } from '../harness/actors'
import { resetDatabase } from '../harness/db'
import { db } from '@/app/lib/db'
import { sql, one, many, exec } from '@/app/lib/db/sql'

// ── The company admin's Settings, and the org chart for everyone ─────────────
// Company: a read-only overview, never the TMC's commercial switches.
// Users: filters, and every role change audited. Bands: the client's own.
// Organization: a person's managers, peers and reports inside their own
// company; bands only for oneself or an admin; a manager loop never spins.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = Boolean(process.env.DATABASE_URL)
const d = HAS_DB ? describe : describe.skip

interface OrgCard { id: string; name: string; band?: string | null; directReports: number }
interface OrgAnswer {
  me: string
  focus: OrgCard & { totalReports: number }
  chain: OrgCard[]
  peers: { people: OrgCard[]; total: number }
  reports: { people: OrgCard[]; total: number }
  myChain: string[]
  unassigned?: number
}

d('corporate settings and the org chart', () => {
  let a: Actors
  let clientId: string
  // The org chart's own company (one with enough people) and its admin.
  let orgClient: string
  let orgAdmin: { id: string }
  // A small hierarchy built for the test: top <- mid <- (viewer, peer); viewer <- report.
  let top: { id: string }, mid: { id: string }, viewer: { id: string }, peer: { id: string }, report: { id: string }

  beforeAll(async () => {
    await resetDatabase()
    a = await actors()
    clientId = a.corpAdmin.client_id!
    // The corporate admin's own company, given five synthetic people of its own.
    orgClient = clientId
    orgAdmin = a.corpAdmin
    const band = await one<{ code: string }>(db, sql`select code from bands where client_id = ${orgClient} order by rank, id limit 1`)
    const people: { id: string }[] = []
    for (const n of [1, 2, 3, 4, 5]) {
      people.push(await one<{ id: string }>(db, sql`
        insert into employees (id, client_id, full_name, email, role, status, band_code)
        values (gen_random_uuid(), ${orgClient}, ${'Org Person ' + n}, ${'org' + n + '@org-chart.example.test'}, 'employee', 'active', ${band.code})
        returning id`))
    }
    expect(people.length).toBe(5)
    ;[top, mid, viewer, peer, report] = people
    await exec(db, sql`update employees set manager_id = null, top_of_hierarchy = true where id = ${top.id}`)
    await exec(db, sql`update employees set manager_id = ${top.id}, top_of_hierarchy = false where id = ${mid.id}`)
    await exec(db, sql`update employees set manager_id = ${mid.id}, top_of_hierarchy = false where id = any(${[viewer.id, peer.id]})`)
    await exec(db, sql`update employees set manager_id = ${viewer.id}, top_of_hierarchy = false where id = ${report.id}`)
  })

  // ── Company ────────────────────────────────────────────────────────────────

  it('company: the overview for an admin, never the commercial switches', async () => {
    const res = await call(companyGet, { as: a.corpAdmin, url: '/api/settings/company' })
    expect(res.status).toBe(200)
    const body = res.json as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['approvals', 'booking', 'figures', 'ok', 'people', 'profile', 'refunds', 'travelDesk'])
    const text = JSON.stringify(body)
    for (const secret of ['markup_active', 'discount_active', 'processing_fee_active', 'sap_customer_code', 'sap_group_code',
      'fop_priority', 'agency_fop_allowed', 'corporate_fop_allowed', 'bta_cta', 'tmcMargin', 'airline']) {
      expect(text).not.toContain(secret)
    }
    expect(body.people).toMatchObject({ active: expect.any(Number), admins: expect.any(Number), bands: expect.any(Array) })
  })

  it('company: refused for everyone but the company’s admins', async () => {
    expect((await call(companyGet, { as: a.employee!, url: '/api/settings/company' })).status).toBe(403)
    expect((await call(companyGet, { as: a.tmcAdmin, url: '/api/settings/company' })).status).toBe(403)
    expect((await call(companyGet, { as: null, url: '/api/settings/company' })).status).toBe(401)
  })

  // ── Bands ──────────────────────────────────────────────────────────────────

  it('bands: the client’s own, for its admins only', async () => {
    const res = await call(bandsGet, { as: a.corpAdmin, url: '/api/settings/bands' })
    expect(res.status).toBe(200)
    const bands = (res.json as { bands: { code: string }[] }).bands
    const own = await many<{ code: string }>(db, sql`select code from bands where client_id = ${clientId} order by rank, id`)
    expect(bands.map(b => b.code)).toEqual(own.map(b => b.code))
    expect((await call(bandsGet, { as: a.employee!, url: '/api/settings/bands' })).status).toBe(403)
  })

  // ── Users ──────────────────────────────────────────────────────────────────

  it('users: filtered by role and status, and bad filters refused', async () => {
    const admins = await call(usersGet, { as: a.corpAdmin, url: '/api/settings/users?role=admin&status=active' })
    expect(admins.status).toBe(200)
    const items = (admins.json as { items: { id: string; role: string; status: string }[] }).items
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(i => i.role === 'admin' && i.status === 'active')).toBe(true)
    expect(items.map(i => i.id)).toContain(a.corpAdmin.id)

    expect((await call(usersGet, { as: a.corpAdmin, url: '/api/settings/users?role=owner' })).status).toBe(400)
    expect((await call(usersGet, { as: a.corpAdmin, url: '/api/settings/users?status=gone' })).status).toBe(400)
  })

  it('users: a role change is audited; an unchanged role logs nothing', async () => {
    const target = peer.id
    const patch = (role: string) => call(userPatch, {
      as: orgAdmin, method: 'PATCH', url: `/api/settings/users/${target}`, params: { id: target }, body: { role },
    })
    expect((await patch('finance')).status).toBe(200)
    const logged = await one<{ metadata: unknown; user_id: string }>(db, sql`
      select metadata, user_id from audit_log where action = 'employee.role_changed' and entity_id = ${target}
      order by created_at desc limit 1`)
    expect(logged).toEqual({ metadata: { from: 'employee', to: 'finance', by: 'company_admin' }, user_id: orgAdmin.id })

    expect((await patch('employee')).status).toBe(200)
    const count = async () => (await one<{ n: number }>(db, sql`
      select count(*)::int as n from audit_log where action = 'employee.role_changed' and entity_id = ${target}`)).n
    const before = await count()
    expect((await patch('employee')).status).toBe(200)
    expect(await count()).toBe(before)

    // Bands stay the TMC's.
    const band = await call(userPatch, {
      as: orgAdmin, method: 'PATCH', url: `/api/settings/users/${target}`, params: { id: target }, body: { band: 'L1' },
    })
    expect(band.status).toBe(403)
  })

  // ── Organization ───────────────────────────────────────────────────────────

  const org = (as: { id: string } | null, focus?: string) =>
    call(orgGet, { as, url: `/api/org${focus ? `?focus=${focus}` : ''}` })

  it('org: opens on oneself, with the chain to the top, peers and reports', async () => {
    const res = await org(viewer)
    expect(res.status).toBe(200)
    const o = res.json as OrgAnswer
    expect(o.me).toBe(viewer.id)
    expect(o.focus.id).toBe(viewer.id)
    expect(o.chain.map(p => p.id)).toEqual([mid.id, top.id])
    expect(o.peers.people.map(p => p.id)).toEqual([peer.id])
    expect(o.peers.total).toBe(1)
    expect(o.reports.people.map(p => p.id)).toEqual([report.id])
    expect(o.focus.directReports).toBe(1)
    expect(o.myChain).toEqual([mid.id, top.id])

    const fromTop = (await org(viewer, top.id)).json as OrgAnswer
    expect(fromTop.chain).toEqual([])
    expect(fromTop.focus.totalReports).toBe(4)
    // The viewer's own line is still what the page highlights.
    expect(fromTop.myChain).toEqual([mid.id, top.id])
  })

  it('org: bands only on one’s own card, or for an admin', async () => {
    const own = (await org(viewer)).json as OrgAnswer
    expect(own.focus).toHaveProperty('band')
    expect(own.chain.every(p => p.band === undefined)).toBe(true)
    expect(own.reports.people.every(p => p.band === undefined)).toBe(true)

    const other = (await org(viewer, peer.id)).json as OrgAnswer
    expect(other.focus.band).toBeUndefined()

    const asAdmin = (await org(orgAdmin, peer.id)).json as OrgAnswer
    expect(asAdmin.focus).toHaveProperty('band')
    expect(asAdmin.unassigned).toEqual(expect.any(Number))
    expect(other.unassigned).toBeUndefined()
  })

  it('org: another company’s person is not found; the TMC and the signed-out are refused', async () => {
    const foreign = await one<{ id: string }>(db, sql`
      select id from employees where client_id is not null and client_id <> ${orgClient} and status = 'active'
      order by id limit 1`)
    expect((await org(viewer, foreign.id)).status).toBe(404)
    expect((await org(viewer, 'not-a-uuid')).status).toBe(404)
    expect((await org(a.tmcAdmin)).status).toBe(403)
    expect((await org(null)).status).toBe(401)
  })

  it('org: a manager loop ends instead of spinning', async () => {
    // top now reports to report: top -> report -> viewer -> mid -> top.
    await exec(db, sql`update employees set manager_id = ${report.id}, top_of_hierarchy = false where id = ${top.id}`)
    try {
      const res = await org(viewer)
      expect(res.status).toBe(200)
      const chain = (res.json as OrgAnswer).chain.map(p => p.id)
      expect(chain).toEqual([mid.id, top.id, report.id])
      expect((await org(viewer, top.id)).status).toBe(200)
    } finally {
      await exec(db, sql`update employees set manager_id = null, top_of_hierarchy = true where id = ${top.id}`)
    }
  })

  it('org people: search within one’s company; the unassigned list is for admins', async () => {
    const res = await call(orgPeopleGet, { as: viewer, url: '/api/org/people' })
    expect(res.status).toBe(200)
    const ids = (res.json as { items: { id: string }[] }).items.map(i => i.id)
    const companyIds = new Set((await many<{ id: string }>(db, sql`select id from employees where client_id = ${orgClient}`)).map(r => r.id))
    expect(ids.every(id => companyIds.has(id))).toBe(true)

    expect((await call(orgPeopleGet, { as: viewer, url: '/api/org/people?unassigned=1' })).status).toBe(403)
    const unassigned = await call(orgPeopleGet, { as: orgAdmin, url: '/api/org/people?unassigned=1' })
    expect(unassigned.status).toBe(200)
    expect((unassigned.json as { items: { id: string }[] }).items.map(i => i.id)).not.toContain(top.id)
  })
})
