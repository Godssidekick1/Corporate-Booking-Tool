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

export async function seedScale(connectionString: string, tmcId: string, n: ScaleSizes): Promise<Record<string, number>> {
  const c = new pg.Client({ connectionString })
  await c.connect()
  try {
    await c.query(`select set_config('scale.tmc', $1, false)`, [tmcId])
    const tmc = `tmc_id = current_setting('scale.tmc')::uuid`

    await c.query(`
      insert into client_groups (tmc_id, name)
      select current_setting('scale.tmc')::uuid, 'Scale group ' || g from generate_series(1, $1::int) g`, [n.groups])
    await c.query(`create temp table s_groups as
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
    await c.query(`create temp table s_clients as
      select id, row_number() over (order by id) rn from clients where ${tmc} and name like 'Scale client %'`)

    await c.query(`
      insert into buckets (tmc_id, name)
      select current_setting('scale.tmc')::uuid, 'Scale bucket ' || g from generate_series(1, $1::int) g`, [n.buckets])
    await c.query(`create temp table s_buckets as
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
    await c.query(`create temp table s_deals as
      select id, row_number() over (order by id) rn from deal_codes where ${tmc} and code like 'SC%'`)
    await assign(c, 'deal_code_assignments', 'deal_code_id', 's_deals', n.dealAssignments)

    await cloneRows(c, 'forms_of_payment', `${tmc} and not is_default`, n.fops, {
      label: `'Scale card ' || g`, fop_code: `'SC' || g`, is_default: 'false',
      created_at: 'now()', updated_at: 'now()', created_by: 'null',
    })
    await c.query(`create temp table s_fops as
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
    await c.query(`create temp table s_rules as
      select id, row_number() over (order by id) rn from commercial_rules where ${tmc} and notes like 'Scale rule %'`)
    await assign(c, 'commercial_rule_assignments', 'rule_id', 's_rules', n.ruleAssignments)

    await c.query('analyze')

    const counts: Record<string, number> = {}
    for (const t of ['clients', 'client_groups', 'buckets', 'bucket_clients', 'deal_codes', 'deal_code_assignments',
      'forms_of_payment', 'fop_assignments', 'commercial_rules', 'commercial_rule_assignments']) {
      const where = t === 'bucket_clients' ? '' : ` where ${tmc}`
      counts[t] = (await c.query(`select count(*)::int n from ${t}${where}`)).rows[0].n
    }
    return counts
  } finally {
    await c.end()
  }
}
