import { sql, many, maybeOne, one, empty, type Queryable } from '@/app/lib/db/sql'
import { searchAcross, page } from '@/app/lib/db/fragments'
import type { PageParams } from '@/app/lib/pagination'

// ── The organization chart ───────────────────────────────────────────────────
// Owns no table: reads employees (manager_id) to answer, for one person in a
// company, who is above them (the manager chain to the top), beside them
// (peers: the same manager) and below them (direct reports), with counts.
// Everyone not deactivated counts; a company's own people only.
//
// The chain walk is a recursive query with a depth cap and a visited path, so
// a bad manager_id loop (A reports to B reports to A) ends instead of spinning.
// ─────────────────────────────────────────────────────────────────────────────

export interface OrgPerson {
  id: string
  full_name: string
  designation: string | null
  department: string | null
  email: string
  band_code: string | null
  role: string
  manager_id: string | null
  top_of_hierarchy: boolean
  direct_reports: number
}

const PERSON = sql`e.id, e.full_name, e.designation, e.department, e.email, e.band_code, e.role, e.manager_id,
  e.top_of_hierarchy,
  (select count(*)::int from employees r where r.manager_id = e.id and r.status <> 'deactivated') as direct_reports`

const CHAIN_CAP = 15

export async function person(db: Queryable, clientId: string, id: string): Promise<OrgPerson | null> {
  return maybeOne<OrgPerson>(db, sql`
    select ${PERSON} from employees e
    where e.id = ${id} and e.client_id = ${clientId} and e.status <> 'deactivated'`)
}

// Everyone above, nearest first, to the top or the cap.
export async function managerChain(db: Queryable, clientId: string, id: string): Promise<OrgPerson[]> {
  return many<OrgPerson>(db, sql`
    with recursive up(id, depth, path) as (
      select m.id, 1, array[s.id, m.id]
      from employees s join employees m on m.id = s.manager_id
      where s.id = ${id} and s.client_id = ${clientId} and m.client_id = ${clientId}
      union all
      select m.id, up.depth + 1, up.path || m.id
      from up join employees cur on cur.id = up.id
              join employees m on m.id = cur.manager_id
      where m.client_id = ${clientId} and not m.id = any(up.path) and up.depth < ${CHAIN_CAP}
    )
    select ${PERSON} from up join employees e on e.id = up.id
    where e.status <> 'deactivated'
    order by up.depth`)
}

export async function peers(db: Queryable, clientId: string, focus: OrgPerson, limit = 12): Promise<{ rows: OrgPerson[]; total: number }> {
  if (!focus.manager_id) return { rows: [], total: 0 }
  const where = sql`e.client_id = ${clientId} and e.manager_id = ${focus.manager_id} and e.id <> ${focus.id} and e.status <> 'deactivated'`
  const [rows, count] = await Promise.all([
    many<OrgPerson>(db, sql`select ${PERSON} from employees e where ${where} order by e.full_name, e.id limit ${limit}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from employees e where ${where}`),
  ])
  return { rows, total: count.n }
}

export async function directReports(db: Queryable, clientId: string, id: string, limit = 50): Promise<{ rows: OrgPerson[]; total: number }> {
  const where = sql`e.client_id = ${clientId} and e.manager_id = ${id} and e.status <> 'deactivated'`
  const [rows, count] = await Promise.all([
    many<OrgPerson>(db, sql`select ${PERSON} from employees e where ${where} order by e.full_name, e.id limit ${limit}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from employees e where ${where}`),
  ])
  return { rows, total: count.n }
}

// Everyone below, at any depth (the "total reports" Org Explorer shows).
export async function totalReports(db: Queryable, clientId: string, id: string): Promise<number> {
  return (await one<{ n: number }>(db, sql`
    with recursive down(id, depth, path) as (
      select e.id, 1, array[${id}::uuid, e.id] from employees e
      where e.manager_id = ${id} and e.client_id = ${clientId} and e.status <> 'deactivated'
      union all
      select e.id, down.depth + 1, down.path || e.id
      from down join employees e on e.manager_id = down.id
      where e.client_id = ${clientId} and e.status <> 'deactivated' and not e.id = any(down.path) and down.depth < 30
    )
    select count(distinct id)::int as n from down`)).n
}

// The people picker, and (for admins) who has no manager and is not the top.
export async function search(
  db: Queryable,
  clientId: string,
  f: { search?: string; unassigned?: boolean; page: Pick<PageParams, 'from' | 'to'> }
): Promise<{ rows: OrgPerson[]; total: number }> {
  const where = sql`e.client_id = ${clientId} and e.status <> 'deactivated'
    ${f.unassigned ? sql`and e.status = 'active' and e.manager_id is null and not e.top_of_hierarchy` : empty}
    ${searchAcross([sql`e.full_name`, sql`e.email`, sql`e.designation`, sql`e.department`], f.search)}`
  const [rows, count] = await Promise.all([
    many<OrgPerson>(db, sql`select ${PERSON} from employees e where ${where} order by e.full_name, e.id ${page(f.page)}`),
    one<{ n: number }>(db, sql`select count(*)::int as n from employees e where ${where}`),
  ])
  return { rows, total: count.n }
}
