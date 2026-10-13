// ── npm run demo:seed / npm run demo:remove ──────────────────────────────────
// A large, fully configured, entirely made-up TMC in your own dev database
// (cbt_local), to click through at realistic size:
//
//   npm run demo:seed                    medium: 2,000 clients (the default)
//   npm run demo:seed -- --size small    300 clients
//   npm run demo:seed -- --size full     10,000 clients
//   npm run demo:seed -- --logins        new demo password + demo-logins.txt only
//   npm run demo:remove                  deletes the demo TMC and everything in it
//
// EVERYTHING IS GENERATED HERE. Nothing is copied from existing rows:
// cbt_local is a restore of production (real names, emails, passport numbers),
// and the scale harness's approach -- cloning a real row thousands of times --
// would spread one real person's details across the demo. Every name, email,
// itinerary and passenger below is made up.
//
// IT IS ITS OWN TMC, "Demo Scale TMC", so it never mixes with yours, and
// demo:remove can take it out exactly. Every email ends @…demo….example.test.
//
// SIGN-INS: one random password is generated, only its argon2id hash is
// stored (the same parameters as app/lib/auth/password.ts), and the password
// with a who's-who table is written to demo-logins.txt (git-ignored). About 45
// people can sign in: the TMC admin, 20 travel counsellors, and four people at
// each of six showcase clients. Everyone else has no login, like staff who
// were invited and never joined.
//
// Runs as the database OWNER (MIGRATE_DATABASE_URL, else DATABASE_URL), one
// transaction per stage: a failure leaves no half-built stage behind.
// ─────────────────────────────────────────────────────────────────────────────

import pg from 'pg'
import { hash } from '@node-rs/argon2'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TMC_NAME = 'Demo Scale TMC'
const DOMAIN = 'demo-tmc.example.test'
// Same as app/lib/auth/password.ts.
const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 }

const SIZES = {
  small:  { clients: 300,    peoplePerClient: 4, bookings: 2_000,  trips: 500,    groups: 10,  buckets: 20,  deals: 150, dealAssign: 1_000,  fops: 40,  fopAssign: 300,   rules: 60,  ruleAssign: 600 },
  medium: { clients: 2_000,  peoplePerClient: 4, bookings: 12_000, trips: 3_000,  groups: 40,  buckets: 100, deals: 600, dealAssign: 5_000,  fops: 150, fopAssign: 1_500, rules: 240, ruleAssign: 3_000 },
  full:   { clients: 10_000, peoplePerClient: 5, bookings: 60_000, trips: 15_000, groups: 200, buckets: 500, deals: 5_000, dealAssign: 50_000, fops: 1_000, fopAssign: 10_000, rules: 2_000, ruleAssign: 20_000 },
}
const TC_COUNT = 20

// The six clients built to look different on the dashboards.
const SHOWCASE = [
  { key: 'large',    name: 'Demo Large Corp',        slug: 'demo-large-corp',     people: 400, bookings: 2_500, note: 'busiest client: ~2,500 bookings, busy 8-week trend' },
  { key: 'approve',  name: 'Demo Approvals Co',      slug: 'demo-approvals-co',   people: 60,  bookings: 300,   note: 'many pending approvals, several waiting over 10 hours (urgent)' },
  { key: 'new',      name: 'Demo New Client',        slug: 'demo-new-client',     people: 25,  bookings: 0,     note: 'no bookings yet: counted as "yet to book"' },
  { key: 'desk',     name: 'Demo Desk-Booked Ltd',   slug: 'demo-desk-booked',    people: 40,  bookings: 200,   note: 'CBT only: its people cannot self-book; the desk books for them' },
  { key: 'nomarkup', name: 'Demo No Markup Inc',     slug: 'demo-no-markup',      people: 40,  bookings: 250,   note: 'markup switched off, discount on: loss-making on commercial coverage' },
  { key: 'shared',   name: 'Demo Shared Portfolio',  slug: 'demo-shared',         people: 30,  bookings: 150,   note: 'looked after by two travel counsellors' },
]

// ── Setup ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const command = args[0]
const flag = name => args.includes(`--${name}`)
const option = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }

function envValue(name) {
  if (process.env[name]) return process.env[name]
  const path = join(process.cwd(), '.env.local')
  if (!existsSync(path)) return undefined
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`))
    if (m) return m[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}

const url = envValue('MIGRATE_DATABASE_URL') ?? envValue('DATABASE_URL')
if (!url) { console.error('[demo] DATABASE_URL is not set in .env.local'); process.exit(1) }
const host = new URL(url).hostname
if (!['localhost', '127.0.0.1', '::1'].includes(host) && !flag('yes-remote')) {
  console.error(`[demo] ${host} is not a local database. This is for your own dev database; pass --yes-remote to override.`)
  process.exit(1)
}

const c = new pg.Client({ connectionString: url })
await c.connect()
const one = async (sql, params) => (await c.query(sql, params)).rows[0]
const stage = async (label, fn) => {
  const t0 = performance.now()
  await c.query('begin')
  try {
    await fn()
    await c.query('commit')
  } catch (err) {
    await c.query('rollback')
    throw err
  }
  console.info(`[demo] ${label.padEnd(44)} ${Math.round(performance.now() - t0)} ms`)
}
const demoTmc = async () => (await one('select id from tmcs where name = $1', [TMC_NAME]))?.id ?? null

try {
  if (command === 'seed' && flag('logins')) await writeLogins(await demoTmc())
  else if (command === 'seed') await seed(option('size') ?? 'medium')
  else if (command === 'remove') await remove()
  else console.error('usage: node scripts/demo-tmc.mjs seed [--size small|medium|full] [--logins] | remove')
} finally {
  await c.end()
}

// ── Seed ─────────────────────────────────────────────────────────────────────

async function seed(size) {
  const n = SIZES[size]
  if (!n) throw new Error(`--size must be one of ${Object.keys(SIZES).join(', ')}`)
  if (await demoTmc()) {
    console.error(`[demo] "${TMC_NAME}" already exists. Run npm run demo:remove first.`)
    process.exitCode = 1
    return
  }
  console.info(`[demo] building "${TMC_NAME}" (${size}: ${n.clients.toLocaleString('en-IN')} clients)`)
  // The scale seed's spread: deterministic, so two runs build the same demo.
  const T = `current_setting('demo.tmc')::uuid`

  await stage('TMC, branches, payment types, categories', async () => {
    const { id } = await one(`insert into tmcs (name, status) values ($1, 'active') returning id`, [TMC_NAME])
    await c.query(`select set_config('demo.tmc', $1, false)`, [id])
    await c.query(`
      insert into branches (tmc_id, name, branch_no, is_head_office, status, country, gst_state, gst_city, iata_number, office_id)
      values (${T}, 'Demo Head Office, Mumbai', 'DM001', true, 'active', 'India', 'Maharashtra', 'Mumbai', '14300011', 'BOMDM28AA'),
             (${T}, 'Demo North, Delhi', 'DM002', false, 'active', 'India', 'Delhi', 'New Delhi', '14300022', 'DELDM28AA'),
             (${T}, 'Demo South, Bengaluru', 'DM003', false, 'active', 'India', 'Karnataka', 'Bengaluru', '14300033', 'BLRDM28AA')`)
    // The defaults every TMC is given (as in the anonymised template).
    await c.query(`
      insert into fop_payment_types (tmc_id, code, label, requires_card) values
        (${T}, 'CC', 'Credit card', true), (${T}, 'CL', 'Credit limit', false)`)
    await c.query(`
      insert into fop_gds_entries (tmc_id, code, label) values
        (${T}, 'CC', 'Credit card - passed through to the airline'),
        (${T}, 'INVAGT', 'Agency invoice - agency settles, card charged separately')`)
    await c.query(`
      insert into deal_code_categories (tmc_id, code, label) values
        (${T}, 'DOMAIRBSP', 'Domestic - BSP settled'), (${T}, 'INTAIRBSP', 'International - BSP settled'),
        (${T}, 'DOMAIRLCC', 'Domestic - LCC direct connect'), (${T}, 'INTAIRLCC', 'International - LCC direct connect')`)
    await c.query(`
      insert into deal_code_category_types (category_id, code_type, allowed)
      select k.id, t.code_type, not (k.code like '%LCC' and t.code_type in ('PF', 'TC'))
      from deal_code_categories k cross join (values ('PC'), ('TR'), ('DC'), ('PF'), ('TC')) t(code_type)
      where k.tmc_id = ${T}`)
  })

  await stage('TMC admin and 20 travel counsellors', async () => {
    await c.query(`
      insert into employees (tmc_id, full_name, email, role, status, onboarding_method, first_login_completed, designation, branch_id)
      select ${T}, 'Demo TMC Admin', 'admin@${DOMAIN}', 'tmc_admin', 'active', 'invite', true, 'Head of Operations',
             (select id from branches where tmc_id = ${T} and is_head_office)`)
    await c.query(`
      insert into employees (tmc_id, full_name, email, role, status, onboarding_method, first_login_completed, designation, branch_id)
      select ${T}, 'Demo Counsellor ' || lpad(g::text, 2, '0'), 'tc' || lpad(g::text, 2, '0') || '@${DOMAIN}', 'tc', 'active', 'invite', true,
             case when g <= 4 then 'Senior Travel Counsellor' when g >= 19 then 'Reporting Analyst' else 'Travel Counsellor' end,
             (select id from branches where tmc_id = ${T} order by branch_no offset (g % 3) limit 1)
      from generate_series(1, ${TC_COUNT}) g`)
    await c.query(`create temp table d_tcs as
      select id, row_number() over (order by email) rn from employees where tmc_id = ${T} and role = 'tc'`)
    // Mixed powers: everyone the everyday desk work, and booking for
    // travellers; 1-4 seniors also the masters; 15-16 desk work without
    // booking; 19-20 read-only reporting.
    await c.query(`
      insert into employee_permissions (employee_id, permission_key)
      select t.id, p from d_tcs t, unnest(
        case when t.rn >= 19 then array['view_reports']
             when t.rn <= 4 then array['manage_clients', 'manage_users', 'manage_approvals', 'view_reports',
                                       'manage_deal_codes', 'manage_commercials', 'manage_fops', 'manage_policy',
                                       'book_on_behalf']
             when t.rn in (15, 16) then array['manage_clients', 'manage_users', 'manage_approvals', 'view_reports']
             else array['manage_clients', 'manage_users', 'manage_approvals', 'view_reports', 'book_on_behalf'] end) p`)
  })

  await stage('client groups, clients, buckets', async () => {
    await c.query(`
      insert into client_groups (tmc_id, name, city, country, group_code)
      select ${T}, 'Demo Group ' || lpad(g::text, 3, '0'), (array['Mumbai','Delhi','Bengaluru','Pune','Chennai','Hyderabad'])[1 + g % 6], 'India', 'DG' || g
      from generate_series(1, ${n.groups}) g`)
    await c.query(`create temp table d_groups as
      select id, row_number() over (order by name) rn from client_groups where tmc_id = ${T}`)
    // The showcase clients first, then numbered ones.
    await c.query(`
      insert into clients (tmc_id, name, status, setup_completed, size, booking_mode, client_code, city, country, email,
                           client_group_id, branch_id, markup_active, discount_active)
      select ${T}, s.name, 'active', true, case when s.people > 200 then '201-1000' else '51-200' end,
             case when s.key = 'desk' then 'cbt' else 'both' end, upper(left(replace(s.slug, '-', ''), 10)),
             'Mumbai', 'India', 'travel@' || s.slug || '.example.test',
             (select id from d_groups where rn = 1), (select id from branches where tmc_id = ${T} and is_head_office),
             s.key <> 'nomarkup', true
      from jsonb_to_recordset($1::jsonb) as s(key text, name text, slug text, people int)`, [JSON.stringify(SHOWCASE)])
    await c.query(`
      insert into clients (tmc_id, name, status, setup_completed, size, booking_mode, client_code, city, country, email,
                           client_group_id, branch_id)
      select ${T}, 'Demo Client ' || lpad(g::text, 5, '0'), case when g % 50 = 0 then 'inactive' else 'active' end, true,
             (array['1-50','51-200','201-1000','1001+'])[1 + g % 4], (array['sbt','both','both','cbt'])[1 + g % 4],
             'DC' || lpad(g::text, 5, '0'), (array['Mumbai','Delhi','Bengaluru','Pune','Chennai','Hyderabad'])[1 + g % 6], 'India',
             'travel@client' || g || '.demo.example.test',
             (select id from d_groups where rn = 1 + abs(hashint8(g::bigint)) % ${n.groups}),
             (select id from branches where tmc_id = ${T} order by branch_no offset (g % 3) limit 1)
      from generate_series(1, ${n.clients - SHOWCASE.length}) g`)
    await c.query(`create temp table d_clients as
      select id, name, row_number() over (order by name) rn from clients where tmc_id = ${T}`)
    await c.query(`create index on d_clients (rn)`)
    await c.query(`
      insert into buckets (tmc_id, name, code, description)
      select ${T}, 'Demo Bucket ' || lpad(g::text, 3, '0'), 'DB' || g,
             (array['Star Alliance FY26 contracts','Government rates','Pharma vertical','IT services','Startups'])[1 + g % 5]
      from generate_series(1, ${n.buckets}) g`)
    await c.query(`create temp table d_buckets as
      select id, row_number() over (order by name) rn from buckets where tmc_id = ${T}`)
    await c.query(`create index on d_buckets (rn)`)
    await c.query(`
      insert into bucket_clients (bucket_id, client_id)
      select b.id, k.id from d_clients k
      join d_buckets b on b.rn in (1 + (k.rn * 7) % ${n.buckets}, 1 + (k.rn * 13 + 5) % ${n.buckets})
      on conflict do nothing`)
  })

  await stage('counsellor portfolios', async () => {
    // Each counsellor owns a slice of the clients; one in ten is shared with
    // the next counsellor (cover and backup).
    await c.query(`
      insert into employee_client_access (employee_id, client_id)
      select t.id, k.id from d_clients k join d_tcs t on t.rn = 1 + (k.rn % ${TC_COUNT})
      union
      -- The backup is a different counsellor for each shared client, so the
      -- extra load spreads evenly instead of landing on two people.
      select t.id, k.id from d_clients k
      join d_tcs t on t.rn = 1 + ((k.rn % ${TC_COUNT}) + 1 + (k.rn / 10) % (${TC_COUNT} - 1)) % ${TC_COUNT}
      where k.rn % 10 = 0
      union
      select t.id, k.id from d_clients k join d_tcs t on t.rn in (1, 2) where k.name = 'Demo Shared Portfolio'`)
  })

  await stage('bands, cost centres, policies, approval chains', async () => {
    await c.query(`
      insert into bands (client_id, code, label, rank)
      select k.id, 'L' || r, (array['Staff','Associate','Manager','Director','VP & Above'])[r], r
      from d_clients k, generate_series(1, 5) r`)
    await c.query(`
      insert into cost_centres (client_id, code, name)
      select k.id, cc.code, cc.name from d_clients k, (values ('SALES', 'Sales'), ('OPS', 'Operations')) cc(code, name)`)

    // Three policy groups covering the five ranks without overlap, each with
    // the flight rules the policy engine checks.
    await c.query(`
      insert into policy_groups (tmc_id, name, code, description) values
        (${T}, 'Demo Junior Staff', 'DJ', 'Bands L1-L2: economy, tight caps'),
        (${T}, 'Demo Managers', 'DM', 'Bands L3-L4: premium economy long-haul'),
        (${T}, 'Demo Leadership', 'DL', 'Band L5: business long-haul')`)
    await c.query(`
      insert into policy_group_band_ranks (policy_group_id, band_rank)
      select g.id, r from policy_groups g, generate_series(1, 5) r
      where g.tmc_id = ${T} and ((g.code = 'DJ' and r <= 2) or (g.code = 'DM' and r in (3, 4)) or (g.code = 'DL' and r = 5))`)
    await c.query(`
      insert into policy_rules (tmc_id, policy_group_id, travel_type, limit_key, limit_value, limit_bool, version)
      select ${T}, g.id, 'flight', r.k, case g.code when 'DJ' then r.j when 'DM' then r.m else r.l end, r.b, 1
      from policy_groups g, (values
        ('max_fare_domestic', 7000::numeric, 12000::numeric, 25000::numeric, null::boolean),
        ('max_fare_intl', 40000, 80000, 200000, null),
        ('cabin_class_short_haul', 0, 0, 1, null),
        ('cabin_class_long_haul', 0, 1, 2, null),
        ('max_seat_selection_fee', 400, 800, 2000, null),
        ('advance_booking_days', 7, 3, 0, null),
        ('connecting_flights_allowed', null, null, null, true),
        ('refundable_fare_required', null, null, null, false)
      ) r(k, j, m, l, b)
      where g.tmc_id = ${T}`)
    await c.query(`
      insert into client_policy_groups (client_id, policy_group_id)
      select k.id, g.id from d_clients k, policy_groups g where g.tmc_id = ${T}`)

    // Approval chains: a manager's sign-off; a manager then finance for red;
    // and finance only for red.
    await c.query(`
      insert into approval_chain_templates (tmc_id, name, code, description, mode, quorum, tiers, version) values
        (${T}, 'Demo Manager approval', 'DMA', 'The traveller''s manager, for amber and red', 'sequential', 'all',
         '[{"tier": 1, "label": "Manager", "min_verdict": "amber"}]', 1),
        (${T}, 'Demo Manager then finance', 'DMF', 'Manager for amber; finance as well for red', 'sequential', 'all',
         '[{"tier": 1, "label": "Manager", "min_verdict": "amber"}, {"tier": 2, "label": "Finance", "min_verdict": "red"}]', 1),
        (${T}, 'Demo Finance for red', 'DFR', 'Only red bookings, to finance', 'sequential', 'all',
         '[{"tier": 1, "label": "Finance", "min_verdict": "red"}]', 1)`)
    await c.query(`
      insert into client_default_approval_templates (client_id, category, template_id)
      select k.id, cat, (select id from approval_chain_templates where tmc_id = ${T} and code =
               case when k.name = 'Demo Approvals Co' then 'DMF' else (array['DMA','DMF','DFR'])[1 + k.rn % 3] end)
      from d_clients k, unnest(array['air', 'hotel']) cat`)
    await c.query(`
      insert into approval_tier_approvers (client_id, template_id, tier, approver_type)
      select k.id, t.id, (tier ->> 'tier')::int,
             case when tier ->> 'label' = 'Finance' then 'finance_role' else 'manager' end
      from d_clients k cross join approval_chain_templates t cross join jsonb_array_elements(t.tiers) tier
      where t.tmc_id = ${T}`)
  })

  await stage('deal codes, payment methods, commercial rules', async () => {
    const assign = (table, owner, owners, count) => c.query(`
      insert into ${table} (tmc_id, ${owner}, kind, client_id, client_group_id, bucket_id)
      select ${T}, o.id,
        case when g % 20 < 14 then 'client' when g % 20 < 17 then 'client_group' else 'bucket' end,
        case when g % 20 < 14 then (select id from d_clients where rn = 1 + abs(hashint8(g::bigint)) % ${n.clients}) end,
        case when g % 20 between 14 and 16 then (select id from d_groups where rn = 1 + abs(hashint8(g::bigint)) % ${n.groups}) end,
        case when g % 20 >= 17 then (select id from d_buckets where rn = 1 + abs(hashint8(g::bigint)) % ${n.buckets}) end
      from generate_series(1, ${count}) g
      join ${owners} o on o.rn = 1 + abs(hashint8(g::bigint * 7 + 3)) % (select count(*) from ${owners})
      on conflict do nothing`)

    await c.query(`
      insert into deal_codes (tmc_id, category_id, airline_code, code, code_type, flight_spec, sales_from, sales_to, travel_from, travel_to, notes)
      select ${T}, (select id from deal_code_categories where tmc_id = ${T} and code = (array['DOMAIRBSP','INTAIRBSP','DOMAIRBSP','DOMAIRLCC'])[1 + g % 4]),
             a.code, 'DM' || lpad(g::text, 5, '0'),
             case when (array['DOMAIRBSP','INTAIRBSP','DOMAIRBSP','DOMAIRLCC'])[1 + g % 4] like '%LCC' then (array['PC','TR','DC'])[1 + g % 3]
                  else (array['PC','TR','DC','PF','TC'])[1 + g % 5] end,
             case when g % 9 = 0 then (100 + g % 800)::text || '-' || (150 + g % 800)::text end,
             date '2026-04-01', case when g % 15 = 0 then date '2026-09-30' else date '2027-03-31' end,
             null, null, 'Demo negotiated rate ' || g
      from generate_series(1, ${n.deals}) g,
           lateral (select (array['AI','6E','UK','SG','EK','BA','SQ','LH'])[1 + g % 8] as code) a`)
    await c.query(`create temp table d_deals as select id, row_number() over (order by code) rn from deal_codes where tmc_id = ${T}`)
    await assign('deal_code_assignments', 'deal_code_id', 'd_deals', n.dealAssign)

    await c.query(`
      insert into forms_of_payment (tmc_id, label, fop_code, fop_type, payer, card_type, last4, expiry_month, expiry_year,
                                    payment_type_id, gds_entry_id, owner_client_id, branch_id, is_default)
      select ${T},
             case when g = 1 then 'Demo agency credit limit' else 'Demo corporate card ' || g end,
             'DF' || g,
             case when g = 1 then 'cash' else 'card' end,
             case when g = 1 then 'agency' else 'corporate' end,
             case when g = 1 then null else (array['AX','VI','CA'])[1 + g % 3] end,
             case when g = 1 then null else lpad((1000 + g)::text, 4, '0') end,
             case when g = 1 then null else 1 + g % 12 end,
             case when g = 1 then null else 2027 + g % 3 end,
             (select id from fop_payment_types where tmc_id = ${T} and code = case when g = 1 then 'CL' else 'CC' end),
             (select id from fop_gds_entries where tmc_id = ${T} and code = case when g = 1 then 'INVAGT' else 'CC' end),
             case when g = 1 then null else (select id from d_clients where rn = 1 + abs(hashint8(g::bigint)) % ${n.clients}) end,
             null, g = 1
      from generate_series(1, ${n.fops}) g`)
    await c.query(`create temp table d_fops as select id, row_number() over (order by fop_code) rn from forms_of_payment where tmc_id = ${T}`)
    await assign('fop_assignments', 'fop_id', 'd_fops', n.fopAssign)

    // Markups, discounts and processing fees in equal shares.
    await c.query(`
      insert into commercial_rules (tmc_id, kind, category_id, airline_code, cabin, fare_type, calc_type, calc_on, rate,
                                    calc_basis, exclude_tax_codes, include_ssr, notes)
      select ${T}, k.kind,
             (select id from deal_code_categories where tmc_id = ${T} and code = (array['DOMAIRBSP','INTAIRBSP','DOMAIRLCC'])[1 + g % 3]),
             case when g % 4 = 0 then (array['AI','6E','UK','SG'])[1 + g % 4] end,
             case when g % 6 = 0 then 'Y' end, 'all',
             case when k.kind = 'processing_fee' or g % 5 = 0 then 'fixed' else 'percent' end,
             case when k.kind = 'processing_fee' then 'tf' else (array['bf','tf'])[1 + g % 2] end,
             case when k.kind = 'processing_fee' or g % 5 = 0 then 100 + (g % 8) * 50 else 1 + (g % 6) * 0.5 end,
             case when k.kind = 'processing_fee' then (array['per_transaction','per_sector'])[1 + g % 2] end,
             case when k.kind = 'processing_fee' then array[]::text[] end,
             case when k.kind = 'processing_fee' then false end,
             'Demo ' || replace(k.kind, '_', ' ') || ' ' || g
      from generate_series(1, ${Math.ceil(n.rules / 3)}) g,
           (values ('markup'), ('discount'), ('processing_fee')) k(kind)`)
    await c.query(`create temp table d_rules as select id, row_number() over (order by notes) rn from commercial_rules where tmc_id = ${T}`)
    await assign('commercial_rule_assignments', 'rule_id', 'd_rules', n.ruleAssign)
  })

  await stage('people at every client', async () => {
    // Per client: an admin, a finance user, a manager, and travellers who
    // report to the manager. Showcase clients get their own headcount.
    await c.query(`create temp table d_size as
      select k.id as client_id, k.name, k.rn,
             coalesce(s.people, ${n.peoplePerClient}) as people, s.slug, s.key
      from d_clients k left join jsonb_to_recordset($1::jsonb) as s(key text, name text, slug text, people int) on s.name = k.name`,
      [JSON.stringify(SHOWCASE)])
    await c.query(`
      insert into employees (client_id, full_name, email, role, status, onboarding_method, first_login_completed,
                             band_id, band_code, band_rank, department, cost_centre, designation, top_of_hierarchy)
      select z.client_id,
             case p when 1 then 'Admin ' when 2 then 'Finance ' when 3 then 'Manager ' else 'Traveller ' || (p - 3) || ' ' end || z.name,
             case p when 1 then 'admin' when 2 then 'finance' when 3 then 'manager' else 'traveller' || (p - 3) end
               || '@' || coalesce(z.slug, 'client' || z.rn) || '.demo.example.test',
             case p when 1 then 'admin' when 2 then 'finance' else 'employee' end,
             'active', 'invite', p <= 4 and z.slug is not null,
             b.id, b.code, b.rank,
             (array['Sales','Engineering','Operations','Finance'])[1 + p % 4],
             (array['SALES','OPS'])[1 + p % 2],
             case p when 1 then 'Travel Administrator' when 2 then 'Finance Controller' when 3 then 'Team Manager' else 'Executive' end,
             p = 3
      from d_size z
      cross join lateral generate_series(1, z.people) p
      join bands b on b.client_id = z.client_id and b.rank = case p when 1 then 5 when 2 then 4 when 3 then 4 else 1 + p % 3 end`)
    // Everyone below the manager reports to them; the admin and finance to
    // the manager too, except the manager, who tops the hierarchy.
    await c.query(`
      update employees e set manager_id = m.id
      from employees m
      where m.client_id = e.client_id and m.email like 'manager@%' and e.id <> m.id
        and e.client_id in (select client_id from d_size)`)
    await c.query(`create temp table d_people as
      select e.id, e.client_id, row_number() over (order by e.id) rn
      from employees e where e.client_id in (select client_id from d_size)`)
    await c.query(`create index on d_people (rn)`)
  })

  await stage('trips, bookings, approvals', async () => {
    // A synthetic itinerary: made-up passengers, no passport numbers.
    const itinerary = (g, dep) => `jsonb_build_object(
      'cabin', 'Economy', 'isLcc', ${g} % 4 = 0, 'isNdc', ${g} % 3 = 0, 'stops', '[]'::jsonb, 'stopCount', 0,
      'origin', jsonb_build_object('city', r.oc, 'code', r.o, 'name', r.oc || ' Airport', 'dateTime', to_char(${dep}, 'YYYY-MM-DD"T"HH24:MI:SS'), 'terminal', '1'),
      'destination', jsonb_build_object('city', r.dc, 'code', r.d, 'name', r.dc || ' Airport', 'dateTime', to_char(${dep} + interval '2 hours 10 minutes', 'YYYY-MM-DD"T"HH24:MI:SS'), 'terminal', '2'),
      'airline', jsonb_build_object('code', r.a, 'name', r.an), 'baseFare', f.base, 'totalFare', f.base + f.tax, 'currency', 'INR',
      'duration', '02:10', 'provider', '1A', 'refundable', ${g} % 5 = 0, 'bookingCode', 'Y')`
    const routes = `(values ('BOM','Mumbai','DEL','New Delhi','AI','Air India'), ('DEL','New Delhi','BLR','Bengaluru','6E','IndiGo'),
      ('BLR','Bengaluru','HYD','Hyderabad','UK','Vistara'), ('MAA','Chennai','BOM','Mumbai','AI','Air India'),
      ('BOM','Mumbai','GOI','Goa','6E','IndiGo'), ('DEL','New Delhi','DXB','Dubai','EK','Emirates'),
      ('BOM','Mumbai','LHR','London','BA','British Airways'), ('BLR','Bengaluru','SIN','Singapore','SQ','Singapore Airlines'))`

    // Bookings per client: the showcase sizes, the rest spread over people.
    const showcaseBookings = SHOWCASE.reduce((s, x) => s + x.bookings, 0)
    await c.query(`create temp table d_booking_plan as
      select z.client_id, p.id as employee_id, g as n
      from d_size z
      join lateral (select id from employees where client_id = z.client_id order by id) p on true
      cross join lateral generate_series(1, case
        when z.key is not null then (select s.bookings from jsonb_to_recordset($1::jsonb) as s(name text, bookings int) where s.name = z.name) / greatest(1, z.people)
        else 0 end) g
      where z.key is not null`, [JSON.stringify(SHOWCASE.map(s => ({ name: s.name, bookings: s.bookings })))])
    await c.query(`
      insert into d_booking_plan (client_id, employee_id, n)
      select p.client_id, p.id, g from generate_series(1, ${Math.max(0, n.bookings - showcaseBookings)}) g
      join d_people p on p.rn = 1 + abs(hashint8(g::bigint)) % (select count(*) from d_people)
      where p.client_id not in (select client_id from d_size where key is not null)`)

    await c.query(`
      insert into trips (client_id, created_by, name, status, travel_date, created_at, updated_at)
      select p.client_id, p.id, (array['Client visit','Sales conference','Quarterly review','Site audit','Training'])[1 + g % 5] || ' ' || g,
             case when g % 7 = 0 then 'completed' else 'open' end,
             current_date + (g % 90 - 30), now() - (g % 180) * interval '1 day', now() - (g % 180) * interval '1 day'
      from generate_series(1, ${n.trips}) g
      join d_people p on p.rn = 1 + abs(hashint8(g::bigint * 11)) % (select count(*) from d_people)
      where p.client_id not in (select client_id from d_size where key = 'new')`)
    // The people you can sign in as get trips of their own, so My trips has
    // something in it (the random spread above may miss them).
    await c.query(`
      insert into trips (client_id, created_by, name, status, travel_date, created_at, updated_at)
      select e.client_id, e.id, t.name, t.status, current_date + t.days, now() - (t.days + 40) * interval '1 day', now() - t.days * interval '1 day'
      from employees e
      join d_size z on z.client_id = e.client_id and z.key is not null and z.key <> 'new'
      cross join (values ('Client visit, Pune', 'open', 12), ('Annual offsite, Goa', 'open', 30), ('Sales conference, Dubai', 'completed', -20)) t(name, status, days)
      where split_part(e.email, '@', 1) in ('admin', 'finance', 'manager', 'traveller1')`)

    // Each traveller's first trip, looked up once rather than per booking.
    // Each traveller's trips, numbered, so their bookings spread over them.
    await c.query(`create temp table d_trip as
      select created_by, id, row_number() over (partition by created_by order by id) rn,
             count(*) over (partition by created_by) n
      from trips where tmc_id = ${T}`)
    await c.query(`create index on d_trip (created_by)`)
    await c.query(`
      insert into bookings (client_id, employee_id, booking_type, status, policy_status, policy_verdict, total_cost, sell_total,
                            pnr, itinerary, traveler_snapshot, fare_breakdown, trip_id, provider, is_ndc, created_at, updated_at)
      select b.client_id, b.employee_id, 'flight', s.status, 'evaluated', s.verdict, f.base + f.tax,
             round((f.base + f.tax) * case when k.markup_active then 1.03 else 0.98 end),
             case when s.status in ('ticketed', 'held') then upper(substr(md5(b.employee_id::text || g), 1, 6)) end,
             ${itinerary('b.g', "(now() + ((b.g % 120) - 40) * interval '1 day')")},
             jsonb_build_object('Email', e.email, 'Mobile', '9000000000', 'CountryCode', 'IN', 'CountryName', 'India',
               'PassengerDetails', jsonb_build_array(jsonb_build_object(
                 'Title', 'Mr', 'Gender', 'M', 'PaxType', 'ADT', 'FirstName', split_part(e.full_name, ' ', 1),
                 'LastName', 'Demo', 'Nationality', 'IN', 'PassportNumber', null, 'DateOfBirth', '1990-01-01'))),
             jsonb_build_object('currency', 'INR', 'fareType', 'NRM', 'isRefundable', g % 5 = 0,
               'passengerBreakup', jsonb_build_array(jsonb_build_object('PaxType', 'ADT', 'BaseFare', f.base, 'Tax', f.tax, 'TotalFare', f.base + f.tax))),
             d_trip.id,
             '1A', g % 3 = 0,
             -- The large client's bookings crowd the last eight weeks.
             now() - (case when k.name = 'Demo Large Corp' then g % 56 else g % 180 end) * interval '1 day' - (g % 24) * interval '1 hour',
             now() - (g % 180) * interval '1 day'
      from (select *, row_number() over () as g from d_booking_plan) b
      join employees e on e.id = b.employee_id
      join clients k on k.id = b.client_id
      -- Three in four bookings sit in one of the traveller's trips.
      left join d_trip on d_trip.created_by = b.employee_id and b.g % 4 <> 0 and d_trip.rn = 1 + b.g % d_trip.n
      cross join lateral (select * from ${routes} as r(o, oc, d, dc, a, an) offset (b.g % 8) limit 1) r
      cross join lateral (select (3000 + (b.g * 37) % 9000) as base, (900 + (b.g * 13) % 1500) as tax) f
      cross join lateral (select case
          when k.name = 'Demo Approvals Co' and b.g % 3 <> 0 then 'pending_approval'
          when b.g % 11 = 0 then 'pending_approval' when b.g % 13 = 0 then 'rejected'
          when b.g % 17 = 0 then 'held' when b.g % 19 = 0 then 'cancelled' else 'ticketed' end as status,
        case when b.g % 11 = 0 or b.g % 13 = 0 then 'amber' when b.g % 23 = 0 then 'red' else 'green' end as verdict) s`)

    // An approval for every booking that went through one: pending for those
    // waiting (some for hours -- the urgent ones), decided for the rest.
    await c.query(`
      insert into approvals (client_id, booking_id, approver_id, tier, status, verdict, reason, actioned_at, created_at, chain_template_id)
      select b.client_id, b.id, coalesce(e.manager_id, e.id), 1,
             case b.status when 'pending_approval' then 'pending' when 'rejected' then 'rejected' else 'approved' end,
             coalesce(b.policy_verdict, 'amber'), 'Demo: outside policy',
             case when b.status = 'pending_approval' then null else b.created_at + interval '3 hours' end,
             case when b.status = 'pending_approval' then now() - (abs(hashint8(hashtext(b.id::text)::bigint)) % 36) * interval '1 hour' else b.created_at end,
             (select template_id from client_default_approval_templates where client_id = b.client_id and category = 'air')
      from bookings b join employees e on e.id = b.employee_id
      where b.client_id in (select client_id from d_size)
        and (b.status in ('pending_approval', 'rejected') or b.policy_verdict in ('amber', 'red'))`)
  })

  await stage('sign-ins and demo-logins.txt', async () => { await writeLogins(await demoTmc(), true) })
  // VACUUM as well as ANALYZE: freshly bulk-loaded rows are not yet marked
  // all-visible, so an index-only read still visits every row until the
  // next autovacuum -- 4x slower dashboard counts than a database in normal
  // running would ever show. This is the state autovacuum leaves it in.
  await c.query('vacuum analyze')
  await report()
}

// One password for every demo sign-in, hashed as the app hashes; the plain
// password is written only to demo-logins.txt.
async function writeLogins(tmcId, inStage = false) {
  if (!tmcId) { console.error(`[demo] "${TMC_NAME}" does not exist. Run npm run demo:seed first.`); process.exitCode = 1; return }
  const password = `demo-${randomBytes(9).toString('base64url')}`
  const passwordHash = await hash(password, ARGON2)
  const run = async () => {
    // Who can sign in: the TMC admin, every counsellor, and four people at
    // each showcase client.
    const { rows } = await c.query(`
      select e.id, e.email, e.full_name, e.role, k.name as client
      from employees e left join clients k on k.id = e.client_id
      where (e.tmc_id = $1 and e.role in ('tmc_admin', 'tc'))
         or (k.tmc_id = $1 and k.name = any($2) and split_part(e.email, '@', 1) in ('admin', 'finance', 'manager', 'traveller1'))
      order by e.role <> 'tmc_admin', e.role <> 'tc', k.name nulls first, e.email`, [tmcId, SHOWCASE.map(s => s.name)])
    for (const r of rows) {
      await c.query(`
        insert into accounts (id, email, password_hash, must_change_password, email_verified_at, password_changed_at)
        values ($1, $2, $3, false, now(), now())
        on conflict (id) do update set password_hash = excluded.password_hash, must_change_password = false`,
        [r.id, r.email, passwordHash])
      await c.query('update employees set auth_user_id = $1, first_login_completed = true where id = $1', [r.id])
    }
    // Any old demo sessions end: the password changed.
    await c.query(`update sessions set revoked_at = now() where account_id = any($1) and revoked_at is null`, [rows.map(r => r.id)])
    return rows
  }
  const rows = inStage ? await run() : await (async () => {
    await c.query('begin')
    try { const r = await run(); await c.query('commit'); return r } catch (e) { await c.query('rollback'); throw e }
  })()

  const portfolio = new Map((await c.query(`
    select e.email, count(a.client_id)::int n from employees e left join employee_client_access a on a.employee_id = e.id
    where e.tmc_id = $1 and e.role = 'tc' group by e.email`, [tmcId])).rows.map(r => [r.email, r.n]))
  const perms = new Map((await c.query(`
    select e.email, string_agg(p.permission_key, ', ' order by p.permission_key) p from employees e
    join employee_permissions p on p.employee_id = e.id where e.tmc_id = $1 group by e.email`, [tmcId])).rows.map(r => [r.email, r.p]))
  const notes = new Map(SHOWCASE.map(s => [s.name, s.note]))
  const lines = [
    `Demo sign-ins for "${TMC_NAME}" -- local dev only. Do not commit (git-ignored).`,
    `Generated ${new Date().toISOString()}. Sign in at http://localhost:3000/login`,
    '',
    `Password for every account below:  ${password}`,
    '',
    'TMC side',
    ...rows.filter(r => r.role === 'tmc_admin' || r.role === 'tc').map(r =>
      `  ${r.email.padEnd(34)} ${r.role === 'tmc_admin' ? 'TMC admin -- sees all clients' :
        `counsellor, ${portfolio.get(r.email) ?? 0} clients; can: ${perms.get(r.email) ?? '-'}`}`),
    '',
    'Client side (four people at each showcase client)',
    ...SHOWCASE.flatMap(s => [
      `  ${s.name} -- ${notes.get(s.name)}`,
      ...rows.filter(r => r.client === s.name).map(r => `    ${r.email.padEnd(46)} ${r.role === 'employee' ? (r.email.startsWith('manager') ? 'manager (approves for their team)' : 'traveller') : r.role}`),
    ]),
    '',
    'New password at any time:  npm run demo:seed -- --logins',
    'Remove the whole demo:     npm run demo:remove',
  ]
  writeFileSync(join(process.cwd(), 'demo-logins.txt'), lines.join('\n') + '\n')
  console.info(`[demo] ${rows.length} sign-ins ready; password and who's who in demo-logins.txt`)
}

async function report() {
  const tmc = await demoTmc()
  const { rows } = await c.query(`
    select 'clients' t, count(*) n from clients where tmc_id = $1 union all
    select 'people', count(*) from employees where tenant_tmc_id = $1 union all
    select 'bookings', count(*) from bookings where tmc_id = $1 union all
    select 'approvals', count(*) from approvals where tmc_id = $1 union all
    select 'trips', count(*) from trips where tmc_id = $1 union all
    select 'deal code assignments', count(*) from deal_code_assignments where tmc_id = $1 union all
    select 'commercial rule assignments', count(*) from commercial_rule_assignments where tmc_id = $1`, [tmc])
  console.info('[demo] built: ' + rows.map(r => `${r.t} ${Number(r.n).toLocaleString('en-IN')}`).join(' · '))
}

// ── Remove ───────────────────────────────────────────────────────────────────

async function remove() {
  const tmc = await demoTmc()
  if (!tmc) { console.error(`[demo] "${TMC_NAME}" not found; nothing to remove.`); process.exitCode = 1; return }
  await stage('removing the demo TMC', async () => {
    // Deleting thousands of people and clients one reference check at a time
    // took 100 s at medium size: 38 columns that point at employees or clients
    // have no index, so every deleted row scanned them all. So, for this one
    // transaction only, PostgreSQL's per-row reference checks are switched off
    // (session_replication_role, reverted at commit), every demo row is
    // deleted explicitly by its tenant columns -- and before committing, every
    // reference in the database is checked for anything left pointing at a
    // deleted row. One found, and the whole removal rolls back.
    await c.query(`set local session_replication_role = replica`)

    // What to find children by, captured before anything is deleted.
    await c.query(`create temp table r_people on commit drop as select id from employees where tenant_tmc_id = $1`, [tmc])
    await c.query(`create temp table r_groups on commit drop as select id from policy_groups where tmc_id = $1`, [tmc])
    await c.query(`create temp table r_categories on commit drop as select id from deal_code_categories where tmc_id = $1`, [tmc])

    await c.query(`delete from employee_permissions where employee_id in (select id from r_people)`)
    await c.query(`delete from employee_approval_templates where employee_id in (select id from r_people)`)
    await c.query(`delete from policy_group_band_ranks where policy_group_id in (select id from r_groups)`)
    await c.query(`delete from deal_code_category_types where category_id in (select id from r_categories)`)
    // Sign-in events and the like name the person but no TMC.
    await c.query(`delete from audit_log where user_id in (select id from r_people)`)
    await c.query(`delete from auth_attempts where key like '%demo%.example.test%'`)
    await c.query(`delete from sessions where account_id in (select id from r_people)`)
    await c.query(`delete from auth_tokens where account_id in (select id from r_people)`)
    await c.query(`delete from accounts where id in (select id from r_people)`)
    await c.query(`delete from employees where tenant_tmc_id = $1`, [tmc])

    // Every other table that carries a tenant: its demo rows.
    const { rows: tables } = await c.query(`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'tmc_id' and table_name not in ('tmcs', 'employees')
        and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')
      order by 1`)
    for (const { table_name: t } of tables) await c.query(`delete from ${t} where tmc_id = $1`, [tmc])
    await c.query(`delete from tmcs where id = $1`, [tmc])

    // Nothing anywhere may still point at a row that was just deleted.
    const { rows: refs } = await c.query(`
      select c.conrelid::regclass::text as child, a.attname as col, c.confrelid::regclass::text as parent, p.attname as pcol
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      join pg_attribute p on p.attrelid = c.confrelid and p.attnum = c.confkey[1]
      where c.contype = 'f' and cardinality(c.conkey) = 1 and c.connamespace = 'public'::regnamespace`)
    const dangling = []
    for (const r of refs) {
      const { rows } = await c.query(`
        select count(*)::int n from ${r.child} x
        where x.${r.col} is not null and not exists (select 1 from ${r.parent} y where y.${r.pcol} = x.${r.col})`)
      if (rows[0].n) dangling.push(`${r.child}.${r.col} -> ${r.parent}: ${rows[0].n}`)
    }
    if (dangling.length) throw new Error(`[demo] removal would leave broken references, rolled back:\n  ${dangling.join('\n  ')}`)
  })
  const left = await one(`
    select (select count(*) from clients where tmc_id = $1) + (select count(*) from employees where tenant_tmc_id = $1)
         + (select count(*) from bookings where tmc_id = $1) + (select count(*) from tmcs where id = $1) as n`, [tmc])
  console.info(`[demo] removed; every reference checked. Rows left: ${left.n}. demo-logins.txt can be deleted.`)
}
