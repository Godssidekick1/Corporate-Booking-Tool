'use client'

import { useEffect, useMemo, useState, useRef } from 'react'
import TmcShell from '@/app/components/TmcShell'

interface client_group {
  id: string
  name: string
  city: string | null
}

interface Company {
  id: string
  name: string
  status: string
  setup_completed: boolean
  created_at: string
  booking_mode: 'sbt' | 'cbt' | 'both'
  client_group_id: string | null
  client_groups: client_group | null
}

const BOOKING_MODE_LABEL: Record<Company['booking_mode'], string> = {
  sbt: 'SBT', cbt: 'CBT', both: 'Hybrid',
}

const UNASSIGNED_KEY = '__unassigned__'

export default function TmcCompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/tmc/companies')
      .then(r => r.json())
      .then(data => { if (data.ok) setCompanies(data.companies) })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // ── Suggestions: matching companies and client_groupes, combined ────────────────
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return { companies: [], client_groups: [] }

    const matchedCompanies = companies.filter(c => c.name.toLowerCase().includes(q)).slice(0, 6)

    const client_groupMap = new Map<string, client_group>()
    for (const c of companies) {
      if (c.client_groups && c.client_groups.name.toLowerCase().includes(q)) {
        client_groupMap.set(c.client_groups.id, c.client_groups)
      }
    }
    const matchedclient_groups = Array.from(client_groupMap.values()).slice(0, 6)

    return { companies: matchedCompanies, client_groups: matchedclient_groups }
  }, [query, companies])

  // ── Filtered + grouped-by-client_group, alphabetical ─────────────────────────────
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? companies.filter(c =>
          c.name.toLowerCase().includes(q) ||
          (c.client_groups?.name.toLowerCase().includes(q) ?? false)
        )
      : companies

    const byclient_group = new Map<string, { client_group: client_group | null; companies: Company[] }>()
    for (const c of filtered) {
      const key = c.client_groups?.id ?? UNASSIGNED_KEY
      if (!byclient_group.has(key)) {
        byclient_group.set(key, { client_group: c.client_groups, companies: [] })
      }
      byclient_group.get(key)!.companies.push(c)
    }

    const groupList = Array.from(byclient_group.values())
    groupList.sort((a, b) => {
      if (!a.client_group) return 1
      if (!b.client_group) return -1
      return a.client_group.name.localeCompare(b.client_group.name)
    })
    for (const g of groupList) {
      g.companies.sort((a, b) => a.name.localeCompare(b.name))
    }

    return groupList
  }, [companies, query])

  function selectSuggestion(text: string) {
    setQuery(text)
    setShowSuggestions(false)
  }

  const hasSuggestions = suggestions.companies.length > 0 || suggestions.client_groups.length > 0

  return (
    <TmcShell activeLabel="Companies">
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>Companies</h1>
          <p style={s.sub}>{companies.length} client{companies.length === 1 ? '' : 's'}, grouped by client group.</p>
        </div>
      </div>

      <div ref={searchRef} style={s.searchWrap}>
        <input
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); setShowSuggestions(true) }}
          onFocus={() => setShowSuggestions(true)}
          placeholder="Search companies or client groups…"
          style={s.searchInput}
        />
        {showSuggestions && query.trim() && hasSuggestions && (
          <div style={s.suggestionBox}>
            {suggestions.companies.length > 0 && (
              <div style={s.suggestionGroup}>
                <p style={s.suggestionLabel}>Companies</p>
                {suggestions.companies.map(c => (
                  <div
                    key={c.id}
                    onClick={() => { window.location.href = `/tmc/companies/${c.id}` }}
                    style={s.suggestionItem}
                  >
                    <span style={s.suggestionName}>{c.name}</span>
                    {c.client_groups && <span style={s.suggestionMeta}>{c.client_groups.name}</span>}
                  </div>
                ))}
              </div>
            )}
            {suggestions.client_groups.length > 0 && (
              <div style={s.suggestionGroup}>
                <p style={s.suggestionLabel}>Client groups</p>
                {suggestions.client_groups.map(b => (
                  <div
                    key={b.id}
                    onClick={() => selectSuggestion(b.name)}
                    style={s.suggestionItem}
                  >
                    <span style={s.suggestionName}>{b.name}</span>
                    {b.city && <span style={s.suggestionMeta}>{b.city}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {showSuggestions && query.trim() && !hasSuggestions && (
          <div style={s.suggestionBox}>
            <p style={s.noResults}>No matches for "{query}"</p>
          </div>
        )}
      </div>

      {loading ? (
        <div style={s.emptyState}><p style={s.emptyTitle}>Loading…</p></div>
      ) : groups.length === 0 ? (
        <div style={s.emptyState}>
          <p style={s.emptyTitle}>No companies found</p>
          <p style={s.emptyDesc}>Try a different search term, or add a client from the dashboard.</p>
        </div>
      ) : (
        <div style={s.groupList}>
          {groups.map(g => (
            <div key={g.client_group?.id ?? UNASSIGNED_KEY} style={s.groupSection}>
              <div style={s.groupHeader}>
                <h2 style={s.groupTitle}>
                  {g.client_group ? g.client_group.name : 'Unassigned'}
                  {g.client_group?.city && <span style={s.groupCity}> — {g.client_group.city}</span>}
                </h2>
                <span style={s.groupCount}>{g.companies.length}</span>
              </div>
              <div style={s.cardGrid}>
                {g.companies.map(c => (
                  <div
                    key={c.id}
                    onClick={() => { window.location.href = `/tmc/companies/${c.id}` }}
                    style={s.card}
                  >
                    <div style={s.cardTop}>
                      <span style={s.cardName}>{c.name}</span>
                      <span style={s.modeBadge}>{BOOKING_MODE_LABEL[c.booking_mode]}</span>
                    </div>
                    <div style={s.cardBottom}>
                      <span style={{
                        ...s.statusBadge,
                        background: c.setup_completed ? '#ECFDF5' : '#F3F4F6',
                        color: c.setup_completed ? '#065F46' : '#6B7280',
                      }}>
                        {c.setup_completed ? 'Setup complete' : 'Setup pending'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
    </TmcShell>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '1100px', margin: '0 auto', padding: '32px 40px' },
  header: { marginBottom: '16px' },
  heading: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0 },
  searchWrap: { position: 'relative' as const, marginBottom: '24px', maxWidth: '420px' },
  searchInput: {
    width: '100%', height: '40px', padding: '0 14px', fontSize: '14px', color: '#111827',
    background: '#fff', border: '1px solid #D1D5DB', borderRadius: '8px', outline: 'none', boxSizing: 'border-box' as const,
  },
  suggestionBox: {
    position: 'absolute' as const, top: '46px', left: 0, right: 0, zIndex: 10,
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.08)', maxHeight: '320px', overflowY: 'auto' as const, padding: '6px',
  },
  suggestionGroup: { marginBottom: '4px' },
  suggestionLabel: { fontSize: '10px', fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase' as const, letterSpacing: '0.5px', margin: '6px 8px 4px' },
  suggestionItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' },
  suggestionName: { color: '#111827', fontWeight: 500 },
  suggestionMeta: { color: '#9CA3AF', fontSize: '11px' },
  noResults: { fontSize: '12px', color: '#9CA3AF', padding: '10px', margin: 0, textAlign: 'center' as const },
  groupList: { display: 'flex', flexDirection: 'column', gap: '24px' },
  groupSection: {},
  groupHeader: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' },
  groupTitle: { fontSize: '14px', fontWeight: 600, color: '#111827', margin: 0 },
  groupCity: { fontWeight: 400, color: '#9CA3AF' },
  groupCount: { fontSize: '11px', color: '#9CA3AF', background: '#F3F4F6', borderRadius: '10px', padding: '1px 8px' },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' },
  card: {
    background: '#fff', border: '1px solid #E5E7EB', borderRadius: '10px', padding: '14px',
    cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '10px',
  },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' },
  cardName: { fontSize: '13px', fontWeight: 600, color: '#111827' },
  modeBadge: { fontSize: '10px', fontWeight: 700, color: '#3730A3', background: '#EEF2FF', borderRadius: '4px', padding: '2px 6px', flexShrink: 0 },
  cardBottom: {},
  statusBadge: { fontSize: '11px', fontWeight: 500, borderRadius: '4px', padding: '2px 8px' },
  emptyState: { padding: '48px 20px', textAlign: 'center' as const },
  emptyTitle: { fontSize: '14px', fontWeight: 600, color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', margin: 0 },
}