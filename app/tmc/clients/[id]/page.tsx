'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import CountryDropdown from '@/app/components/CountryDropdown'
import StateDropdown from '@/app/components/StateDropdown'
import CityDropdown from '@/app/components/CityDropdown'
import SearchableSelect from '@/app/components/SearchableSelect'
import { useLookup } from '@/app/hooks/useLookup'
import { readGstin } from '@/app/lib/data/gstin'
import SettingsSection from './SettingsSection'
import Toggle from './Toggle'

// ── Corporate Settings ───────────────────────────────────────────────────────
// Everything the TMC configures about one client, in one place.
//
// THIS IS THE CLIENT DETAIL PAGE, not a screen beside it. Every per-client
// concern in this app — policy groups, approval templates, corporate cards,
// buckets — was configured master-first: pick the policy group, then the client.
// There was never a client-first view of any of it, and this route edited only
// the columns on the `clients` row and linked nowhere.
//
// Two doors onto one row is fine; two rows holding one fact is not. So the
// masters still DEFINE what a policy group or a chain contains, and this screen
// decides which one a client GETS.
// ─────────────────────────────────────────────────────────────────────────────

interface Client {
  id: string
  name: string
  status: string
  setup_completed: boolean
  timezone: string
  currency: string
  country: string | null
  booking_mode: 'sbt' | 'cbt' | 'both'
  client_group_id: string | null
  created_at: string
  registered_address: string | null
  gst_number: string | null
  industry: string | null
  primary_contact_phone: string | null
  size: string | null
  managed_by: string | null
  branch_id: string | null
  client_code: string | null
  sap_customer_code: string | null
  sap_group_code: string | null
  email: string | null
  phone: string | null
  address_1: string | null
  address_2: string | null
  city: string | null
  state: string | null
  pincode: string | null
  collections_name: string | null
  collections_email: string | null
  collections_mobile: string | null
  booking_activation: boolean
  hold_activation: boolean
  dom_ticketing: boolean
  intl_ticketing: boolean
  hold_auto_issue: boolean
  sbt_ticketing: boolean
  policy_controlling: boolean
  personal_bookings_allowed: boolean
  agency_fop_allowed: boolean
  corporate_fop_allowed: boolean
  traveller_fop_allowed: boolean
  discount_active: boolean
  processing_fee_active: boolean
  fop_bucket_id: string | null
  discount_bucket_id: string | null
  processing_fee_bucket_id: string | null
  air_approval_mode: string
  hotel_approval_mode: string
}

interface MandatoryEntry {
  id: string
  code: string
  description: string | null
  type: string | null
  gds_entry: string | null
  value_prefix: string | null
  is_mandatory: boolean
}

interface AdminUser { id: string; full_name: string; email: string; status: string }
interface CardRow { id: string; label: string; card_type: string | null; last4: string | null; status: string; description: string }
interface PolicyLink { policyGroupId: string; group: { id: string; name: string; bandRanks: number[] } | null }

const SIZES = ['1-50', '51-200', '201-1000', '1001+']
const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York']
const BOOKING_MODES = [
  { value: 'sbt', label: 'SBT — travellers book for themselves' },
  { value: 'cbt', label: 'CBT — counsellors book on their behalf' },
  { value: 'both', label: 'Hybrid — both' },
]
const APPROVAL_MODES = [
  { value: 'before_booking', label: 'Required before booking' },
  { value: 'not_required', label: 'Not required' },
]

const EMPTY_ENTRY = { code: '', description: '', type: '', gds_entry: '', value_prefix: '', is_mandatory: true }

export default function CorporateSettingsPage() {
  const params = useParams()
  const clientId = params.id as string

  const [client, setClient] = useState<Client | null>(null)
  const [form, setForm] = useState<Partial<Client>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [dirty, setDirty] = useState(false)

  // Lazily loaded — each needs its own request, and firing all of them on page
  // load would mean four round trips for panels most visits never open.
  const [entries, setEntries] = useState<MandatoryEntry[]>([])
  const [admins, setAdmins] = useState<AdminUser[]>([])
  const [cards, setCards] = useState<CardRow[]>([])
  const [policyLinks, setPolicyLinks] = useState<PolicyLink[]>([])
  const [approvalDefaults, setApprovalDefaults] = useState<Record<string, string | null>>({})

  const [newEntry, setNewEntry] = useState(EMPTY_ENTRY)
  const [resetNote, setResetNote] = useState('')

  function set<K extends keyof Client>(key: K, value: Client[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
    setDirty(true); setSuccess('')
  }

  const groupLookup = useLookup('/api/tmc/client-groups', form.client_group_id ?? '', {
    toOption: row => ({
      id: String(row.id),
      label: String(row.name),
      sublabel: [row.group_code, row.city].filter(Boolean).join(' · ') || undefined,
    }),
  })
  const branchLookup = useLookup('/api/tmc/branches', form.branch_id ?? '', {
    toOption: row => ({
      id: String(row.id),
      label: String(row.name),
      sublabel: row.branch_no ? `Office ${row.branch_no}` : undefined,
    }),
  })
  const fopBucketLookup = useLookup('/api/tmc/buckets', form.fop_bucket_id ?? '')
  const discountBucketLookup = useLookup('/api/tmc/buckets', form.discount_bucket_id ?? '')
  const feeBucketLookup = useLookup('/api/tmc/buckets', form.processing_fee_bucket_id ?? '')

  // Server-searched, like every other picker here. A plain fetch of
  // /api/tmc/tcs would show only the first ten counsellors — that endpoint has
  // been paged since pagination landed — so a TMC with a large desk could not
  // pick most of its own people as account manager.
  const managerLookup = useLookup('/api/tmc/tcs', form.managed_by ?? '', {
    toOption: row => ({
      id: String(row.id),
      label: String(row.full_name),
      sublabel: row.email ? String(row.email) : undefined,
    }),
  })

  useEffect(() => {
    fetch(`/api/tmc/clients/${clientId}`)
      .then(r => r.json())
      .then(clientData => {
        if (!clientData.ok) { setError(clientData.error || 'Could not load client.'); return }
        setClient(clientData.client)
        setForm(clientData.client)
      })
      .catch(() => setError('Could not load client.'))
      .finally(() => setLoading(false))
  }, [clientId])

  async function save() {
    setSaving(true); setError(''); setSuccess('')
    try {
      const res = await fetch(`/api/tmc/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Could not save changes.'); return }
      setClient(data.client)
      setForm(data.client)
      setDirty(false)
      setSuccess('Saved.')
    } finally { setSaving(false) }
  }

  // ── Lazy loaders, one per heavy section ──────────────────────────────────
  function loadPolicyAndApprovals() {
    fetch(`/api/tmc/client-policy-groups?clientId=${clientId}`).then(r => r.json())
      .then(d => { if (d.ok) setPolicyLinks(d.links) })
    fetch(`/api/tmc/approval-assignments?clientId=${clientId}`).then(r => r.json())
      .then(d => { if (d.ok) setApprovalDefaults(d.defaults ?? {}) })
  }

  function loadCards() {
    fetch(`/api/tmc/forms-of-payment?payer=corporate&ownerClientId=${clientId}`).then(r => r.json())
      .then(d => { if (d.ok) setCards(d.items ?? []) })
  }

  function loadEntries() {
    fetch(`/api/tmc/clients/${clientId}/mandatory-info`).then(r => r.json())
      .then(d => { if (d.ok) setEntries(d.entries) })
  }

  function loadAdmins() {
    fetch(`/api/tmc/clients/${clientId}/admin-access`).then(r => r.json())
      .then(d => { if (d.ok) setAdmins(d.admins) })
  }

  async function saveEntry() {
    if (!newEntry.code.trim()) return
    const d = await fetch(`/api/tmc/clients/${clientId}/mandatory-info`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newEntry),
    }).then(r => r.json())
    if (!d.ok) { setError(d.error || 'Could not save that entry.'); return }
    setNewEntry(EMPTY_ENTRY)
    loadEntries()
  }

  async function deleteEntry(entryId: string) {
    await fetch(`/api/tmc/clients/${clientId}/mandatory-info?entryId=${entryId}`, { method: 'DELETE' })
    loadEntries()
  }

  async function sendReset(admin: AdminUser) {
    if (!confirm(
      `Send a password reset to ${admin.email}?\n\nThey will get a link to choose a new password. ` +
      `You will not see it — nobody but them ever does.`
    )) return

    setResetNote('')
    const d = await fetch(`/api/tmc/clients/${clientId}/admin-access`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: admin.id }),
    }).then(r => r.json())

    if (!d.ok) { setError(d.error || 'Could not send the reset.'); return }
    setResetNote(d.message)
  }

  if (loading) return <div style={s.root}><p style={s.muted}>Loading…</p></div>
  if (!client) return <div style={s.root}><p style={s.error}>{error || 'Client not found.'}</p></div>

  // PAN is not a stored field. A GSTIN is 27 + AAAPC4988M + 1Z5, and characters
  // 3–12 ARE the PAN — so it is derived here rather than typed a second time.
  // Two hand-entered fields holding the same ten characters is a guarantee they
  // eventually disagree with nothing to say which is right.
  const gstin = readGstin(form.gst_number ?? '')

  const activeToggleCount = [
    form.booking_activation, form.hold_activation, form.dom_ticketing,
    form.intl_ticketing, form.policy_controlling,
  ].filter(v => v === false).length

  return (
    <div style={s.root}>
      <div style={s.header}>
        <Link href="/tmc/clients" style={s.backLink}>← All clients</Link>
        <h1 style={s.heading}>{client.name}</h1>
        <p style={s.sub}>
          Corporate settings — what this client can do, which masters apply to them, and who to
          contact. Registered {new Date(client.created_at).toLocaleDateString()}.
        </p>
      </div>

      {error && <div style={s.errorBanner}>{error}</div>}
      {success && <div style={s.successBanner}>{success}</div>}

      {/* ── 1. Identity ─────────────────────────────────────────────────── */}
      <SettingsSection
        title="Identity & registration"
        description="Who this client is, and the references your finance system knows them by."
        defaultOpen
      >
        <div style={s.grid}>
          <Field label="Client name">
            <input value={form.name ?? ''} onChange={e => set('name', e.target.value)} style={s.input} />
          </Field>
          <Field label="Client code" hint="Quoted on invoices. Unique across your TMC.">
            <input
              value={form.client_code ?? ''}
              onChange={e => set('client_code', e.target.value.toUpperCase())}
              placeholder="15A003" style={{ ...s.input, ...s.mono }}
            />
          </Field>
          <Field label="Client group">
            <SearchableSelect
              value={form.client_group_id ?? ''}
              onChange={id => set('client_group_id', id || null)}
              options={groupLookup.options} onSearch={groupLookup.onSearch}
              loading={groupLookup.loading} selectedLabel={groupLookup.selectedLabel}
              placeholder="Unassigned" emptyMessage="No client groups match"
              allowClear clearLabel="Unassigned"
            />
          </Field>

          <Field label="SAP customer code" hint="Recorded only — nothing here talks to SAP.">
            <input
              value={form.sap_customer_code ?? ''}
              onChange={e => set('sap_customer_code', e.target.value)}
              style={{ ...s.input, ...s.mono }}
            />
          </Field>
          <Field label="SAP group code">
            <input
              value={form.sap_group_code ?? ''}
              onChange={e => set('sap_group_code', e.target.value)}
              style={{ ...s.input, ...s.mono }}
            />
          </Field>
          <Field label="User category" hint="Who does the booking. Called booking mode elsewhere.">
            <select value={form.booking_mode ?? 'sbt'} onChange={e => set('booking_mode', e.target.value as Client['booking_mode'])} style={s.input}>
              {BOOKING_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>

          <Field label="GST number" hint="Stored uppercase. Not format-checked.">
            <input
              value={form.gst_number ?? ''}
              onChange={e => set('gst_number', e.target.value.toUpperCase())}
              style={{ ...s.input, ...s.mono }}
            />
          </Field>
          <Field label="PAN" hint="Derived from the GSTIN — characters 3 to 12. Not stored separately.">
            <input
              value={gstin.pan ?? ''}
              readOnly disabled
              placeholder={form.gst_number ? 'Not a well-formed GSTIN' : 'Enter a GST number'}
              style={{ ...s.input, ...s.mono, ...s.readOnly }}
            />
          </Field>
          <Field label="Industry">
            <input value={form.industry ?? ''} onChange={e => set('industry', e.target.value)} style={s.input} />
          </Field>

          <Field label="Size">
            <select value={form.size ?? ''} onChange={e => set('size', e.target.value || null)} style={s.input}>
              <option value="">Not recorded</option>
              {SIZES.map(v => <option key={v} value={v}>{v} employees</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={form.status ?? 'active'} onChange={e => set('status', e.target.value)} style={s.input}>
              <option value="active">Active</option>
              <option value="inactive">Inactive — no new bookings</option>
            </select>
          </Field>
          <Field label="Timezone">
            <select value={form.timezone ?? 'Asia/Kolkata'} onChange={e => set('timezone', e.target.value)} style={s.input}>
              {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </Field>
        </div>
      </SettingsSection>

      {/* ── 2. Address ──────────────────────────────────────────────────── */}
      <SettingsSection
        title="Address"
        description="Where this client is registered. Your own registered address — the one you raise invoices from — lives on branches instead."
      >
        <div style={s.grid}>
          <Field label="Address line 1" span={2}>
            <input value={form.address_1 ?? ''} onChange={e => set('address_1', e.target.value)} style={s.input} />
          </Field>
          <Field label="Address line 2">
            <input value={form.address_2 ?? ''} onChange={e => set('address_2', e.target.value)} style={s.input} />
          </Field>
          <Field label="Country">
            <CountryDropdown value={form.country ?? ''} onChange={v => set('country', v)} />
          </Field>
          <Field label="State">
            <StateDropdown value={form.state ?? ''} onChange={v => set('state', v)} />
          </Field>
          <Field label="City">
            <CityDropdown value={form.city ?? ''} onChange={v => set('city', v)} state={form.state ?? undefined} />
          </Field>
          <Field label="Pincode">
            <input value={form.pincode ?? ''} onChange={e => set('pincode', e.target.value)} style={s.input} />
          </Field>
        </div>

        {client.registered_address && (
          <p style={s.legacyNote}>
            <strong>Previously recorded as one line:</strong> {client.registered_address}
            <br />
            Kept as-is rather than split automatically — nobody can tell where that string&rsquo;s
            commas were meant to go. Copy what you need into the fields above.
          </p>
        )}
      </SettingsSection>

      {/* ── 3. Servicing & contacts ─────────────────────────────────────── */}
      <SettingsSection
        title="Servicing & contacts"
        description="Which of your offices looks after them, who owns the relationship, and who to chase for payment."
      >
        <div style={s.grid}>
          <Field label="Branch / sales office" hint="Drives which branch-scoped payment method applies.">
            <SearchableSelect
              value={form.branch_id ?? ''}
              onChange={id => set('branch_id', id || null)}
              options={branchLookup.options} onSearch={branchLookup.onSearch}
              loading={branchLookup.loading} selectedLabel={branchLookup.selectedLabel}
              placeholder="No branch" emptyMessage="No branches match"
              allowClear clearLabel="No branch"
            />
          </Field>
          <Field label="Account manager (KAM)">
            <SearchableSelect
              value={form.managed_by ?? ''}
              onChange={id => set('managed_by', id || null)}
              options={managerLookup.options} onSearch={managerLookup.onSearch}
              loading={managerLookup.loading} selectedLabel={managerLookup.selectedLabel}
              placeholder="Unassigned" emptyMessage="No staff match"
              allowClear clearLabel="Unassigned"
            />
          </Field>
          <Field label="Email">
            <input type="email" value={form.email ?? ''} onChange={e => set('email', e.target.value)} style={s.input} />
          </Field>

          <Field label="Mobile">
            <input value={form.primary_contact_phone ?? ''} onChange={e => set('primary_contact_phone', e.target.value)} style={s.input} />
          </Field>
          <Field label="Phone" span={2}>
            <input value={form.phone ?? ''} onChange={e => set('phone', e.target.value)} style={s.input} />
          </Field>

          <Field label="Collections contact">
            <input value={form.collections_name ?? ''} onChange={e => set('collections_name', e.target.value)} style={s.input} />
          </Field>
          <Field label="Collections email">
            <input type="email" value={form.collections_email ?? ''} onChange={e => set('collections_email', e.target.value)} style={s.input} />
          </Field>
          <Field label="Collections mobile">
            <input value={form.collections_mobile ?? ''} onChange={e => set('collections_mobile', e.target.value)} style={s.input} />
          </Field>
        </div>
      </SettingsSection>

      {/* ── 4. Booking controls ─────────────────────────────────────────── */}
      <SettingsSection
        title="Booking controls"
        description="What this client's people can actually do. Each switch says what it stops."
        badge={activeToggleCount > 0
          ? <span style={s.warnBadge}>{activeToggleCount} switched off</span>
          : undefined}
      >
        <div style={s.toggles}>
          <Toggle
            label="Booking activation" checked={form.booking_activation !== false}
            onChange={v => set('booking_activation', v)}
            effect="Off: no new bookings can be confirmed at all."
          />
          <Toggle
            label="Hold activation" checked={form.hold_activation !== false}
            onChange={v => set('hold_activation', v)}
            effect="Off: a PNR cannot be held unticketed. Holding is what booking-without-ticketing means here."
          />
          <Toggle
            label="Domestic ticketing" checked={form.dom_ticketing !== false}
            onChange={v => set('dom_ticketing', v)}
            effect="Off: domestic bookings can be held but not ticketed."
          />
          <Toggle
            label="International ticketing" checked={form.intl_ticketing !== false}
            onChange={v => set('intl_ticketing', v)}
            effect="Off: international bookings can be held but not ticketed."
          />
          <Toggle
            label="Policy controlling" checked={form.policy_controlling !== false}
            onChange={v => set('policy_controlling', v)}
            effect="Off: bookings are recorded as unchecked rather than compliant — not the same as green."
          />
          <Toggle
            label="Personal bookings" checked={form.personal_bookings_allowed === true}
            onChange={v => set('personal_bookings_allowed', v)}
            effect="On: travellers may book personal trips as well as business. Which bands may is still a policy rule."
          />
          <Toggle
            label="Hold auto-issue" checked={form.hold_auto_issue === true}
            onChange={v => set('hold_auto_issue', v)}
            effect="Would ticket a held booking automatically. No auto-issue path exists yet."
            reserved
          />
          <Toggle
            label="SBT ticketing" checked={form.sbt_ticketing !== false}
            onChange={v => set('sbt_ticketing', v)}
            effect="Would decide whether self-booking travellers may ticket. The rule has not been settled."
            reserved
          />
        </div>
      </SettingsSection>

      {/* ── 5. Financial ────────────────────────────────────────────────── */}
      <SettingsSection
        title="Financial"
        description="Whose money pays, and which curated sets this client belongs to. Groups are buckets — the same ones deal codes and forms of payment already use."
      >
        <p style={s.subLabel}>Payer types allowed</p>
        <div style={s.toggles}>
          <Toggle
            label="Agency" checked={form.agency_fop_allowed !== false}
            onChange={v => set('agency_fop_allowed', v)}
            effect="Your own card or BSP settlement. Off: agency methods stop applying to this client."
          />
          <Toggle
            label="Corporate" checked={form.corporate_fop_allowed !== false}
            onChange={v => set('corporate_fop_allowed', v)}
            effect="The client's own lodged card."
          />
          <Toggle
            label="Traveller" checked={form.traveller_fop_allowed !== false}
            onChange={v => set('traveller_fop_allowed', v)}
            effect="The traveller pays and reclaims."
          />
        </div>

        <div style={{ ...s.grid, marginTop: 16 }}>
          <Field label="Form of payment bucket">
            <SearchableSelect
              value={form.fop_bucket_id ?? ''}
              onChange={id => set('fop_bucket_id', id || null)}
              options={fopBucketLookup.options} onSearch={fopBucketLookup.onSearch}
              loading={fopBucketLookup.loading} selectedLabel={fopBucketLookup.selectedLabel}
              placeholder="None" emptyMessage="No buckets match"
              allowClear clearLabel="None"
            />
          </Field>
          <Field label="Discount bucket">
            <SearchableSelect
              value={form.discount_bucket_id ?? ''}
              onChange={id => set('discount_bucket_id', id || null)}
              options={discountBucketLookup.options} onSearch={discountBucketLookup.onSearch}
              loading={discountBucketLookup.loading} selectedLabel={discountBucketLookup.selectedLabel}
              placeholder="None" emptyMessage="No buckets match"
              allowClear clearLabel="None"
            />
          </Field>
          <Field label="Processing fee bucket">
            <SearchableSelect
              value={form.processing_fee_bucket_id ?? ''}
              onChange={id => set('processing_fee_bucket_id', id || null)}
              options={feeBucketLookup.options} onSearch={feeBucketLookup.onSearch}
              loading={feeBucketLookup.loading} selectedLabel={feeBucketLookup.selectedLabel}
              placeholder="None" emptyMessage="No buckets match"
              allowClear clearLabel="None"
            />
          </Field>
        </div>

        <div style={{ ...s.toggles, marginTop: 12 }}>
          <Toggle
            label="Discount" checked={form.discount_active === true}
            onChange={v => set('discount_active', v)}
            effect="Recorded only — no discount is calculated yet. The Discounts master is still to come."
            reserved
          />
          <Toggle
            label="Processing fee" checked={form.processing_fee_active === true}
            onChange={v => set('processing_fee_active', v)}
            effect="Recorded only — no fee is calculated yet."
            reserved
          />
        </div>
      </SettingsSection>

      {/* ── 6. Policy & approvals ───────────────────────────────────────── */}
      <SettingsSection
        title="Policy & approvals"
        description="Which policy governs this client, and whether flights and hotels need approval. The chains themselves are built on the Approvals screen."
        onFirstOpen={loadPolicyAndApprovals}
      >
        <div style={s.grid}>
          <Field label="Air approval">
            <select
              value={form.air_approval_mode ?? 'before_booking'}
              onChange={e => set('air_approval_mode', e.target.value)}
              style={s.input}
            >
              {APPROVAL_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Hotel approval">
            <select
              value={form.hotel_approval_mode ?? 'before_booking'}
              onChange={e => set('hotel_approval_mode', e.target.value)}
              style={s.input}
            >
              {APPROVAL_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Policy control" hint="Switching this off is on the Booking controls panel.">
            <input
              readOnly disabled
              value={form.policy_controlling !== false ? 'Enforced' : 'Not enforced'}
              style={{ ...s.input, ...s.readOnly }}
            />
          </Field>
        </div>

        <p style={s.subLabel}>Policy groups covering this client</p>
        {policyLinks.length === 0 ? (
          <p style={s.hint}>
            None linked. Bookings will resolve to no policy and be reported as unevaluated.{' '}
            <Link href="/tmc/configurations/policy" style={s.inlineLink}>Link one →</Link>
          </p>
        ) : (
          <ul style={s.linkList}>
            {policyLinks.map(l => (
              <li key={l.policyGroupId} style={s.linkItem}>
                <span style={s.linkName}>{l.group?.name ?? 'Unknown group'}</span>
                {l.group?.bandRanks?.length ? (
                  <span style={s.muted}>ranks {l.group.bandRanks.join(', ')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <p style={s.subLabel}>Default approval chain</p>
        <ul style={s.linkList}>
          {(['air', 'hotel', 'misc'] as const).map(cat => (
            <li key={cat} style={s.linkItem}>
              <span style={s.linkName}>
                {cat === 'air' ? 'Flights' : cat === 'hotel' ? 'Hotels' : 'Everything else'}
              </span>
              <span style={s.muted}>
                {approvalDefaults[cat] ? 'Chain assigned' : 'No chain — bookings go through unapproved'}
              </span>
            </li>
          ))}
        </ul>
        <p style={s.hint}>
          <Link href="/tmc/configurations/approvals" style={s.inlineLink}>Assign chains →</Link>
        </p>
      </SettingsSection>

      {/* ── 7. Corporate cards ──────────────────────────────────────────── */}
      <SettingsSection
        title="Corporate cards"
        description="Payment methods this client owns. Added and edited on the Forms of payment master — shown here so you can see what they have without going to look."
        onFirstOpen={loadCards}
      >
        {cards.length === 0 ? (
          <p style={s.hint}>
            None recorded.{' '}
            <Link href="/tmc/configurations/forms-of-payment" style={s.inlineLink}>Add one →</Link>
          </p>
        ) : (
          <ul style={s.linkList}>
            {cards.map(c => (
              <li key={c.id} style={s.linkItem}>
                <span style={s.linkName}>{c.label}</span>
                <span style={s.muted}>{c.description}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      {/* ── 8. Mandatory information ────────────────────────────────────── */}
      <SettingsSection
        title="Mandatory information"
        description="Entries a booking for this client must carry, and the GDS command each goes into. Recorded for manual entry and reconciliation — nothing here is sent to the aggregator."
        onFirstOpen={loadEntries}
        badge={entries.length > 0 ? <span style={s.countBadge}>{entries.length}</span> : undefined}
      >
        {entries.length > 0 && (
          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>{['Code', 'Description', 'Type', 'GDS entry', 'Prefix', 'Required', ''].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.id}>
                    <td style={{ ...s.td, ...s.mono }}>{e.code}</td>
                    <td style={s.td}>{e.description ?? '—'}</td>
                    <td style={s.td}>{e.type ?? '—'}</td>
                    <td style={{ ...s.td, ...s.mono }}>{e.gds_entry ?? '—'}</td>
                    <td style={{ ...s.td, ...s.mono }}>{e.value_prefix ?? '—'}</td>
                    <td style={s.td}>{e.is_mandatory ? 'Yes' : 'Optional'}</td>
                    <td style={{ ...s.td, textAlign: 'right' }}>
                      <button onClick={() => deleteEntry(e.id)} style={s.dangerBtn}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ ...s.grid, marginTop: entries.length > 0 ? 14 : 0 }}>
          <Field label="Code">
            <input
              value={newEntry.code}
              onChange={e => setNewEntry(p => ({ ...p, code: e.target.value.toUpperCase() }))}
              style={{ ...s.input, ...s.mono }}
            />
          </Field>
          <Field label="Description" span={2}>
            <input value={newEntry.description} onChange={e => setNewEntry(p => ({ ...p, description: e.target.value }))} style={s.input} />
          </Field>
          <Field label="Type">
            <input value={newEntry.type} onChange={e => setNewEntry(p => ({ ...p, type: e.target.value }))} style={s.input} />
          </Field>
          <Field label="GDS entry">
            <input
              value={newEntry.gds_entry}
              onChange={e => setNewEntry(p => ({ ...p, gds_entry: e.target.value.toUpperCase() }))}
              style={{ ...s.input, ...s.mono }}
            />
          </Field>
          <Field label="Value prefix">
            <input value={newEntry.value_prefix} onChange={e => setNewEntry(p => ({ ...p, value_prefix: e.target.value }))} style={s.input} />
          </Field>
        </div>
        <div style={s.actions}>
          <label style={s.checkRow}>
            <input
              type="checkbox" checked={newEntry.is_mandatory}
              onChange={e => setNewEntry(p => ({ ...p, is_mandatory: e.target.checked }))}
            />
            Required
          </label>
          <button onClick={saveEntry} disabled={!newEntry.code.trim()} style={{ ...s.primaryBtn, opacity: newEntry.code.trim() ? 1 : 0.5 }}>
            Add entry
          </button>
        </div>
      </SettingsSection>

      {/* ── 9. Admin access ─────────────────────────────────────────────── */}
      <SettingsSection
        title="Admin access"
        description="The client's own administrators. You can send them a reset link — you cannot see or set a password, and neither can anyone else here."
        onFirstOpen={loadAdmins}
      >
        {admins.length === 0 ? (
          <p style={s.hint}>No corporate admins on this client yet.</p>
        ) : (
          <ul style={s.linkList}>
            {admins.map(a => (
              <li key={a.id} style={s.linkItem}>
                <span style={s.linkName}>{a.full_name}</span>
                <span style={s.muted}>{a.email} · {a.status}</span>
                <button onClick={() => sendReset(a)} style={s.ghostBtn}>Send reset</button>
              </li>
            ))}
          </ul>
        )}
        {resetNote && <p style={s.successNote}>{resetNote}</p>}
      </SettingsSection>

      {dirty && (
        <div style={s.stickyBar}>
          <span style={s.stickyText}>You have unsaved changes.</span>
          <button onClick={save} disabled={saving} style={s.stickyBtn}>
            {saving ? 'Saving…' : 'Save changes →'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Field ────────────────────────────────────────────────────────────────────
// A labelled cell in the section grid. `span` widens one across the three-column
// layout for the fields that genuinely need the room, like an address line.
function Field({ label, hint, span = 1, children }: {
  label: string
  hint?: string
  span?: number
  children: React.ReactNode
}) {
  return (
    <div style={{ ...s.field, gridColumn: `span ${span}` }}>
      <label style={s.label}>{label}</label>
      {children}
      {hint && <span style={s.fieldHint}>{hint}</span>}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: 980, margin: '0 auto', padding: '32px 40px 96px' },
  header: { marginBottom: 18 },
  backLink: { fontSize: 12, color: '#6B7280', textDecoration: 'none' },
  heading: { fontSize: 21, fontWeight: 600, color: '#0A0A14', margin: '8px 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0, lineHeight: 1.6, maxWidth: 640 },

  grid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 11, fontWeight: 600, color: '#374151' },
  fieldHint: { fontSize: 10.5, color: '#9CA3AF', lineHeight: 1.5 },
  input: {
    height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff',
    border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none', boxSizing: 'border-box',
  },
  readOnly: { background: '#F3F4F6', color: '#6B7280', cursor: 'not-allowed' },
  mono: { fontFamily: 'var(--font-mono)' },

  toggles: { display: 'flex', flexDirection: 'column' },
  subLabel: { fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '16px 0 6px' },
  hint: { fontSize: 12, color: '#6B7280', lineHeight: 1.6, margin: '6px 0 0' },
  inlineLink: { color: '#3730A3', textDecoration: 'underline', textUnderlineOffset: 2 },
  muted: { color: '#9CA3AF', fontSize: 11.5 },

  linkList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  linkItem: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 10px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 7 },
  linkName: { fontSize: 12.5, fontWeight: 600, color: '#111827' },

  legacyNote: { fontSize: 11.5, color: '#92400E', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 7, padding: '10px 12px', margin: '14px 0 0', lineHeight: 1.6 },
  successNote: { fontSize: 12, color: '#065F46', background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 7, padding: '9px 12px', margin: '12px 0 0' },

  tableWrap: { border: '1px solid #E5E7EB', borderRadius: 8, overflowX: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%', minWidth: 620 },
  th: { padding: '8px 10px', textAlign: 'left', background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', fontSize: 10.5, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' },
  td: { padding: '8px 10px', fontSize: 12, color: '#374151', borderBottom: '1px solid #F3F4F6' },

  actions: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' },
  checkRow: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: '#374151' },
  primaryBtn: { height: 34, padding: '0 14px', background: '#000835', color: '#fff', fontSize: 12.5, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer' },
  ghostBtn: { height: 28, padding: '0 11px', background: '#fff', color: '#374151', fontSize: 11.5, border: '1px solid #D1D5DB', borderRadius: 6, cursor: 'pointer', marginLeft: 'auto' },
  dangerBtn: { fontSize: 11, color: '#DC2626', background: 'transparent', border: '1px solid #FECACA', borderRadius: 5, padding: '3px 8px', cursor: 'pointer' },

  warnBadge: { fontSize: 10, fontWeight: 600, color: '#92400E', background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 4, padding: '1px 6px' },
  countBadge: { fontSize: 10, fontWeight: 600, color: '#3730A3', background: '#EEF2FF', borderRadius: 10, padding: '1px 7px' },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#DC2626', marginBottom: 14 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#065F46', marginBottom: 14 },
  error: { fontSize: 13, color: '#DC2626' },

  stickyBar: {
    position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30,
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14,
    padding: '12px 40px', background: '#fff', borderTop: '1px solid #E5E7EB',
    boxShadow: '0 -4px 16px rgba(0,0,0,0.06)',
  },
  stickyText: { fontSize: 12, color: '#92400E' },
  stickyBtn: { height: 36, padding: '0 18px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer' },
}
