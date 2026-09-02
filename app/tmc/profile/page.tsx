'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import { PERMISSIONS } from '@/app/lib/permissions/permissionKeys'

// ── /tmc/profile ─────────────────────────────────────────────────────────────
// The account page for TMC-side users.
//
// It exists because the rail used to link them at /profile — the TRAVELLER
// profile, which asks for passport number, date of birth and meal preference.
// None of that applies to a travel counsellor; they administer other people's
// travel, they don't book their own through this system.
//
// Four sections, deliberately full-width and spaced: this is a page someone
// reads occasionally, not a dense working surface like the roster screens.
// ─────────────────────────────────────────────────────────────────────────────

interface Account {
  id: string
  fullName: string
  email: string
  role: string
  status: string
  joinedAt: string
  tmcName: string | null
}

interface Access {
  fullAccess: boolean
  permissions: string[]
  clients: { id: string; name: string }[]
}

interface Activity {
  clients: number
  travellers: number
  bookings: number
  lastSignInAt: string | null
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function TmcProfilePage() {
  const [account, setAccount] = useState<Account | null>(null)
  const [access, setAccess] = useState<Access | null>(null)
  const [activity, setActivity] = useState<Activity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [name, setName] = useState('')
  const [savingName, setSavingName] = useState(false)

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetch('/api/tmc/profile')
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        if (!d.ok) { setError(d.error || 'Could not load your profile.'); return }
        setAccount(d.account); setAccess(d.access); setActivity(d.activity)
        setName(d.account.fullName)
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [])

  async function saveName(e: React.FormEvent) {
    e.preventDefault()
    setSavingName(true); setError(''); setSuccess('')
    try {
      const d = await fetch('/api/tmc/profile', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: name }),
      }).then(r => r.json())
      if (!d.ok) { setError(d.error || 'Could not save your name.'); return }
      setAccount(prev => (prev ? { ...prev, fullName: d.fullName } : prev))
      setSuccess('Name updated.')
    } finally { setSavingName(false) }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setSuccess('')

    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (password !== confirmPassword) { setError('Passwords do not match.'); return }

    setSavingPassword(true)
    try {
      // Done from the browser client, not a route: the user already holds a
      // session, and Supabase's updateUser is the supported path for a
      // self-service change. A server route would need the service client,
      // which can change anyone's password — more power than this needs.
      const supabase = createClient()
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) { setError(updateError.message); return }
      setPassword(''); setConfirmPassword('')
      setSuccess('Password changed. It applies the next time you sign in.')
    } finally { setSavingPassword(false) }
  }

  if (loading) {
    return (
      <div style={s.root}>
        <div style={s.loadingWrap}><div style={s.spinner} /></div>
      </div>
    )
  }

  if (!account) {
    return (
      <div style={s.root}>
        <div style={s.errorBanner}>⚠ {error || 'Could not load your profile.'}</div>
      </div>
    )
  }

  const grantedPermissions = PERMISSIONS.filter(p => access?.permissions.includes(p.key))

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h1 style={s.title}>My profile</h1>
        <p style={s.sub}>Your account, what you can reach, and your client portfolio.</p>
      </div>

      {error && <div style={s.errorBanner}>⚠ {error}</div>}
      {success && <div style={s.successBanner}>✓ {success}</div>}

      {/* ── Account ────────────────────────────────────────────────── */}
      <section style={s.card}>
        <h2 style={s.cardTitle}>Account</h2>

        <form onSubmit={saveName} style={s.nameRow}>
          <div style={{ ...s.field, flex: 1, minWidth: 240 }}>
            <label style={s.label} htmlFor="fullName">Name</label>
            <input
              id="fullName" type="text" value={name}
              onChange={e => setName(e.target.value)}
              style={s.input}
            />
          </div>
          <button
            type="submit"
            disabled={savingName || name.trim() === account.fullName}
            style={{ ...s.primaryBtn, opacity: savingName || name.trim() === account.fullName ? 0.5 : 1 }}
          >
            {savingName ? 'Saving…' : 'Save'}
          </button>
        </form>

        <dl style={s.defList}>
          <Detail label="Email" value={account.email} hint="Contact your TMC admin to change this" />
          <Detail label="Role" value={account.role === 'tmc_admin' ? 'TMC Admin' : 'Travel Counsellor'} />
          <Detail label="Organisation" value={account.tmcName ?? '—'} />
          <Detail label="Joined" value={formatDate(account.joinedAt)} />
        </dl>
      </section>

      {/* ── Access ─────────────────────────────────────────────────── */}
      <section style={s.card}>
        <h2 style={s.cardTitle}>Access</h2>
        <p style={s.cardSub}>
          What you can do and which clients you can reach. Granted by a TMC admin — if
          something is missing, ask them rather than looking for a setting.
        </p>

        {access?.fullAccess ? (
          <div style={s.fullAccess}>
            <strong>Full access.</strong> As a TMC admin you can reach every section and every
            client, without individual permissions being granted.
          </div>
        ) : grantedPermissions.length === 0 ? (
          <div style={s.warnBanner}>
            You have no permissions granted yet, so most sections are hidden. Ask a TMC admin to
            grant them.
          </div>
        ) : (
          <ul style={s.permList}>
            {grantedPermissions.map(p => (
              <li key={p.key} style={s.permItem}>
                <div style={s.permLabel}>
                  {p.label}
                  {p.reserved && <span style={s.reservedTag}>Not yet in use</span>}
                </div>
                <div style={s.permDesc}>{p.desc}</div>
              </li>
            ))}
          </ul>
        )}

        <h3 style={s.subHeading}>
          Clients {access?.fullAccess ? '' : `(${access?.clients.length ?? 0})`}
        </h3>
        {(access?.clients.length ?? 0) === 0 ? (
          <p style={s.muted}>No clients assigned to you yet.</p>
        ) : (
          <div style={s.chipRow}>
            {access?.clients.map(c => (
              <a key={c.id} href={`/tmc/clients/${c.id}`} style={s.chip}>{c.name}</a>
            ))}
          </div>
        )}
      </section>

      {/* ── Activity ───────────────────────────────────────────────── */}
      <section style={s.card}>
        <h2 style={s.cardTitle}>Activity</h2>
        <p style={s.cardSub}>Across the clients you can reach.</p>

        <div style={s.stats}>
          <Stat label="Clients" value={activity?.clients ?? 0} />
          <Stat label="Travellers" value={activity?.travellers ?? 0} />
          <Stat label="Bookings" value={activity?.bookings ?? 0} />
          <Stat label="Last sign-in" value={formatDate(activity?.lastSignInAt ?? null)} small />
        </div>

        <p style={s.footnote}>
          These count the whole portfolio, not your personal activity. Bookings do not currently
          record which counsellor made them — every booking is stored against the traveller — so a
          per-counsellor figure would be invented. It arrives with book-on-behalf.
        </p>
      </section>

      {/* ── Security ───────────────────────────────────────────────── */}
      <section style={s.card}>
        <h2 style={s.cardTitle}>Security</h2>
        <p style={s.cardSub}>Change your password. You stay signed in on this device.</p>

        <form onSubmit={changePassword} style={s.passwordForm}>
          <div style={{ ...s.field, flex: 1, minWidth: 200 }}>
            <label style={s.label} htmlFor="password">New password</label>
            <input
              id="password" type="password" value={password} autoComplete="new-password"
              onChange={e => setPassword(e.target.value)}
              placeholder="At least 8 characters" style={s.input}
            />
          </div>
          <div style={{ ...s.field, flex: 1, minWidth: 200 }}>
            <label style={s.label} htmlFor="confirmPassword">Confirm</label>
            <input
              id="confirmPassword" type="password" value={confirmPassword} autoComplete="new-password"
              onChange={e => setConfirmPassword(e.target.value)}
              style={s.input}
            />
          </div>
          <button
            type="submit"
            disabled={savingPassword || !password}
            style={{ ...s.primaryBtn, opacity: savingPassword || !password ? 0.5 : 1 }}
          >
            {savingPassword ? 'Changing…' : 'Change password'}
          </button>
        </form>
      </section>
    </div>
  )
}

function Detail({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={s.detail}>
      <dt style={s.label}>{label}</dt>
      <dd style={s.detailValue}>{value}</dd>
      {hint && <dd style={s.detailHint}>{hint}</dd>}
    </div>
  )
}

function Stat({ label, value, small }: { label: string; value: string | number; small?: boolean }) {
  return (
    <div style={s.stat}>
      <span style={s.label}>{label}</span>
      <span style={small ? s.statValueSmall : s.statValue}>{value}</span>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  root: { padding: '28px 32px 60px', maxWidth: 860 },
  header: { marginBottom: 22 },
  title: { fontSize: 22, fontWeight: 700, color: '#0A0A14', margin: '0 0 4px', letterSpacing: '-0.4px' },
  sub: { fontSize: 13, color: '#6B7280', margin: 0 },

  card: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 24, marginBottom: 18 },
  cardTitle: { fontSize: 15, fontWeight: 600, color: '#111827', margin: '0 0 4px' },
  cardSub: { fontSize: 12.5, color: '#9CA3AF', margin: '0 0 18px', lineHeight: 1.6, maxWidth: 560 },
  subHeading: { fontSize: 11, fontWeight: 700, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.6px', margin: '24px 0 10px' },

  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.5px' },
  input: { height: 38, padding: '0 11px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 7, outline: 'none', width: '100%' },

  nameRow: { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 22 },
  passwordForm: { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' },
  primaryBtn: { height: 38, padding: '0 18px', background: '#000835', color: '#fff', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap' },

  defList: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 18, margin: 0 },
  detail: { display: 'flex', flexDirection: 'column', gap: 4 },
  detailValue: { fontSize: 13.5, color: '#111827', margin: 0 },
  detailHint: { fontSize: 11, color: '#9CA3AF', margin: 0 },

  fullAccess: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '12px 14px', fontSize: 12.5, color: '#065F46', lineHeight: 1.6 },
  warnBanner: { background: '#FEF3C7', border: '1px solid #FDE68A', borderRadius: 8, padding: '12px 14px', fontSize: 12.5, color: '#92400E', lineHeight: 1.6 },
  permList: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 14 },
  permItem: { borderLeft: '2px solid #EEF2FF', paddingLeft: 12 },
  permLabel: { fontSize: 13, fontWeight: 600, color: '#111827', display: 'flex', alignItems: 'center', gap: 8 },
  permDesc: { fontSize: 12, color: '#6B7280', marginTop: 2, lineHeight: 1.5 },
  reservedTag: { fontSize: 10, fontWeight: 600, color: '#92400E', background: '#FEF3C7', borderRadius: 4, padding: '2px 6px' },

  chipRow: { display: 'flex', gap: 7, flexWrap: 'wrap' },
  chip: { fontSize: 12, color: '#3730A3', background: '#EEF2FF', borderRadius: 6, padding: '5px 10px', textDecoration: 'none' },

  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14 },
  stat: { display: 'flex', flexDirection: 'column', gap: 5, padding: '14px 16px', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 9 },
  statValue: { fontSize: 24, fontWeight: 700, color: '#0A0A14', letterSpacing: '-0.5px' },
  statValueSmall: { fontSize: 14, fontWeight: 600, color: '#374151' },
  footnote: { fontSize: 11, color: '#9CA3AF', margin: '16px 0 0', lineHeight: 1.6, maxWidth: 620 },

  errorBanner: { background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '11px 14px', fontSize: 12.5, color: '#DC2626', marginBottom: 16 },
  successBanner: { background: '#ECFDF5', border: '1px solid #A7F3D0', borderRadius: 8, padding: '11px 14px', fontSize: 12.5, color: '#065F46', marginBottom: 16 },
  muted: { fontSize: 12.5, color: '#9CA3AF', margin: 0 },

  loadingWrap: { display: 'flex', justifyContent: 'center', padding: 80 },
  spinner: { width: 24, height: 24, border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
}
