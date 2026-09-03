'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import CountryDropdown from '@/app/components/CountryDropdown'
import SearchableSelect from '@/app/components/SearchableSelect'

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
}

interface TmcStaff {
  id: string
  full_name: string
  email: string
  role: string
}

const SIZES = ['1-50', '51-200', '201-1000', '1001+']
const STATUSES: { value: string; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive — no new bookings' },
]

interface client_group {
  id: string
  name: string
  city: string | null
}

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York']
const CURRENCIES = ['INR']
const BOOKING_MODES: { value: Client['booking_mode']; label: string }[] = [
  { value: 'sbt', label: 'SBT — Self-Booking Tool' },
  { value: 'cbt', label: 'CBT — Consultant-Booking Tool' },
  { value: 'both', label: 'Hybrid — Both SBT and CBT' },
]

export default function TmcClientDetailPage() {
  const params = useParams()
  const clientId = params.id as string

  const [client, setClient] = useState<Client | null>(null)
  const [client_groups, setclient_groups] = useState<client_group[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [form, setForm] = useState({
    name: '', timezone: '', currency: '', country: '', booking_mode: 'sbt' as Client['booking_mode'], client_group_id: '',
    registered_address: '', gst_number: '', industry: '', primary_contact_phone: '',
    size: '', status: 'active', managed_by: '',
  })

  // TMC-side staff only — managed_by is a plain FK to employees, so a corporate
  // employee would be a valid row and a nonsense account manager. The server
  // enforces the same restriction; this keeps it out of the picker.
  const [tmcStaff, setTmcStaff] = useState<TmcStaff[]>([])

  useEffect(() => {
    Promise.all([
      fetch(`/api/tmc/clients/${clientId}`).then(r => r.json()),
      fetch('/api/tmc/client-groups').then(r => r.json()),
      fetch('/api/tmc/tcs').then(r => r.json()),
    ]).then(([clientData, client_groupsData, tcsData]) => {
        if (tcsData?.ok) setTmcStaff(tcsData.items ?? [])
        if (!clientData.ok) {
          setError(clientData.error || 'Could not load client.')
          return
        }
        const c: Client = clientData.client
        setClient(c)
        setForm({
          name: c.name ?? '',
          timezone: c.timezone ?? 'Asia/Kolkata',
          currency: c.currency ?? 'INR',
          country: c.country ?? '',
          booking_mode: c.booking_mode ?? 'sbt',
          client_group_id: c.client_group_id ?? '',
          registered_address: c.registered_address ?? '',
          gst_number: c.gst_number ?? '',
          industry: c.industry ?? '',
          primary_contact_phone: c.primary_contact_phone ?? '',
          size: c.size ?? '',
          status: c.status ?? 'active',
          managed_by: c.managed_by ?? '',
        })
        if (client_groupsData.ok) setclient_groups(client_groupsData.items ?? [])
      })
      .catch(() => setError('Could not load client.'))
      .finally(() => setLoading(false))
  }, [clientId])

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setSaving(true)
    try {
      const res = await fetch(`/api/tmc/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not save changes.')
        return
      }
      setClient(prev => prev ? { ...prev, ...data.client } : data.client)
      setSuccess('Client updated.')
    } catch {
      setError('Could not save changes. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <><div style={s.root}><p style={s.loadingText}>Loading…</p></div></>
  }

  if (!client) {
    return <><div style={s.root}><p style={s.error}>{error || 'Client not found.'}</p></div></>
  }

  return (
    <>
    <div style={s.root}>
      <div style={s.header}>
        {/* Link, not <a>: a plain anchor triggers a full document load, which
            throws away the shell and re-fetches everything it holds. */}
        <Link href="/tmc/clients" style={s.backLink}>← All clients</Link>
        <h1 style={s.heading}>{client.name}</h1>
        <p style={s.sub}>
          Everything recorded about this client — identity, registration, booking arrangement and
          ownership.
        </p>
      </div>

      <form onSubmit={handleSubmit} style={s.card}>
        <div style={s.field}>
          <label style={s.label} htmlFor="name">Client name</label>
          <input
            id="name" name="name" type="text" required
            value={form.name} onChange={handleChange}
            style={s.input}
          />
        </div>

        <div style={s.row}>
          <div style={s.field}>
            <label style={s.label} htmlFor="timezone">Timezone</label>
            <select id="timezone" name="timezone" value={form.timezone} onChange={handleChange} style={s.input}>
              {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>

          <div style={s.field}>
            <label style={s.label} htmlFor="currency">Currency</label>
            <select
              id="currency" name="currency" value={form.currency} onChange={handleChange}
              disabled={CURRENCIES.length === 1}
              style={{ ...s.input, opacity: CURRENCIES.length === 1 ? 0.6 : 1 }}
            >
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div style={s.field}>
          <label style={s.label} htmlFor="country">Country</label>
          <CountryDropdown
            id="country" name="country"
            value={form.country} onChange={(country) => setForm(prev => ({ ...prev, country }))}
          />
        </div>

        <div style={s.field}>
          <label style={s.label} htmlFor="client_group_id">Client group</label>
          {client_groups.length === 0 ? (
            <p style={s.hint}>
              No client groups yet — <a href="/tmc/configurations/client-groups" style={s.inlineLink}>create one</a> to assign this client.
            </p>
          ) : (
            <select id="client_group_id" name="client_group_id" value={form.client_group_id} onChange={handleChange} style={s.input}>
              <option value="">Unassigned</option>
              {client_groups.map(b => (
                <option key={b.id} value={b.id}>{b.name}{b.city ? ` — ${b.city}` : ''}</option>
              ))}
            </select>
          )}
        </div>

        <div style={s.divider} />

        <div style={s.field}>
          <label style={s.label} htmlFor="booking_mode">Booking mode</label>
          <select id="booking_mode" name="booking_mode" value={form.booking_mode} onChange={handleChange} style={s.input}>
            {BOOKING_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <p style={s.hint}>
            This determines whether the client&apos;s employees book for themselves (SBT),
            travel counsellors book on their behalf (CBT), or both. Only you can change this.
          </p>
        </div>

        <div style={s.divider} />

        {/* These four columns already existed on `clients` — onboardClient
            writes them at creation — but nothing could edit them afterwards, so
            a wrong GST number entered at onboarding was permanent. */}
        <div style={s.field}>
          <label style={s.label} htmlFor="registered_address">Registered address</label>
          <input
            id="registered_address" name="registered_address" type="text"
            value={form.registered_address} onChange={handleChange}
            placeholder="Street, city, state" style={s.input}
          />
        </div>

        <div style={s.field}>
          <label style={s.label} htmlFor="gst_number">GST / Tax ID</label>
          <input
            id="gst_number" name="gst_number" type="text"
            value={form.gst_number} onChange={handleChange}
            placeholder="22AAAAA0000A1Z5" style={s.input}
          />
          <p style={s.hint}>Stored uppercase. Not format-checked — record what the client provided.</p>
        </div>

        <div style={s.field}>
          <label style={s.label} htmlFor="industry">Industry</label>
          <input
            id="industry" name="industry" type="text"
            value={form.industry} onChange={handleChange}
            placeholder="Manufacturing" style={s.input}
          />
        </div>

        <div style={s.field}>
          <label style={s.label} htmlFor="primary_contact_phone">Primary contact phone</label>
          <input
            id="primary_contact_phone" name="primary_contact_phone" type="tel"
            value={form.primary_contact_phone} onChange={handleChange}
            placeholder="+91 98765 43210" style={s.input}
          />
        </div>

        <div style={s.field}>
          <label style={s.label} htmlFor="size">Client size</label>
          <select id="size" name="size" value={form.size} onChange={handleChange} style={s.input}>
            <option value="">Not recorded</option>
            {SIZES.map(sz => <option key={sz} value={sz}>{sz} employees</option>)}
          </select>
        </div>

        <div style={s.divider} />

        {/* Ownership and lifecycle — who runs this client, and whether it is
            still trading. */}
        <div style={s.field}>
          <label style={s.label}>Account manager</label>
          <SearchableSelect
            value={form.managed_by}
            onChange={id => setForm(prev => ({ ...prev, managed_by: id }))}
            options={[
              { id: '', label: 'Unassigned' },
              ...tmcStaff.map(t => ({
                id: t.id,
                label: t.full_name,
                sublabel: `${t.email} · ${t.role === 'tmc_admin' ? 'TMC Admin' : 'Travel Counsellor'}`,
              })),
            ]}
            placeholder="Unassigned"
            emptyMessage="No TMC staff match"
          />
          <p style={s.hint}>Only your own TMC staff can be assigned — not the client&apos;s employees.</p>
        </div>

        <div style={s.field}>
          <label style={s.label} htmlFor="status">Status</label>
          <select id="status" name="status" value={form.status} onChange={handleChange} style={s.input}>
            {STATUSES.map(st => <option key={st.value} value={st.value}>{st.label}</option>)}
          </select>
          <p style={s.hint}>
            Marking a client inactive keeps their booking history intact. Onboarding progress is
            tracked separately and is not editable here.
          </p>
        </div>

        {error && <p style={s.errorMsg}>{error}</p>}
        {success && <p style={s.success}>{success}</p>}

        <button type="submit" disabled={saving} style={{ ...s.button, opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </div>
    </>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { maxWidth: '600px', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", padding: '32px 40px' },
  loadingText: { fontSize: '13px', color: '#9CA3AF' },
  header: { marginBottom: '20px' },
  backLink: { fontSize: '12px', color: '#9CA3AF', textDecoration: 'none', display: 'block', marginBottom: '10px' },
  heading: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0 },
  card: {
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px',
    padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px',
  },
  row: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: '12px', fontWeight: 500, color: '#374151' },
  input: {
    height: '38px', padding: '0 10px', fontSize: '13px', color: '#111827',
    background: '#fff', border: '1px solid #D1D5DB', borderRadius: '7px', outline: 'none',
  },
  divider: { height: '1px', background: '#F3F4F6', margin: '2px 0' },
  hint: { fontSize: '11px', color: '#9CA3AF', margin: '4px 0 0', lineHeight: '1.5' },
  inlineLink: { color: '#000835', fontWeight: 600, textDecoration: 'underline' },
  errorMsg: {
    fontSize: '13px', color: '#DC2626', background: '#FEF2F2',
    border: '1px solid #FECACA', borderRadius: '6px', padding: '10px 12px', margin: 0,
  },
  error: { fontSize: '13px', color: '#DC2626' },
  success: {
    fontSize: '13px', color: '#065F46', background: '#ECFDF5',
    border: '1px solid #A7F3D0', borderRadius: '6px', padding: '10px 12px', margin: 0,
  },
  button: {
    height: '38px', background: '#000835', color: '#fff', fontSize: '13px', fontWeight: 600,
    border: 'none', borderRadius: '8px', cursor: 'pointer', alignSelf: 'flex-start', padding: '0 18px',
  },
}