import { db } from '@/app/lib/db'
import { sql, maybeOne } from '@/app/lib/db/sql'
import type { TestUser } from './session'

// ── Real users from the template, by role ────────────────────────────────────
// Characterisation tests need realistic callers: a TMC admin whose TMC has
// clients, a corporate admin whose client has bookings. Chosen by a stable
// ORDER BY, so the same person is picked on every run and snapshots hold.
// ─────────────────────────────────────────────────────────────────────────────

export interface Actor extends TestUser {
  id: string
  role: string
  tmc_id: string | null
  client_id: string | null
}

export interface Actors {
  tmcAdmin: Actor
  tc: Actor | null
  corpAdmin: Actor
  manager: Actor | null
  employee: Actor | null
  platformAdmin: { id: string } | null
  // A TMC admin of a DIFFERENT TMC, for cross-tenant denial tests.
  otherTmcAdmin: Actor | null
}

let cached: Actors | null = null

const COLUMNS = sql`e.id, e.email, e.role, e.tmc_id, e.client_id`

export async function actors(): Promise<Actors> {
  if (cached) return cached

  // The TMC with the most clients is the one with the most to exercise.
  const tmcAdmin = await maybeOne<Actor>(db, sql`
    select ${COLUMNS} from employees e
    where e.role = 'tmc_admin' and e.status = 'active'
    order by (select count(*) from clients c where c.tmc_id = e.tmc_id) desc, e.created_at, e.id
    limit 1`)
  if (!tmcAdmin) throw new Error('[tests] no active tmc_admin in cbt_template')

  const corpAdmin = await maybeOne<Actor>(db, sql`
    select ${COLUMNS} from employees e
    where e.role = 'admin' and e.status = 'active' and e.client_id is not null
    order by (select count(*) from bookings b where b.client_id = e.client_id) desc, e.created_at, e.id
    limit 1`)
  if (!corpAdmin) throw new Error('[tests] no active corporate admin in cbt_template')

  const byRole = (role: string) => maybeOne<Actor>(db, sql`
    select ${COLUMNS} from employees e
    where e.role = ${role} and e.status = 'active'
    order by e.created_at, e.id limit 1`)

  const [tc, manager, employee, platformAdmin, otherTmcAdmin] = await Promise.all([
    maybeOne<Actor>(db, sql`
      select ${COLUMNS} from employees e
      where e.role = 'tc' and e.status = 'active'
      order by (e.tmc_id = ${tmcAdmin.tmc_id}) desc, e.created_at, e.id limit 1`),
    byRole('manager'),
    byRole('employee'),
    maybeOne<{ id: string }>(db, sql`select user_id as id from platform_admins order by created_at, user_id limit 1`),
    maybeOne<Actor>(db, sql`
      select ${COLUMNS} from employees e
      where e.role = 'tmc_admin' and e.status = 'active' and e.tmc_id <> ${tmcAdmin.tmc_id}
      order by e.created_at, e.id limit 1`),
  ])

  cached = { tmcAdmin, tc, corpAdmin, manager, employee, platformAdmin, otherTmcAdmin }
  return cached
}
