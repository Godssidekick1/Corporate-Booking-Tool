'use client'

import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { usePagedList } from '@/app/hooks/usePagedList'
import Pagination from '@/app/components/Pagination'
import { ListHeader, list } from '@/app/components/config/ListPage'
import { Skeleton } from '@/app/components/Skeleton'

// The chart's shape while it loads: the chain above, the person, their reports.
function OrgChartSkeleton() {
  return (
    <div role="status" aria-label="Loading the organization">
      <div style={{ maxWidth: 560, margin: '8px auto 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <Skeleton style={{ height: 48, width: 256, borderRadius: 10 }} />
        <Skeleton style={{ height: 112, width: '100%', borderRadius: 14 }} />
      </div>
      <div style={{ marginTop: 24, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} style={{ height: 80, borderRadius: 12 }} />)}
      </div>
    </div>
  )
}

// ── /organization ────────────────────────────────────────────────────────────
// Who reports to whom, for everyone at the company, after Microsoft Teams'
// Organization tab and Org Explorer: the person in focus in the middle, the
// chain of managers above them to the top, their peers beside them and their
// direct reports below, with counts. It opens on you; search re-centres on
// anyone, and clicking any card does too. Your own reporting line is
// highlighted wherever it appears. The URL keeps ?focus= so a view can be
// shared. (GET /api/org, /api/org/people)
//
// Everyone sees each colleague's name, title, department and email. A band is
// shown on your own card only (and to corporate admins).
// ─────────────────────────────────────────────────────────────────────────────

interface Person {
  id: string
  name: string
  title: string | null
  department: string | null
  email: string
  isAdmin: boolean
  topOfHierarchy: boolean
  directReports: number
  band?: string | null
}
interface OrgView {
  me: string
  focus: Person & { totalReports: number }
  chain: Person[]
  peers: { people: Person[]; total: number }
  reports: { people: Person[]; total: number }
  myChain: string[]
  unassigned?: number
}

// A stable colour per person, from their name.
function hue(name: string): number {
  let h = 11
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase()).join('')

function Avatar({ name, size }: { name: string; size: number }) {
  const h = hue(name)
  return (
    <span aria-hidden="true" style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0, display: 'inline-grid', placeItems: 'center',
      background: `hsl(${h} 55% 92%)`, color: `hsl(${h} 55% 28%)`, fontWeight: 700, fontSize: Math.round(size * 0.38),
    }}>{initials(name)}</span>
  )
}

export default function OrganizationPage() {
  const [focus, setFocus] = useState<string | null>(null)
  const [view, setView] = useState<OrgView | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [showUnassigned, setShowUnassigned] = useState(false)
  const [copied, setCopied] = useState(false)

  // Arriving with ?focus= (a shared view) or ?unassigned=1 (from Company).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    // One read of the URL on arrival.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocus(q.get('focus'))
    if (q.get('unassigned') === '1') setShowUnassigned(true)
  }, [])

  // State is set only when the answer arrives; loading is switched on where
  // the person clicks (goTo), and is on from the start.
  const load = useCallback((id: string | null) => {
    fetch(`/api/org${id ? `?focus=${encodeURIComponent(id)}` : ''}`)
      .then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (!ok) { setError(body.error ?? 'Could not load the organization.'); return }
        setError('')
        setView(body)
      })
      .catch(() => setError('Could not load the organization. Check your connection and try again.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(focus) }, [focus, load])

  function goTo(id: string) {
    if (id !== focus) setLoading(true)
    setFocus(id)
    setQuery('')
    setCopied(false)
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('focus', id)
      url.searchParams.delete('unassigned')
      window.history.replaceState(null, '', url.toString())
    } catch { /* the view still changes */ }
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const results = usePagedList<Person>('/api/org/people', { enabled: query.trim().length > 0 })
  const searching = query.trim().length > 0

  const onMyLine = (id: string) => view?.myChain.includes(id) || id === view?.me

  return (
    <main className="page-frame">
      <ListHeader
        title="Organization"
        description="Who reports to whom. Search for anyone, or click a person to see their place in the company."
        actions={view && view.focus.id !== view.me
          ? <button type="button" style={list.ghostBtn} onClick={() => goTo(view.me)}>Back to me</button>
          : undefined}
      />

      <div style={{ position: 'relative', maxWidth: 460, marginBottom: 18 }}>
        <input
          type="search" value={query}
          onChange={e => { setQuery(e.target.value); results.setSearch(e.target.value) }}
          placeholder="Search by name, title, department or email"
          style={{ ...list.input, width: '100%' }} aria-label="Search people"
        />
        {searching && (
          <div style={dropdown} role="listbox">
            {results.loading ? <p style={dropNote}>Searching…</p>
              : results.items.length === 0 ? <p style={dropNote}>Nobody matches.</p>
              : results.items.map(p => (
                <button key={p.id} type="button" role="option" aria-selected="false" style={dropItem} onClick={() => goTo(p.id)}>
                  <Avatar name={p.name} size={28} />
                  <span style={{ minWidth: 0, textAlign: 'left' }}>
                    <b style={{ fontSize: 13, color: '#111827' }}>{p.name}</b>
                    <span style={{ display: 'block', fontSize: 11.5, color: '#6B7280' }}>{[p.title, p.department].filter(Boolean).join(' · ') || p.email}</span>
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>

      {view && typeof view.unassigned === 'number' && view.unassigned > 0 && (
        <div style={list.warnBanner}>
          <strong>{view.unassigned} {view.unassigned === 1 ? 'person has' : 'people have'} no manager set.</strong>{' '}
          Approval steps that go to their manager cannot reach them; your travel desk sets reporting lines.{' '}
          <button type="button" style={linkBtn} onClick={() => setShowUnassigned(v => !v)}>{showUnassigned ? 'Hide them' : 'See who'}</button>
        </div>
      )}
      {showUnassigned && view?.unassigned !== undefined && <Unassigned onPick={goTo} />}

      {error && <p style={list.errorBanner}>{error}</p>}
      {!view && loading && <OrgChartSkeleton />}

      {view && (
        <div style={{ ...stage, opacity: loading ? 0.55 : 1 }}>
          {/* ── Above: the managers, the top first ─────────────────── */}
          {view.chain.length > 0 && (
            <section aria-label="Reports to" style={column}>
              {[...view.chain].reverse().map(m => (
                <div key={m.id} style={column}>
                  <MiniCard p={m} highlight={onMyLine(m.id)} onClick={() => goTo(m.id)} />
                  <span style={connector} aria-hidden="true" />
                </div>
              ))}
            </section>
          )}
          {view.chain.length === 0 && view.focus.topOfHierarchy && <p style={topNote}>At the top of the company</p>}

          {/* ── The person in focus, with their peers beside ───────── */}
          <div style={focusRow}>
            <FocusCard p={view.focus} isMe={view.focus.id === view.me} copied={copied}
              onCopy={() => {
                navigator.clipboard?.writeText(view.focus.email).then(() => setCopied(true)).catch(() => setCopied(false))
              }} />
            {view.peers.total > 0 && (
              <aside style={peersBox} aria-label="Peers">
                <p style={sectionLabel}>Also reports to {view.chain[0]?.name.split(' ')[0] ?? 'the same manager'}</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {view.peers.people.map(p => <PeerRow key={p.id} p={p} highlight={p.id === view.me} onClick={() => goTo(p.id)} />)}
                </div>
                {view.peers.total > view.peers.people.length && (
                  <p style={moreNote}>and {view.peers.total - view.peers.people.length} more</p>
                )}
              </aside>
            )}
          </div>

          {/* ── Below: direct reports ──────────────────────────────── */}
          {view.reports.total > 0 && (
            <section aria-label="Direct reports" style={{ width: '100%', marginTop: 4 }}>
              <span style={{ ...connector, margin: '0 auto 8px' }} aria-hidden="true" />
              <p style={{ ...sectionLabel, textAlign: 'center' }}>
                {view.reports.total} direct report{view.reports.total === 1 ? '' : 's'}
              </p>
              <div style={reportsGrid}>
                {view.reports.people.map(p => <MiniCard key={p.id} p={p} highlight={p.id === view.me} onClick={() => goTo(p.id)} />)}
              </div>
              {view.reports.total > view.reports.people.length && (
                <p style={{ ...moreNote, textAlign: 'center' }}>and {view.reports.total - view.reports.people.length} more: search to find them</p>
              )}
            </section>
          )}
        </div>
      )}
    </main>
  )
}

function FocusCard({ p, isMe, copied, onCopy }: { p: Person & { totalReports: number }; isMe: boolean; copied: boolean; onCopy: () => void }) {
  return (
    <div style={focusCard}>
      <Avatar name={p.name} size={64} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 18, color: '#0A0A14', letterSpacing: '-0.2px' }}>{p.name}</h2>
          {isMe && <span style={{ ...tag, background: '#000835', color: '#fff' }}>You</span>}
          {p.isAdmin && <span style={{ ...tag, background: '#EEF2FF', color: '#3730A3' }}>Corporate admin</span>}
        </div>
        <p style={{ margin: '3px 0 0', fontSize: 13.5, color: '#374151' }}>{[p.title, p.department].filter(Boolean).join(' · ') || 'No title set'}</p>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: '#374151', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ overflowWrap: 'anywhere' }}>{p.email}</span>
          <button type="button" style={linkBtn} onClick={onCopy}>{copied ? 'Copied' : 'Copy email'}</button>
        </p>
        <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap', fontSize: 12.5, color: '#6B7280' }}>
          <span><b style={{ color: '#111827' }}>{p.directReports}</b> direct report{p.directReports === 1 ? '' : 's'}</span>
          <span><b style={{ color: '#111827' }}>{p.totalReports}</b> in total</span>
          {p.band !== undefined && <span>Band <b style={{ color: '#111827' }}>{p.band ?? '—'}</b></span>}
        </div>
      </div>
    </div>
  )
}

function MiniCard({ p, highlight, onClick }: { p: Person; highlight: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ ...miniCard, ...(highlight ? onLine : {}) }} title={highlight ? 'Your reporting line' : undefined}>
      <Avatar name={p.name} size={36} />
      <span style={{ minWidth: 0, textAlign: 'left' }}>
        <b style={{ display: 'block', fontSize: 13, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</b>
        <span style={{ display: 'block', fontSize: 11.5, color: '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {[p.title, p.department].filter(Boolean).join(' · ') || p.email}
        </span>
      </span>
      {p.directReports > 0 && <span style={count} title={`${p.directReports} direct reports`}>{p.directReports}</span>}
    </button>
  )
}

function PeerRow({ p, highlight, onClick }: { p: Person; highlight: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ ...peerRow, ...(highlight ? onLine : {}) }}>
      <Avatar name={p.name} size={26} />
      <span style={{ minWidth: 0, textAlign: 'left', fontSize: 12.5, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {p.name}{p.title ? <span style={{ color: '#6B7280' }}> · {p.title}</span> : null}
      </span>
    </button>
  )
}

// Admins: who has no manager and is not the top.
function Unassigned({ onPick }: { onPick: (id: string) => void }) {
  const people = usePagedList<Person>('/api/org/people', { params: { unassigned: 1 } })
  return (
    <section style={{ ...list.tableWrap, marginBottom: 18 }}>
      <table style={list.table}>
        <thead><tr>{['Person', 'Title', 'Department'].map(h => <th key={h} style={list.th}>{h}</th>)}</tr></thead>
        <tbody>
          {people.items.map(p => (
            <tr key={p.id} style={list.row} onClick={() => onPick(p.id)}>
              <td style={list.td}><span style={list.name}>{p.name}</span><span style={list.sublabel}>{p.email}</span></td>
              <td style={list.td}>{p.title ?? <span style={list.muted}>—</span>}</td>
              <td style={list.td}>{p.department ?? <span style={list.muted}>—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: '0 10px' }}>
        <Pagination page={people.page} pageSize={10} total={people.total} onPageChange={people.setPage} busy={people.refreshing} noun="people" />
      </div>
    </section>
  )
}

const stage: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', transition: 'opacity 120ms' }
const column: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center' }
const connector: React.CSSProperties = { display: 'block', width: 2, height: 18, background: '#D1D5DB' }
const focusRow: React.CSSProperties = { display: 'flex', gap: 16, alignItems: 'flex-start', justifyContent: 'center', flexWrap: 'wrap', width: '100%' }
const focusCard: React.CSSProperties = { display: 'flex', gap: 16, alignItems: 'center', background: '#fff', border: '2px solid #000835', borderRadius: 14, padding: '18px 20px', boxShadow: '0 8px 24px rgba(0,8,53,0.08)', maxWidth: 520, width: '100%' }
const miniCard: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: '9px 12px', width: 260, maxWidth: '100%', cursor: 'pointer', position: 'relative' }
const onLine: React.CSSProperties = { borderColor: '#000835', boxShadow: 'inset 3px 0 0 #000835' }
const count: React.CSSProperties = { marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#3730A3', background: '#EEF2FF', borderRadius: 999, padding: '1px 8px' }
const peersBox: React.CSSProperties = { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: '12px 14px', width: 280, maxWidth: '100%' }
const peerRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: '1px solid transparent', borderRadius: 8, padding: '4px 6px', cursor: 'pointer', width: '100%' }
const reportsGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10, justifyItems: 'center' }
const sectionLabel: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 8px' }
const moreNote: React.CSSProperties = { fontSize: 12, color: '#6B7280', margin: '8px 0 0' }
const topNote: React.CSSProperties = { fontSize: 12, color: '#065F46', background: '#ECFDF5', borderRadius: 999, padding: '3px 10px', margin: '0 0 10px' }
const tag: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '2px 8px' }
const linkBtn: React.CSSProperties = { background: 'none', border: 0, padding: 0, color: '#3730A3', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }
const dropdown: React.CSSProperties = { position: 'absolute', top: 40, left: 0, right: 0, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 10, boxShadow: '0 12px 28px rgba(10,10,20,0.12)', zIndex: 20, maxHeight: 320, overflowY: 'auto', padding: 4 }
const dropItem: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', background: 'none', border: 0, borderRadius: 8, padding: '7px 8px', cursor: 'pointer' }
const dropNote: React.CSSProperties = { fontSize: 12.5, color: '#6B7280', margin: 0, padding: '8px 10px' }
