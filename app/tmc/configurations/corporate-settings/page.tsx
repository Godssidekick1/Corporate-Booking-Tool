'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import SearchableSelect from '@/app/components/SearchableSelect'
import { useLookup } from '@/app/hooks/useLookup'
import { usePagedList } from '@/app/hooks/usePagedList'

// ── Configurations → Commercials → Corporate settings ────────────────────────
// A door, not a screen.
//
// Corporate Settings IS /tmc/clients/[id] — the client detail page, restructured
// into collapsible sections. This route exists because that page is reachable
// from Clients but nowhere in Configurations, and somebody looking for "the
// settings for a corporate" reasonably looks under Commercials.
//
// It deliberately edits nothing. Two screens storing one fact is how they drift;
// two doors onto one row is not, so this one finds a client and hands over.
// ─────────────────────────────────────────────────────────────────────────────

interface ClientRow {
  id: string
  name: string
  client_code: string | null
  city: string | null
  status: string
  client_groups: { name: string; group_code: string | null } | null
}

export default function CorporateSettingsPickerPage() {
  const router = useRouter()
  const [clientId, setClientId] = useState('')

  const lookup = useLookup('/api/tmc/clients', clientId, {
    toOption: row => ({
      id: String(row.id),
      label: String(row.name),
      sublabel: [row.client_code, row.city].filter(Boolean).join(' · ') || undefined,
    }),
  })

  // The most recently added clients, so the page is useful before anyone types.
  // A picker on an empty screen makes you guess what exists.
  const recent = usePagedList<ClientRow>('/api/tmc/clients')

  function go(id: string) {
    if (id) router.push(`/tmc/clients/${id}`)
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h1 style={s.title}>Corporate settings</h1>
        <p style={s.sub}>
          Everything configured about one client — booking controls, payer types, policy and
          approvals, mandatory information. Pick a client to open theirs.
        </p>
      </div>

      <div style={s.pickerRow}>
        <div style={{ flex: 1, maxWidth: 420 }}>
          <SearchableSelect
            value={clientId}
            onChange={id => { setClientId(id); go(id) }}
            options={lookup.options}
            onSearch={lookup.onSearch}
            loading={lookup.loading}
            selectedLabel={lookup.selectedLabel}
            placeholder="Search clients by name, code or city…"
            emptyMessage="No clients match"
          />
        </div>
        <Link href="/tmc/clients" style={s.ghostLink}>See all clients →</Link>
      </div>

      <p style={s.sectionLabel}>Recently added</p>
      {recent.loading ? (
        <p style={s.muted}>Loading…</p>
      ) : recent.items.length === 0 ? (
        <p style={s.muted}>No clients yet.</p>
      ) : (
        <div style={s.grid}>
          {recent.items.slice(0, 8).map(c => (
            <Link key={c.id} href={`/tmc/clients/${c.id}`} style={s.card}>
              <span style={s.cardName}>{c.name}</span>
              <span style={s.cardMeta}>
                {[c.client_code, c.client_groups?.group_code ?? c.client_groups?.name, c.city]
                  .filter(Boolean).join(' · ') || 'No code or group'}
              </span>
              {c.status !== 'active' && <span style={s.inactive}>{c.status}</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif" },
  header: { marginBottom: 18 },
  title: { fontSize: 20, fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0, lineHeight: 1.6, maxWidth: 640 },

  pickerRow: { display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 22 },
  ghostLink: { fontSize: 12.5, color: '#3730A3', textDecoration: 'underline', textUnderlineOffset: 2 },

  sectionLabel: { fontSize: 11, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 10px' },
  muted: { fontSize: 12.5, color: '#9CA3AF', margin: 0 },

  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 },
  card: {
    display: 'flex', flexDirection: 'column', gap: 4,
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: 9,
    padding: '12px 14px', textDecoration: 'none',
  },
  cardName: { fontSize: 13, fontWeight: 600, color: '#111827' },
  cardMeta: { fontSize: 11, color: '#9CA3AF' },
  inactive: { fontSize: 10, fontWeight: 600, color: '#6B7280', background: '#F3F4F6', borderRadius: 4, padding: '1px 6px', alignSelf: 'flex-start', marginTop: 2 },
}
