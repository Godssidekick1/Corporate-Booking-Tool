'use client'

import { useCallback, useEffect, useState } from 'react'
import CountryDropdown from '@/app/components/CountryDropdown'
import StateDropdown from '@/app/components/StateDropdown'
import CityDropdown from '@/app/components/CityDropdown'
import SearchableSelect from '@/app/components/SearchableSelect'
import { useLookup } from '@/app/hooks/useLookup'
import { readGstin, gstinFinding } from '@/app/lib/data/gstin'
import { Field, s } from './shared'

// ── GST registrations ────────────────────────────────────────────────────────
// Every registration a client bills under, not one number on the client row.
//
// A corporate bills through several: different cost centres, different validity
// windows, a new certificate arriving before the old one lapses. Which one
// invoices a booking is a lookup — cost centre plus date — so it has to be a
// list, and each row has to carry the window it is good for.
//
// A row may have NO number yet. Holder, address, cost centre and validity are
// often on file before the certificate comes through, and refusing the row until
// then just means keeping it in a spreadsheet.
// ─────────────────────────────────────────────────────────────────────────────

interface Registration {
  id: string
  gstin: string | null
  gst_holder: string | null
  email: string | null
  contact: string | null
  address_1: string | null
  address_2: string | null
  city: string | null
  state: string | null
  country: string | null
  zip: string | null
  registration_date: string | null
  valid_from: string | null
  valid_to: string | null
  cost_centre_id: string | null
  is_primary: boolean
}

type Draft = Partial<Registration>

const EMPTY: Draft = {
  gstin: '', gst_holder: '', email: '', contact: '',
  address_1: '', address_2: '', city: '', state: '', country: '', zip: '',
  registration_date: '', valid_from: '', valid_to: '',
  cost_centre_id: null, is_primary: false,
}

export default function GstTab({ clientId, onCount }: {
  clientId: string
  onCount?: (n: number) => void
}) {
  const [rows, setRows] = useState<Registration[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  // null = the add form; a row id = editing that row in place.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const centreLookup = useLookup('/api/tmc/cost-centres', draft.cost_centre_id ?? '', {
    params: { clientId },
    toOption: row => ({ id: String(row.id), label: String(row.code), sublabel: String(row.name ?? '') }),
  })

  const load = useCallback(() => {
    fetch(`/api/tmc/clients/${clientId}/gst`)
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { setError(d.error || 'Could not load registrations.'); return }
        setRows(d.registrations)
        onCount?.(d.registrations.length)
      })
      .catch(() => setError('Could not load registrations.'))
      .finally(() => setLoading(false))
  }, [clientId, onCount])

  useEffect(() => { load() }, [load])

  function setField<K extends keyof Registration>(key: K, value: Registration[K]) {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  function startAdd() { setDraft(EMPTY); setEditingId(null); setOpen(true); setError('') }

  function startEdit(row: Registration) {
    setDraft({ ...row })
    setEditingId(row.id)
    setOpen(true)
    setError('')
  }

  async function save() {
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/tmc/clients/${clientId}/gst`, {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingId ? { ...draft, entryId: editingId } : draft),
      })
      const d = await res.json()
      if (!res.ok) { setError(d.error || 'Could not save.'); return }
      setOpen(false); setDraft(EMPTY); setEditingId(null)
      load()
    } finally { setBusy(false) }
  }

  async function remove(row: Registration) {
    const name = row.gstin || row.gst_holder || 'this registration'
    if (!confirm(`Remove ${name}? Bookings already invoiced under it are not affected.`)) return
    await fetch(`/api/tmc/clients/${clientId}/gst?entryId=${row.id}`, { method: 'DELETE' })
    load()
  }

  // Warns, never blocks — the same call the branch master makes. The TMC holds
  // the certificate on paper and the software does not get to overrule it.
  const finding = gstinFinding(draft.gstin ?? '', draft.state ?? '')
  const pan = readGstin(draft.gstin ?? '').pan

  const today = new Date().toISOString().slice(0, 10)

  return (
    <>
      <p style={s.blockDesc}>
        Every GST registration this client bills under. Which one invoices a booking is decided by
        its cost centre and the dates it is valid for, so two registrations covering the same cost
        centre at the same time are refused — there would be no way to tell which applied.
      </p>

      {error && <div style={s.errorBanner}>{error}</div>}

      {loading ? (
        <p style={s.hint}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={s.hint}>No registrations on file. Invoices will have no GSTIN to quote.</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {['GST number', 'Holder', 'Email', 'Contact', 'Address', 'City', 'State', 'Country',
                  'Zip', 'Registered', 'Valid from', 'Valid to', 'Cost centre', ''].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const expired = Boolean(r.valid_to && r.valid_to < today)
                const td = { ...s.td, ...(expired ? s.tdExpired : {}) }
                return (
                  <tr key={r.id}>
                    <td style={{ ...td, ...s.mono }}>
                      {r.gstin || <span style={s.muted}>Not yet issued</span>}
                      {r.is_primary && <span style={{ ...s.countBadge, marginLeft: 6 }}>primary</span>}
                      {expired && <span style={{ ...s.pill, marginLeft: 6 }}>expired</span>}
                    </td>
                    <td style={td}>{r.gst_holder ?? '—'}</td>
                    <td style={td}>{r.email ?? '—'}</td>
                    <td style={td}>{r.contact ?? '—'}</td>
                    <td style={td}>{[r.address_1, r.address_2].filter(Boolean).join(', ') || '—'}</td>
                    <td style={td}>{r.city ?? '—'}</td>
                    <td style={td}>{r.state ?? '—'}</td>
                    <td style={td}>{r.country ?? '—'}</td>
                    <td style={td}>{r.zip ?? '—'}</td>
                    <td style={td}>{r.registration_date ?? '—'}</td>
                    <td style={td}>{r.valid_from ?? '—'}</td>
                    <td style={td}>{r.valid_to ?? 'Open-ended'}</td>
                    <td style={td}>{r.cost_centre_id ? <CostCentreName id={r.cost_centre_id} clientId={clientId} /> : '—'}</td>
                    <td style={td}>
                      <button onClick={() => startEdit(r)} style={s.smallBtn}>Edit</button>{' '}
                      <button onClick={() => remove(r)} style={s.dangerBtn}>Remove</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!open ? (
        <div style={s.actions}>
          <button onClick={startAdd} style={s.primaryBtn}>Add a registration</button>
        </div>
      ) : (
        <>
          <p style={s.subLabel}>{editingId ? 'Edit registration' : 'New registration'}</p>
          <div style={s.grid}>
            <Field label="GST number" hint="Leave blank if the certificate has not come through yet.">
              <input
                value={draft.gstin ?? ''}
                onChange={e => setField('gstin', e.target.value.toUpperCase())}
                placeholder="27AAFCI0980H1ZI"
                style={{ ...s.input, ...s.mono }}
              />
            </Field>
            <Field label="PAN" hint="Characters 3 to 12 of the GSTIN. Never stored separately.">
              <input
                readOnly disabled value={pan ?? ''}
                placeholder={draft.gstin ? 'Not a well-formed GSTIN' : '—'}
                style={{ ...s.input, ...s.mono, ...s.readOnly }}
              />
            </Field>
            <Field label="GST holder">
              <input value={draft.gst_holder ?? ''} onChange={e => setField('gst_holder', e.target.value)} style={s.input} />
            </Field>

            <Field label="Email">
              <input type="email" value={draft.email ?? ''} onChange={e => setField('email', e.target.value)} style={s.input} />
            </Field>
            <Field label="Contact">
              <input value={draft.contact ?? ''} onChange={e => setField('contact', e.target.value)} style={s.input} />
            </Field>
            <Field label="Cost centre" hint="Which of this client's cost centres bills under this number.">
              <SearchableSelect
                value={draft.cost_centre_id ?? ''}
                onChange={id => setField('cost_centre_id', id || null)}
                options={centreLookup.options} onSearch={centreLookup.onSearch}
                loading={centreLookup.loading} selectedLabel={centreLookup.selectedLabel}
                placeholder="None" emptyMessage="No cost centres match"
                allowClear clearLabel="None"
              />
            </Field>

            <Field label="Address line 1" span={2}>
              <input value={draft.address_1 ?? ''} onChange={e => setField('address_1', e.target.value)} style={s.input} />
            </Field>
            <Field label="Address line 2">
              <input value={draft.address_2 ?? ''} onChange={e => setField('address_2', e.target.value)} style={s.input} />
            </Field>

            <Field label="Country">
              <CountryDropdown value={draft.country ?? ''} onChange={v => setField('country', v)} />
            </Field>
            <Field label="State" hint="Has to agree with the GSTIN's first two digits.">
              <StateDropdown value={draft.state ?? ''} onChange={v => setField('state', v)} />
            </Field>
            <Field label="City">
              <CityDropdown value={draft.city ?? ''} onChange={v => setField('city', v)} state={draft.state ?? undefined} />
            </Field>

            <Field label="Zip">
              <input value={draft.zip ?? ''} onChange={e => setField('zip', e.target.value)} style={s.input} />
            </Field>
            <Field label="Registration date">
              <input type="date" value={draft.registration_date ?? ''} onChange={e => setField('registration_date', e.target.value)} style={s.input} />
            </Field>
            <Field label="Primary" hint="The fallback when no cost centre matches. Only one per client.">
              <label style={{ ...s.checkRow, height: 36 }}>
                <input
                  type="checkbox"
                  checked={draft.is_primary === true}
                  onChange={e => setField('is_primary', e.target.checked)}
                />
                Use when nothing else matches
              </label>
            </Field>

            <Field label="Valid from">
              <input type="date" value={draft.valid_from ?? ''} onChange={e => setField('valid_from', e.target.value)} style={s.input} />
            </Field>
            <Field label="Valid to" hint="Leave blank for open-ended.">
              <input type="date" value={draft.valid_to ?? ''} onChange={e => setField('valid_to', e.target.value)} style={s.input} />
            </Field>
          </div>

          {finding && <p style={s.warnNote}>{finding}</p>}

          <div style={s.actions}>
            <button onClick={save} disabled={busy} style={{ ...s.primaryBtn, opacity: busy ? 0.5 : 1 }}>
              {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add registration'}
            </button>
            <button onClick={() => { setOpen(false); setEditingId(null); setError('') }} style={s.smallBtn}>
              Cancel
            </button>
          </div>
        </>
      )}
    </>
  )
}

// Resolves one cost centre id to its code for the table. Its own component so
// the lookup cache in useLookup does the deduplicating — several rows sharing a
// cost centre resolve it once.
function CostCentreName({ id, clientId }: { id: string; clientId: string }) {
  const lookup = useLookup('/api/tmc/cost-centres', id, {
    params: { clientId },
    toOption: row => ({ id: String(row.id), label: String(row.code) }),
  })
  return <span style={s.mono}>{lookup.selectedLabel || '…'}</span>
}
