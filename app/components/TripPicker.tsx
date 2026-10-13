'use client'

import { useEffect, useState } from 'react'

// ── TripPicker ───────────────────────────────────────────────────────────────
// Which trip a booking made for someone else goes under: none, one of the
// traveller's open trips, or a new one named here. Used by the travel desk
// (/tmc/book) and by a corporate admin booking a colleague (the search page).
// The trip is the TRAVELLER's (GET/POST /api/trips with travellerId), so it is
// in their trips; creating it waits until the booking starts (resolveTrip), so
// abandoning the choice leaves no empty trip behind.
// ─────────────────────────────────────────────────────────────────────────────

export type TripChoice =
  | { kind: 'none' }
  | { kind: 'existing'; id: string }
  | { kind: 'new'; name: string }

interface TripRow { id: string; name: string | null; status: string; travel_date: string | null; updated_at: string }

const NEW = '__new__'

export default function TripPicker({ travellerId, travellerName, value, onChange }: {
  travellerId: string
  // Whose trips these are -- always said, so a booker never mistakes a
  // colleague's trip for one of their own.
  travellerName: string
  value: TripChoice
  onChange: (choice: TripChoice) => void
}) {
  const [trips, setTrips] = useState<TripRow[] | null>(null)
  const [more, setMore] = useState(false)

  useEffect(() => {
    let live = true
    // Their most recently touched trips, one page: the trip a booking belongs
    // to is nearly always a current one, and the list says when older exist.
    fetch(`/api/trips?travellerId=${encodeURIComponent(travellerId)}&page=1`).then(r => r.json())
      // Only trips still being planned take another booking.
      .then(d => {
        if (!live) return
        setTrips(d.ok ? (d.trips as TripRow[]).filter(t => t.status === 'open' || t.status === 'active') : [])
        setMore(d.ok && d.totalPages > 1)
      })
      .catch(() => { if (live) setTrips([]) })
    return () => { live = false }
  }, [travellerId])

  const selected = value.kind === 'existing' ? value.id : value.kind === 'new' ? NEW : ''
  const first = travellerName.split(' ')[0] || travellerName

  return (
    <div style={s.wrap}>
      <span style={s.label}>Trip <span style={s.whose}>· {travellerName}&apos;s trips</span></span>
      <select
        value={selected}
        onChange={e => {
          const v = e.target.value
          onChange(v === NEW ? { kind: 'new', name: '' } : v ? { kind: 'existing', id: v } : { kind: 'none' })
        }}
        style={s.input}
        aria-label="Trip"
        disabled={trips === null}
      >
        <option value="">{trips === null ? `Loading ${first}'s trips…` : 'No trip — a booking on its own'}</option>
        {trips !== null && trips.length > 0 && <optgroup label={`${travellerName}'s open trips`}>
        {trips.map(t => (
          <option key={t.id} value={t.id}>
            {t.name || 'Untitled trip'}{t.travel_date ? ` · ${new Date(t.travel_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : ''}
          </option>
        ))}
        </optgroup>}
        <option value={NEW}>+ New trip for {first}…</option>
      </select>
      {more && <span style={s.note}>{first}&apos;s most recent trips. Older ones are on their trips page.</span>}
      {value.kind === 'new' && (
        <input
          autoFocus
          value={value.name}
          onChange={e => onChange({ kind: 'new', name: e.target.value })}
          placeholder={`Trip name, e.g. ${first}'s Mumbai client visit`}
          style={s.input}
          aria-label="New trip name"
        />
      )}
      {(value.kind === 'new' || value.kind === 'existing') && (
        <span style={s.note}>
          {value.kind === 'new' ? 'Will be' : 'This is'} <strong>{travellerName}</strong>&apos;s trip: it is in their My trips, and in yours under
          Arranged for others — never mixed with your own.
        </span>
      )}
    </div>
  )
}

// The trip id to book under: an existing trip, a new one created now for the
// traveller, or none. Throws with the server's message if the trip cannot be
// created, so the caller can show it instead of starting the search.
export async function resolveTrip(travellerId: string, choice: TripChoice): Promise<string | null> {
  if (choice.kind === 'none') return null
  if (choice.kind === 'existing') return choice.id
  const name = choice.name.trim()
  if (!name) throw new Error('Give the new trip a name, or choose No trip.')
  const d = await fetch('/api/trips', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, travellerId }),
  }).then(r => r.json())
  if (!d.ok) throw new Error(d.error || 'Could not create the trip.')
  return d.trip.id as string
}

const s: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 8 },
  note: { fontSize: 11, color: '#6B7280', lineHeight: 1.5 },
  label: { fontSize: 11, fontWeight: 600, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' },
  whose: { fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: '#4338CA' },
  input: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, width: '100%' },
}
