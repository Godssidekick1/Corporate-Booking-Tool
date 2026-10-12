import pg from 'pg'

// ── Scale seed ───────────────────────────────────────────────────────────────
// Turns one TMC in the scale database (a copy of the anonymised test template)
// into a large one: thousands of clients, deal codes, payment methods and
// commercial rules, and tens of thousands of assignments between them.
//
// Every row is generated inside PostgreSQL (generate_series), copying a real
// row of the same kind so it satisfies every constraint the real ones do.
// Targets are spread with hashint8(g) rather than random(), so two runs
// produce the same data and their timings can be compared.
//
// Dev tooling only, run by `npm run scale`. Table and column names come from
// this file and from information_schema; every value is a bound parameter or
// a session setting.
// ─────────────────────────────────────────────────────────────────────────────

export interface ScaleSizes {
  clients: number
  groups: number
  buckets: number
  dealCodes: number
  dealAssignments: number
  fops: number
  fopAssignments: number
  rules: number
  ruleAssignments: number
  employees: number
  trips: number
  bookings: number
  heavyClientPeople: number
  heavyTrips: number
  heavyBookings: number
  heavyPending: number
  heavyDecided: number
}

const int = (name: string, fallback: number) => {
  const v = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(v) || v < 1) throw new Error(`${name} must be a positive integer`)
  return v
}

export function sizesFromEnv(): ScaleSizes {
  return {
    clients: int('SCALE_CLIENTS', 10_000),
    groups: int('SCALE_GROUPS', 200),
    buckets: int('SCALE_BUCKETS', 500),
    dealCodes: int('SCALE_DEAL_CODES', 5_000),
    dealAssignments: int('SCALE_DEAL_ASSIGNMENTS', 50_000),
    fops: int('SCALE_FOPS', 1_000),
    fopAssignments: int('SCALE_FOP_ASSIGNMENTS', 10_000),
    rules: int('SCALE_RULES', 2_000),
    ruleAssignments: int('SCALE_RULE_ASSIGNMENTS', 20_000),
    employees: int('SCALE_EMPLOYEES', 50_000),
    trips: int('SCALE_TRIPS', 15_000),
    bookings: int('SCALE_BOOKINGS', 60_000),
    heavyClientPeople: int('SCALE_HEAVY_CLIENT_PEOPLE', 5_000),
    heavyTrips: int('SCALE_HEAVY_TRIPS', 500),
    heavyBookings: int('SCALE_HEAVY_BOOKINGS', 2_000),
    heavyPending: int('SCALE_HEAVY_PENDING', 5_000),
    heavyDecided: int('SCALE_HEAVY_DECIDED', 20_000),
  }
}

// Copies one prototype row of `table` count times. Columns not overridden are
// copied as they are; `id` and anything in `skip` take their defaults.
async function cloneRows(
  c: pg.Client,
  table: string,
  protoWhere: string,
  count: number,
  overrides: Record<string, string>,
  skip: string[] = ['id']
): Promise<void> {
  const { rows } = await c.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = $1 order by ordinal_position`, [table])
  const cols = rows.map(r => r.column_name as string).filter(col => !skip.includes(col))
  const select = cols.map(col => overrides[col] ?? `p.${col}`)
  const proto = await c.query(`select 1 from ${table} where ${protoWhere} limit 1`)
  if (proto.rowCount === 0) throw new Error(`[scale] no prototype row in ${table} where ${protoWhere}`)
  await c.query(`
    insert into ${table} (${cols.join(', ')})
    select ${select.join(', ')}
    from (select * from ${table} where ${protoWhere} limit 1) p, generate_series(1, $1::int) g`, [count])
}

// A numbered lookup table (id, rn) the generators pick rows from by rn, once
// per generated row -- so it is indexed on rn: unindexed, 60,000 bookings each
// scanning 50,000 people is three billion row visits.
async function lookup(c: pg.Client, name: string, select: string, params: unknown[] = []): Promise<void> {
  await c.query(`create temp table ${name} as ${select}`, params)
  await c.query(`create index on ${name} (rn)`)
  await c.query(`analyze ${name}`)
}

// Spreads assignments over the three target kinds: 70% clients, 15% client
// groups, 15% buckets. Owner and target come from two different hashes of g,
// so pairs do not repeat; the odd duplicate (partial unique indexes) is skipped.
async function assign(c: pg.Client, table: string, ownerColumn: string, owners: string, count: number) {
  await c.query(`
    insert into ${table} (tmc_id, ${ownerColumn}, kind, client_id, client_group_id, bucket_id)
    select current_setting('scale.tmc')::uuid, o.id,
      case when g % 20 < 14 then 'client' when g % 20 < 17 then 'client_group' else 'bucket' end,
      case when g % 20 < 14 then (select id from s_clients where rn = 1 + abs(hashint8(g::bigint)) % (select count(*) from s_clients)) end,
      case when g % 20 between 14 and 16 then (select id from s_groups where rn = 1 + abs(hashint8(g::bigint)) % (select count(*) from s_groups)) end,
      case when g % 20 >= 17 then (select id from s_buckets where rn = 1 + abs(hashint8(g::bigint)) % (select count(*) from s_buckets)) end
    from generate_series(1, $1::int) g
    join ${owners} o on o.rn = 1 + abs(hashint8(g::bigint * 7 + 3)) % (select count(*) from ${owners})
    on conflict do nothing`, [count])
}

// The heavy person: an employee of a real client of the TMC, who becomes a
// frequent traveller and a busy approver.
export interface HeavyPerson { employeeId: string; clientId: string }

export async function seedScale(
  connectionString: string, tmcId: string, n: ScaleSizes, h: HeavyPerson
): Promise<Record<string, number>> {
  const c = new pg.Client({ connectionString })
  await c.connect()
  try {
    await c.query(`select set_config('scale.tmc', $1, false)`, [tmcId])
    const tmc = `tmc_id = current_setting('scale.tmc')::uuid`

    await c.query(`
      insert into client_groups (tmc_id, name)
      select current_setting('scale.tmc')::uuid, 'Scale group ' || g from generate_series(1, $1::int) g`, [n.groups])
    await lookup(c, 's_groups', `
      select id, row_number() over (order by id) rn from client_groups where ${tmc} and name like 'Scale group %'`)

    await cloneRows(c, 'clients', tmc, n.clients, {
      name: `'Scale client ' || g`,
      client_code: 'null',
      status: `'active'`,
      client_group_id: `(select id from s_groups where rn = 1 + g % ${n.groups})`,
      created_at: 'now()',
      // Every pricing switch on, so the booking-time lookups do their full work.
      markup_active: 'true', discount_active: 'true', processing_fee_active: 'true',
      agency_fop_allowed: 'true', corporate_fop_allowed: 'true',
    })
    await lookup(c, 's_clients', `
      select id, row_number() over (order by id) rn from clients where ${tmc} and name like 'Scale client %'`)

    await c.query(`
      insert into buckets (tmc_id, name)
      select current_setting('scale.tmc')::uuid, 'Scale bucket ' || g from generate_series(1, $1::int) g`, [n.buckets])
    await lookup(c, 's_buckets', `
      select id, row_number() over (order by id) rn from buckets where ${tmc} and name like 'Scale bucket %'`)
    // Every scale client in two buckets.
    await c.query(`
      insert into bucket_clients (bucket_id, client_id)
      select b.id, s.id from s_clients s
      join s_buckets b on b.rn in (1 + (s.rn * 7) % ${n.buckets}, 1 + (s.rn * 13 + 5) % ${n.buckets})
      on conflict do nothing`)

    await cloneRows(c, 'deal_codes', tmc, n.dealCodes, {
      code: `'SC' || g`, created_at: 'now()', updated_at: 'now()', created_by: 'null',
    })
    await lookup(c, 's_deals', `
      select id, row_number() over (order by id) rn from deal_codes where ${tmc} and code like 'SC%'`)
    await assign(c, 'deal_code_assignments', 'deal_code_id', 's_deals', n.dealAssignments)

    await cloneRows(c, 'forms_of_payment', `${tmc} and not is_default`, n.fops, {
      label: `'Scale card ' || g`, fop_code: `'SC' || g`, is_default: 'false',
      created_at: 'now()', updated_at: 'now()', created_by: 'null',
    })
    await lookup(c, 's_fops', `
      select id, row_number() over (order by id) rn from forms_of_payment where ${tmc} and fop_code like 'SC%'`)
    await assign(c, 'fop_assignments', 'fop_id', 's_fops', n.fopAssignments)

    // An equal share of each kind the TMC has (markup, discount, fee), each
    // copied from a rule of that kind so its calc_on stays valid.
    const kinds = (await c.query(`select distinct kind from commercial_rules where ${tmc} order by kind`)).rows.map(r => r.kind as string)
    for (const kind of kinds) {
      await cloneRows(c, 'commercial_rules', `${tmc} and kind = '${kind.replace(/'/g, "''")}'`, Math.ceil(n.rules / kinds.length), {
        created_at: 'now()', updated_at: 'now()', created_by: 'null', notes: `'Scale rule ' || g`,
      })
    }
    await lookup(c, 's_rules', `
      select id, row_number() over (order by id) rn from commercial_rules where ${tmc} and notes like 'Scale rule %'`)
    await assign(c, 'commercial_rule_assignments', 'rule_id', 's_rules', n.ruleAssignments)


    // ── What grows every working day ────────────────────────────────────────
    // People, their trips, bookings and approvals: spread over the scale
    // clients for volume, plus one HEAVY person in a real client (the
    // measuring actor) -- a frequent traveller and a busy approver -- whose
    // own lists are the ones that would slow down first.
    // As session settings, like scale.tmc: values never go into the SQL text.
    await c.query(`select set_config('scale.heavy', $1, false), set_config('scale.heavy_client', $2, false)`, [h.employeeId, h.clientId])
    // The first heavyClientPeople join the heavy person's own company -- a
    // large client, past the 1,000 the reporting tree loads -- the rest are
    // spread over the scale clients.
    await cloneRows(c, 'employees', `role = 'employee' and client_id is not null`, n.employees, {
      client_id: `case when g <= ${n.heavyClientPeople} then current_setting('scale.heavy_client')::uuid
                  else (select id from s_clients where rn = 1 + g % ${n.clients}) end`,
      email: `'scale.person.' || g || '@example.test'`, full_name: `'Scale person ' || g`,
      role: `'employee'`, status: `'active'`, auth_user_id: 'null', manager_id: 'null', band_id: 'null',
      branch_id: 'null', client_group_id: 'null', invited_by: 'null', tmc_id: 'null',
      top_of_hierarchy: 'false', created_at: 'now()',
    })
    await lookup(c, 's_people', `
      select e.id, e.client_id, row_number() over (order by e.id) rn
      from employees e join s_clients s on s.id = e.client_id`)

    await c.query(`
      insert into trips (client_id, created_by, name, status, created_at, updated_at)
      select p.client_id, p.id, 'Scale trip ' || g, 'open', now() - (g % 365) * interval '1 day', now() - (g % 365) * interval '1 day'
      from generate_series(1, $1::int) g
      join s_people p on p.rn = 1 + abs(hashint8(g::bigint)) % (select count(*) from s_people)`, [n.trips])

    // Bookings copy a real one (realistic itinerary and fare JSON).
    await cloneRows(c, 'bookings', 'true', n.bookings, {
      employee_id: `(select id from s_people where rn = 1 + abs(hashint8(g::bigint)) % (select count(*) from s_people))`,
      client_id: `(select client_id from s_people where rn = 1 + abs(hashint8(g::bigint)) % (select count(*) from s_people))`,
      trip_id: 'null', share_token: 'null', requested_for: 'null',
      created_at: `now() - (g % 365) * interval '1 day'`,
    })
    await c.query(`
      insert into approvals (client_id, booking_id, approver_id, tier, status, actioned_at, created_at)
      select b.client_id, b.id, b.employee_id, 1,
        case when g % 10 = 0 then 'pending' when g % 7 = 0 then 'rejected' else 'approved' end,
        case when g % 10 = 0 then null else b.created_at + interval '2 hours' end, b.created_at
      from (select id, client_id, employee_id, created_at, row_number() over (order by id) g
              from bookings where employee_id in (select id from s_people)) b`)

    // The heavy person: their trips, bookings (three in four inside a trip)
    // and an approval queue and history to work through.
    const heavy = { id: h.employeeId, client: h.clientId }
    await c.query(`
      insert into trips (client_id, created_by, name, status, created_at, updated_at)
      select $1, $2, 'Heavy trip ' || g, 'open', now() - g * interval '12 hours', now() - g * interval '12 hours'
      from generate_series(1, $3::int) g`, [heavy.client, heavy.id, n.heavyTrips])
    await lookup(c, 's_heavy_trips', `
      select id, row_number() over (order by id) rn from trips where created_by = $1 and name like 'Heavy trip %'`, [heavy.id])
    await cloneRows(c, 'bookings', 'true', n.heavyBookings, {
      employee_id: `current_setting('scale.heavy')::uuid`, client_id: `current_setting('scale.heavy_client')::uuid`,
      trip_id: `case when g % 4 = 0 then null else (select id from s_heavy_trips where rn = 1 + g % ${n.heavyTrips}) end`,
      share_token: 'null', requested_for: 'null', created_at: `now() - g * interval '3 hours'`,
    })
    await lookup(c, 's_heavy_bookings', `
      select id, row_number() over (order by id) rn from bookings where employee_id = $1`, [heavy.id])
    await c.query(`
      insert into approvals (client_id, booking_id, approver_id, tier, status, actioned_at, created_at)
      select $1, (select id from s_heavy_bookings where rn = 1 + g % (select count(*) from s_heavy_bookings)), $2, 10 + g % 5,
        case when g <= $3 then 'pending' when g % 3 = 0 then 'rejected' else 'approved' end,
        case when g <= $3 then null else now() - (g % 180) * interval '1 day' end,
        now() - (g % 200) * interval '1 day'
      from generate_series(1, $3::int + $4::int) g`, [heavy.client, heavy.id, n.heavyPending, n.heavyDecided])

    // VACUUM as well as ANALYZE: freshly bulk-loaded rows are not yet marked
    // all-visible, so an index-only read still visits every row until the
    // next autovacuum -- 4x slower dashboard counts than a database in normal
    // running would ever show. This is the state autovacuum leaves it in.
    await c.query('vacuum analyze')

    const counts: Record<string, number> = {}
    for (const t of ['clients', 'client_groups', 'buckets', 'bucket_clients', 'deal_codes', 'deal_code_assignments',
      'forms_of_payment', 'fop_assignments', 'commercial_rules', 'commercial_rule_assignments',
      'employees', 'trips', 'bookings', 'approvals']) {
      const where = ['bucket_clients', 'employees', 'trips', 'bookings', 'approvals'].includes(t) ? '' : ` where ${tmc}`
      counts[t] = (await c.query(`select count(*)::int n from ${t}${where}`)).rows[0].n
    }
    return counts
  } finally {
    await c.end()
  }
}
