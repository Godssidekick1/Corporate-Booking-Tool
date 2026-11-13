'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Pagination from '@/app/components/Pagination'
import { SkeletonTable } from '@/app/components/Skeleton'
import { usePagedList } from '@/app/hooks/usePagedList'
import { ListHeader, ListFilters, ListEmpty, list } from '@/app/components/config/ListPage'

// ── Configurations → Corporate settings ──────────────────────────────────────
// Every client, in the one list layout: search, open a client, and its
// Corporate Settings page (/tmc/clients/[id]) is where everything about it is
// configured: booking controls, payer types, policy and approvals, refunds,
// mandatory information.
//
// It edits nothing itself. Two screens storing one fact is how they drift; two
// doors onto one record is not, so this one lists clients and hands over.
// ─────────────────────────────────────────────────────────────────────────────

interface ClientRow {
  id: string
  name: string
  client_code: string | null
  city: string | null
  status: string
  booking_mode: 'sbt' | 'cbt' | 'both'
  client_groups: { name: string; group_code: string | null } | null
  branches: { name: string } | null
  employeeCount: number
}

const MODE_LABEL: Record<ClientRow['booking_mode'], string> = { sbt: 'SBT', cbt: 'CBT', both: 'Hybrid' }

export default function CorporateSettingsPage() {
  const router = useRouter()
  const [showInactive, setShowInactive] = useState(false)
  const clients = usePagedList<ClientRow>('/api/tmc/clients', {
    params: { includeInactive: showInactive ? '1' : '' },
  })

  return (
    <div style={list.root}>
      <ListHeader
        title="Corporate settings"
        description="Everything configured about each client: booking controls, payer types, policy and approvals, refunds and mandatory information. Open a client to see and change theirs."
        actions={<Link href="/tmc/clients" style={{ ...list.ghostBtn, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>Manage clients</Link>}
      />

      <ListFilters>
        <input
          type="search" value={clients.search} onChange={e => clients.setSearch(e.target.value)}
          placeholder="Search name, code or city" style={list.search} aria-label="Search clients"
        />
        <label style={list.check}>
          <input type="checkbox" checked={showInactive} onChange={e => { setShowInactive(e.target.checked); clients.setPage(1) }} />
          Show deactivated
        </label>
      </ListFilters>

      {clients.error ? (
        <p style={list.errorBanner}><strong>Could not load clients.</strong> {clients.error}</p>
      ) : clients.loading ? (
        <SkeletonTable rows={8} cols={6} />
      ) : clients.items.length === 0 ? (
        <ListEmpty
          title={clients.search ? 'No clients match that search' : 'No clients yet'}
          description={clients.search ? 'Search covers every client, not just this page.' : 'Clients you onboard appear here.'}
        />
      ) : (
        <div style={{ ...list.tableWrap, ...(clients.refreshing ? list.dimmed : {}) }}>
          <table style={list.table}>
            <thead>
              <tr>{['Client', 'Group', 'City', 'Branch', 'Booking mode', 'People', 'Status'].map(h => <th key={h} style={list.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {clients.items.map(c => (
                <tr key={c.id} style={list.row} onClick={() => router.push(`/tmc/clients/${c.id}`)}>
                  <td style={list.td}>
                    <Link href={`/tmc/clients/${c.id}`} style={{ ...list.name, textDecoration: 'none' }} onClick={e => e.stopPropagation()}>{c.name}</Link>
                    {c.client_code && <span style={{ ...list.sublabel, ...list.mono }}>{c.client_code}</span>}
                  </td>
                  <td style={list.td}>{c.client_groups?.name ?? <span style={list.muted}>—</span>}</td>
                  <td style={list.td}>{c.city ?? <span style={list.muted}>—</span>}</td>
                  <td style={list.td}>{c.branches?.name ?? <span style={list.muted}>—</span>}</td>
                  <td style={list.td}>{MODE_LABEL[c.booking_mode] ?? c.booking_mode}</td>
                  <td style={{ ...list.td, ...list.num }}>{c.employeeCount}</td>
                  <td style={list.td}>
                    <span style={{ ...list.pill, ...(c.status === 'active' ? { color: '#166534', background: '#DCFCE7' } : { color: '#6B7280', background: '#F3F4F6' }) }}>
                      {c.status === 'active' ? 'Active' : c.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={clients.page} pageSize={10} total={clients.total} onPageChange={clients.setPage} busy={clients.refreshing} noun="clients" />
    </div>
  )
}
