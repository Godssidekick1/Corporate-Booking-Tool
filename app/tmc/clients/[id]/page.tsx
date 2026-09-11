'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import CountryDropdown from '@/app/components/CountryDropdown'
import StateDropdown from '@/app/components/StateDropdown'
import CityDropdown from '@/app/components/CityDropdown'
import SearchableSelect from '@/app/components/SearchableSelect'
import Tabs, { useUrlTab } from '@/app/components/Tabs'
import { useLookup } from '@/app/hooks/useLookup'
import Toggle from './Toggle'
import GstTab from './GstTab'
import AllocationsTab from './AllocationsTab'
import { Field, s, type Client } from './shared'

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
//
// TABS, NOT AN ACCORDION. Nine collapsed panels meant the shape of the screen
// depended on what you had opened, and no two people saw the same page. Six tabs
// with the policy row's styling means one place is open at a time and the URL
// says which.
// ─────────────────────────────────────────────────────────────────────────────

interface AdminUser { id: string; full_name: string; email: string; status: string }
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

const TAB_IDS = ['identity', 'gst', 'contacts', 'controls', 'allocations', 'policy'] as const
type TabId = typeof TAB_IDS[number]

export default function CorporateSettingsPage() {
  const params = useParams()
  const clientId = params.id as string

  // Deep-linkable: "take me to this client's policy" is one href from anywhere.
  const [tab, setTab] = useUrlTab<TabId>('tab', 'identity', TAB_IDS)

  const [client, setClient] = useState<Client | null>(null)
  const [form, setForm] = useState<Partial<Client>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [dirty, setDirty] = useState(false)

  const [admins, setAdmins] = useState<AdminUser[]>([])
  const [policyLinks, setPolicyLinks] = useState<PolicyLink[]>([])
  const [approvalDefaults, setApprovalDefaults] = useState<Record<string, string | null>>({})
  const [gstCount, setGstCount] = useState<number | undefined>(undefined)
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

  // Loaded when their tab is first opened rather than on page load — four round
  // trips for panels most visits never reach is three too many. The accordion
  // did this through onFirstOpen; with tabs it is keyed on which tab has been
  // seen, which is the same idea with a simpler trigger.
  //
  // A ref, not state: "which tabs have been visited" is bookkeeping that nothing
  // renders, so putting it in state would cause a second render on every first
  // visit for no visible change.
  const seen = useRef<Set<TabId>>(new Set(['identity']))

  useEffect(() => {
    if (seen.current.has(tab)) return
    seen.current.add(tab)

    if (tab === 'policy') {
      fetch(`/api/tmc/client-policy-groups?clientId=${clientId}`).then(r => r.json())
        .then(d => { if (d.ok) setPolicyLinks(d.links) })
      fetch(`/api/tmc/approval-assignments?clientId=${clientId}`).then(r => r.json())
        .then(d => { if (d.ok) setApprovalDefaults(d.defaults ?? {}) })
    }
    if (tab === 'contacts') {
      fetch(`/api/tmc/clients/${clientId}/admin-access`).then(r => r.json())
        .then(d => { if (d.ok) setAdmins(d.admins) })
    }
  }, [tab, clientId])

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

  const offCount = [
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
          contact.
        </p>
      </div>

      {/* Whose settings these are, kept on screen across every tab. */}
      <div style={s.idStrip}>
        {client.client_code && <span style={{ ...s.idChipStrong, ...s.mono }}>{client.client_code}</span>}
        <span style={s.idChip}>{groupLookup.selectedLabel || 'No client group'}</span>
        <span style={s.idChip}>{client.status === 'active' ? 'Active' : 'Inactive'}</span>
        <span style={s.idChip}>Registered {new Date(client.created_at).toLocaleDateString()}</span>
      </div>

      {error && <div style={s.errorBanner}>{error}</div>}
      {success && <div style={s.successBanner}>{success}</div>}

      <Tabs<TabId>
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'identity', label: 'Identity', hint: 'Who this client is, the references your finance system knows them by, and where they are registered.' },
          { id: 'gst', label: 'GST', count: gstCount, hint: 'Every registration this client bills under.' },
          { id: 'contacts', label: 'Contacts & access', hint: 'Which office looks after them, who owns the relationship, and their own administrators.' },
          { id: 'controls', label: 'Controls', count: offCount || undefined, hint: 'What this client’s people can actually do. Each switch says what it stops.' },
          { id: 'allocations', label: 'Allocations', hint: 'Buckets, deal codes, payment methods and who pays — everything handed to this client.' },
          { id: 'policy', label: 'Policy & approvals', hint: 'Which policy governs them and whether bookings need approval. Edited on the masters.' },
        ]}
      />

      {/* ── Identity ─────────────────────────────────────────────────────── */}
      {tab === 'identity' && (
        <>
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

          <p style={s.subLabel}>Address</p>
          <p style={s.blockDesc}>
            Where this client is registered. Your own registered address — the one you raise
            invoices from — lives on branches instead. A GST registration can carry its own
            address, on the GST tab.
          </p>
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
        </>
      )}

      {/* ── GST ──────────────────────────────────────────────────────────── */}
      {tab === 'gst' && <GstTab clientId={clientId} onCount={setGstCount} />}

      {/* ── Contacts & access ────────────────────────────────────────────── */}
      {tab === 'contacts' && (
        <>
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

          <p style={s.subLabel}>Admin access</p>
          <p style={s.blockDesc}>
            The client&rsquo;s own administrators. You can send them a reset link — you cannot see
            or set a password, and neither can anyone else here.
          </p>
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
        </>
      )}

      {/* ── Controls ─────────────────────────────────────────────────────── */}
      {tab === 'controls' && (
        <>
          {offCount > 0 && (
            <p style={s.hint}>
              <span style={s.warnBadge}>{offCount} switched off</span>
            </p>
          )}
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

          <p style={s.subLabel}>Commercial flags</p>
          <div style={s.toggles}>
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
        </>
      )}

      {/* ── Allocations ──────────────────────────────────────────────────── */}
      {tab === 'allocations' && <AllocationsTab clientId={clientId} form={form} set={set} />}

      {/* ── Policy & approvals ───────────────────────────────────────────── */}
      {tab === 'policy' && (
        <>
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
            <Field label="Policy control" hint="Switching this off is on the Controls tab.">
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
              <Link href={`/tmc/configurations/policy?tab=clients&clientId=${clientId}`} style={s.inlineLink}>
                Link one →
              </Link>
            </p>
          ) : (
            <ul style={s.linkList}>
              {policyLinks.map(l => (
                <li key={l.policyGroupId} style={s.linkItem}>
                  {/* Straight to that group's rules, the way a chain name goes
                      to its template. Reading "ranks 1, 4, 9" and having to go
                      find the group yourself is a page switch for nothing. */}
                  <Link
                    href={`/tmc/configurations/policy?tab=groups&groupId=${l.policyGroupId}`}
                    style={{ ...s.linkName, ...s.inlineLink }}
                  >
                    {l.group?.name ?? 'Unknown group'}
                  </Link>
                  {l.group?.bandRanks?.length ? (
                    <span style={s.muted}>ranks {l.group.bandRanks.join(', ')}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p style={s.hint}>
            <Link href={`/tmc/configurations/policy?tab=clients&clientId=${clientId}`} style={s.inlineLink}>
              Edit policies →
            </Link>
          </p>

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
            <Link href={`/tmc/configurations/approvals?clientId=${clientId}`} style={s.inlineLink}>
              Assign chains →
            </Link>
          </p>
        </>
      )}

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
