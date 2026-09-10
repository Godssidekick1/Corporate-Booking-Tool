'use client'

import { Fragment, useEffect, useMemo, useState, useRef } from 'react'
import Link from 'next/link'
import Pagination from '@/app/components/Pagination'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'

// ── /tmc/clients ─────────────────────────────────────────────────────────────
// Every client, as a table.
//
// This was a grid of cards grouped by client group, and each card carried a
// name, a mode badge and a setup pill — which meant nothing about a client was
// visible until you opened it. Grouping was the right instinct and survives as a
// row header; the cards do not.
//
// Clicking through lands on Corporate Settings, which IS the client detail page
// rather than a second screen beside it.
// ─────────────────────────────────────────────────────────────────────────────

interface ClientGroupRef {
  id: string
  name: string
  city: string | null
  group_code: string | null
}

interface BranchRef {
  id: string
  name: string
  branch_no: string | null
}

interface Client {
  id: string
  name: string
  status: string
  setup_completed: boolean
  created_at: string
  booking_mode: 'sbt' | 'cbt' | 'both'
  client_group_id: string | null
  client_code: string | null
  city: string | null
  country: string | null
  email: string | null
  primary_contact_phone: string | null
  branch_id: string | null
  client_groups: ClientGroupRef | null
  branches: BranchRef | null
  employeeCount: number
}

const BOOKING_MODE_LABEL: Record<Client['booking_mode'], string> = {
  sbt: 'SBT', cbt: 'CBT', both: 'Hybrid',
}

const UNASSIGNED_KEY = '__unassigned__'

function dash(value: string | null | undefined) {
  return value ? value : <span style={s.muted}>—</span>
}

export default function TmcClientsPage() {
  const [showSuggestions, setShowSuggestions] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)

  // Server-paged and server-searched. The suggestion box below is built from
  // whatever the SERVER matched rather than from a locally held array — with a
  // paged list, filtering in the browser would quietly search ten rows and
  // present the result as if it had searched everything.
  const list = usePagedList<Client>('/api/tmc/clients')
  const clients = list.items
  const query = list.search

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return { clients: [], client_groups: [] as ClientGroupRef[] }

    // `clients` is already the server's matches for this query, so this is a
    // slice for display, not a second filter.
    const matchedClients = clients.slice(0, 6)

    const groupMap = new Map<string, ClientGroupRef>()
    for (const c of clients) {
      if (c.client_groups && c.client_groups.name.toLowerCase().includes(q)) {
        groupMap.set(c.client_groups.id, c.client_groups)
      }
    }

    return { clients: matchedClients, client_groups: Array.from(groupMap.values()).slice(0, 6) }
  }, [query, clients])

  // Grouping only — the server has already applied the search and the paging.
  const groups = useMemo(() => {
    const byGroup = new Map<string, { group: ClientGroupRef | null; clients: Client[] }>()
    for (const c of clients) {
      const key = c.client_groups?.id ?? UNASSIGNED_KEY
      if (!byGroup.has(key)) byGroup.set(key, { group: c.client_groups, clients: [] })
      byGroup.get(key)!.clients.push(c)
    }

    const groupList = Array.from(byGroup.values())
    groupList.sort((a, b) => {
      if (!a.group) return 1
      if (!b.group) return -1
      return a.group.name.localeCompare(b.group.name)
    })
    for (const g of groupList) g.clients.sort((a, b) => a.name.localeCompare(b.name))

    return groupList
  }, [clients])

  const hasSuggestions = suggestions.clients.length > 0 || suggestions.client_groups.length > 0

  // One header row for the table, plus the group header rows spliced in. Kept as
  // a constant so the colSpan on those group rows cannot drift from the number
  // of columns actually rendered.
  const COLUMNS = ['Code', 'Client', 'Group', 'City', 'Country', 'Email', 'Mobile', 'Branch', 'Mode', 'People', 'Status', 'Registered', '']

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div>
          <h1 style={s.heading}>Clients</h1>
          <p style={s.sub}>
            {list.total} client{list.total === 1 ? '' : 's'}, grouped by client group. Open one to
            reach its Corporate Settings.
          </p>
        </div>
      </div>

      <div ref={searchRef} style={s.searchWrap}>
        <input
          type="text"
          value={query}
          onChange={e => { list.setSearch(e.target.value); setShowSuggestions(true) }}
          onFocus={() => setShowSuggestions(true)}
          placeholder="Search clients by name, code or city…"
          style={s.searchInput}
        />
        {showSuggestions && query.trim() && hasSuggestions && (
          <div style={s.suggestionBox}>
            {suggestions.clients.length > 0 && (
              <div style={s.suggestionGroup}>
                <p style={s.suggestionLabel}>Clients</p>
                {suggestions.clients.map(c => (
                  <Link key={c.id} href={`/tmc/clients/${c.id}`} style={s.suggestionItem}>
                    <span style={s.suggestionName}>{c.name}</span>
                    {c.client_groups && <span style={s.suggestionMeta}>{c.client_groups.name}</span>}
                  </Link>
                ))}
              </div>
            )}
            {suggestions.client_groups.length > 0 && (
              <div style={s.suggestionGroup}>
                <p style={s.suggestionLabel}>Client groups</p>
                {suggestions.client_groups.map(b => (
                  <div
                    key={b.id}
                    onClick={() => { list.setSearch(b.name); setShowSuggestions(false) }}
                    style={{ ...s.suggestionItem, cursor: 'pointer' }}
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
            <p style={s.noResults}>No matches for &ldquo;{query}&rdquo;</p>
          </div>
        )}
      </div>

      {list.loading ? (
        <SkeletonTable rows={8} cols={8} />
      ) : groups.length === 0 ? (
        <div style={s.emptyState}>
          <p style={s.emptyTitle}>No clients found</p>
          <p style={s.emptyDesc}>
            {query ? 'Try a different search term.' : 'Add a client from the dashboard.'}
          </p>
        </div>
      ) : (
        <div style={{ ...s.tableWrap, ...(list.refreshing ? s.dimmed : {}) }}>
          <table style={s.table}>
            <thead>
              <tr>{COLUMNS.map(h => <th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {groups.map(g => (
                // Fragment carries the key, not the <tr> inside it. A group
                // renders two sibling blocks — a header row and its clients —
                // so the key belongs on the thing being repeated; putting it on
                // the first child leaves the list unkeyed as far as React is
                // concerned.
                <Fragment key={g.group?.id ?? UNASSIGNED_KEY}>
                  {/* The group header stays as a row rather than a separate
                      section, so every client still sits in one continuous
                      table and the columns line up down the whole page. */}
                  <tr>
                    <td colSpan={COLUMNS.length} style={s.groupRow}>
                      <span style={s.groupTitle}>{g.group ? g.group.name : 'Unassigned'}</span>
                      {g.group?.group_code && <span style={s.groupCode}>{g.group.group_code}</span>}
                      <span style={s.groupCount}>{g.clients.length}</span>
                    </td>
                  </tr>
                  {g.clients.map((c, i) => (
                    <tr key={c.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFAFA' }}>
                      <td style={{ ...s.td, ...s.mono }}>{dash(c.client_code)}</td>
                      <td style={s.td}>
                        <Link href={`/tmc/clients/${c.id}`} style={s.clientLink}>{c.name}</Link>
                      </td>
                      <td style={s.td}>{dash(c.client_groups?.group_code ?? c.client_groups?.name)}</td>
                      <td style={s.td}>{dash(c.city)}</td>
                      <td style={s.td}>{dash(c.country)}</td>
                      <td style={{ ...s.td, ...s.dim }}>{dash(c.email)}</td>
                      <td style={{ ...s.td, ...s.dim }}>{dash(c.primary_contact_phone)}</td>
                      <td style={s.td}>
                        {c.branches
                          ? <>{c.branches.name}{c.branches.branch_no && <span style={s.muted}> · {c.branches.branch_no}</span>}</>
                          : <span style={s.muted}>—</span>}
                      </td>
                      <td style={s.td}><span style={s.modeBadge}>{BOOKING_MODE_LABEL[c.booking_mode]}</span></td>
                      <td style={{ ...s.td, ...s.numeric }}>{c.employeeCount}</td>
                      <td style={s.td}>
                        <span style={{
                          ...s.statusBadge,
                          background: c.status === 'active' ? '#ECFDF5' : '#F3F4F6',
                          color: c.status === 'active' ? '#065F46' : '#6B7280',
                        }}>
                          {c.status}
                        </span>
                        {!c.setup_completed && <span style={s.setupPill}>Setup pending</span>}
                      </td>
                      <td style={{ ...s.td, ...s.numeric, ...s.dim }}>
                        {new Date(c.created_at).toLocaleDateString()}
                      </td>
                      <td style={{ ...s.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Link href={`/tmc/clients/${c.id}`} style={s.settingsLink}>Settings</Link>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={list.page} pageSize={10} total={list.total}
        onPageChange={list.setPage} busy={list.refreshing} noun="clients"
      />
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '1280px', margin: '0 auto', padding: '32px 40px' },
  header: { marginBottom: '16px' },
  heading: { fontSize: '20px', fontWeight: 600, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.3px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0 },

  searchWrap: { position: 'relative' as const, marginBottom: '18px', maxWidth: '420px' },
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
  suggestionItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', borderRadius: '6px', fontSize: '13px', textDecoration: 'none' },
  suggestionName: { color: '#111827', fontWeight: 500 },
  suggestionMeta: { color: '#9CA3AF', fontSize: '11px' },
  noResults: { fontSize: '12px', color: '#9CA3AF', padding: '10px', margin: 0, textAlign: 'center' as const },

  // min-width plus overflow-x, the same container every other table here uses —
  // thirteen columns will not fit a narrow window, and clipping the last ones is
  // how the Deactivate button went missing on the TC screen.
  tableWrap: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, overflowX: 'auto' },
  table: { borderCollapse: 'collapse' as const, width: '100%', minWidth: 1180 },
  th: { padding: '10px 12px', textAlign: 'left' as const, background: '#F9FAFB', borderBottom: '1px solid #E5E7EB', fontSize: 11, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' as const },
  td: { padding: '9px 12px', fontSize: 12.5, color: '#374151', borderBottom: '1px solid #F3F4F6', whiteSpace: 'nowrap' as const },
  mono: { fontFamily: 'var(--font-mono)' },
  dim: { color: '#6B7280' },
  numeric: { fontVariantNumeric: 'tabular-nums' as const },
  muted: { color: '#9CA3AF' },
  dimmed: { opacity: 0.55, transition: 'opacity 120ms ease' },

  groupRow: { padding: '10px 12px', background: '#F5F7FF', borderBottom: '1px solid #E5E7EB', borderTop: '1px solid #E5E7EB' },
  groupTitle: { fontSize: 12.5, fontWeight: 600, color: '#111827' },
  groupCode: { marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: '#3730A3', background: '#EEF2FF', borderRadius: 4, padding: '1px 6px' },
  groupCount: { marginLeft: 8, fontSize: 11, color: '#9CA3AF', background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, padding: '1px 8px' },

  clientLink: { color: '#111827', fontWeight: 600, textDecoration: 'none' },
  settingsLink: { fontSize: 11.5, color: '#374151', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 6, padding: '4px 10px', textDecoration: 'none' },
  modeBadge: { fontSize: '10px', fontWeight: 700, color: '#3730A3', background: '#EEF2FF', borderRadius: '4px', padding: '2px 6px' },
  statusBadge: { fontSize: '11px', fontWeight: 500, borderRadius: '4px', padding: '2px 8px' },
  setupPill: { marginLeft: 6, fontSize: 10, color: '#92400E', background: '#FEF3C7', borderRadius: 4, padding: '2px 6px' },

  emptyState: { padding: '48px 20px', textAlign: 'center' as const, background: '#fff', border: '1px dashed #D1D5DB', borderRadius: 10 },
  emptyTitle: { fontSize: '14px', fontWeight: 600, color: '#374151', margin: '0 0 6px' },
  emptyDesc: { fontSize: '13px', color: '#9CA3AF', margin: 0 },
}
