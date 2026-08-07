'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

// ── /profile ───────────────────────────────────────────────────────────────
// Employee's own travel details, filled in once and reused to autofill
// passenger slot 1 whenever they book a flight for themselves — closes the
// "why am I typing my own details in every time" gap. Stored on
// employees.traveler_profile (jsonb), one object per employee — see
// TravelerProfile in lib/book/types.ts.
//
// Reachable normally (e.g. from settings), and also the forced landing page
// on first login (proxy.ts redirects here if first_login_completed is
// false) — the ?first=1 query param just changes the framing copy, the form
// and save behavior are identical either way.
// ─────────────────────────────────────────────────────────────────────────────

interface FormState {
  title: string
  gender: string
  dobDay: string
  dobMonth: string
  dobYear: string
  hasPassport: boolean
  passportNumber: string
  issuingCountry: string
  nationality: string
  passportExpiryDay: string
  passportExpiryMonth: string
  passportExpiryYear: string
  mealPreference: string
}

function emptyForm(): FormState {
  return {
    title: 'MR', gender: 'Male',
    dobDay: '', dobMonth: '', dobYear: '',
    hasPassport: false,
    passportNumber: '', issuingCountry: 'IN', nationality: 'IN',
    passportExpiryDay: '', passportExpiryMonth: '', passportExpiryYear: '',
    mealPreference: '',
  }
}

// DD/MM/YYYY <-> separate day/month/year fields. Kept as three plain number
// inputs rather than <input type="date"> so someone entering their own
// birth year isn't fighting a date-picker widget defaulting to today.
function toDdMmYyyy(day: string, month: string, year: string): string | undefined {
  if (!day || !month || !year) return undefined
  return `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`
}

function fromDdMmYyyy(value: string | undefined): [string, string, string] {
  if (!value) return ['', '', '']
  const [d, m, y] = value.split('/')
  return [d ?? '', m ?? '', y ?? '']
}

export default function ProfilePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const isFirstLogin = searchParams.get('first') === '1'

  const [form, setForm] = useState<FormState>(emptyForm())
  const [fullName, setFullName] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    loadProfile()
  }, [])

  async function loadProfile() {
    try {
      const res = await fetch('/api/employees/me')
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not load your profile.')
        return
      }
      setFullName(data.fullName ?? '')
      const p = data.travelerProfile
      if (p) {
        const [dobDay, dobMonth, dobYear] = fromDdMmYyyy(p.dateOfBirth)
        const [expDay, expMonth, expYear] = fromDdMmYyyy(p.passportExpiryDate)
        setForm({
          title: p.title ?? 'MR',
          gender: p.gender ?? 'Male',
          dobDay, dobMonth, dobYear,
          hasPassport: Boolean(p.passportNumber),
          passportNumber: p.passportNumber ?? '',
          issuingCountry: p.issuingCountry ?? 'IN',
          nationality: p.nationality ?? 'IN',
          passportExpiryDay: expDay, passportExpiryMonth: expMonth, passportExpiryYear: expYear,
          mealPreference: p.mealPreference ?? '',
        })
      }
    } catch {
      setError('Something went wrong loading your profile.')
    } finally {
      setLoading(false)
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSaved(false)

    const dateOfBirth = toDdMmYyyy(form.dobDay, form.dobMonth, form.dobYear)
    if (!dateOfBirth) {
      setError('Please enter your complete date of birth.')
      return
    }

    const passportExpiryDate = form.hasPassport
      ? toDdMmYyyy(form.passportExpiryDay, form.passportExpiryMonth, form.passportExpiryYear)
      : undefined
    if (form.hasPassport && (!form.passportNumber || !passportExpiryDate)) {
      setError('Please complete all passport fields, or turn off "I have a passport" if you don\u2019t want to save one.')
      return
    }

    setSaving(true)
    try {
      const res = await fetch('/api/employees/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          gender: form.gender,
          dateOfBirth,
          ...(form.hasPassport ? {
            passportNumber: form.passportNumber,
            issuingCountry: form.issuingCountry,
            nationality: form.nationality,
            passportExpiryDate,
          } : {}),
          mealPreference: form.mealPreference || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Could not save your profile.')
        return
      }
      setSaved(true)
      if (isFirstLogin) {
        router.push('/dashboard')
      }
    } catch {
      setError('Something went wrong saving your profile.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.loadingCard}><div style={s.spinner} /></div>
        </div>
      </div>
    )
  }

  return (
    <div style={s.page}>
      <div style={s.root}>
        {!isFirstLogin && (
          <Link href="/dashboard" style={s.backLink}>← Back to dashboard</Link>
        )}

        <div style={s.header}>
          <h1 style={s.heading}>{isFirstLogin ? `Welcome, ${fullName.split(' ')[0] || 'there'}` : 'My travel profile'}</h1>
          <p style={s.sub}>
            {isFirstLogin
              ? 'Save your travel details once, and we\u2019ll fill them in automatically every time you book a flight for yourself.'
              : 'Used to autofill your own details whenever you book a flight for yourself.'}
          </p>
        </div>

        {error && (
          <div style={s.errorCard}><p style={s.errorText}>⚠ {error}</p></div>
        )}
        {saved && !isFirstLogin && (
          <div style={s.successCard}><p style={s.successText}>✓ Saved</p></div>
        )}

        <form onSubmit={handleSubmit} style={s.form}>
          <div style={s.section}>
            <h2 style={s.sectionTitle}>Basic details</h2>
            <div style={s.row}>
              <div style={s.field}>
                <label style={s.label}>Title</label>
                <select value={form.title} onChange={e => update('title', e.target.value)} style={s.input}>
                  <option value="MR">Mr</option>
                  <option value="MRS">Mrs</option>
                  <option value="MS">Ms</option>
                </select>
              </div>
              <div style={s.field}>
                <label style={s.label}>Gender</label>
                <select value={form.gender} onChange={e => update('gender', e.target.value)} style={s.input}>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                </select>
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>Date of birth</label>
              <div style={s.dobRow}>
                <input type="number" placeholder="DD" min={1} max={31} value={form.dobDay} onChange={e => update('dobDay', e.target.value)} style={s.dobInput} required />
                <input type="number" placeholder="MM" min={1} max={12} value={form.dobMonth} onChange={e => update('dobMonth', e.target.value)} style={s.dobInput} required />
                <input type="number" placeholder="YYYY" min={1900} max={new Date().getFullYear()} value={form.dobYear} onChange={e => update('dobYear', e.target.value)} style={{ ...s.dobInput, width: '76px' }} required />
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>Meal preference (optional)</label>
              <input type="text" value={form.mealPreference} onChange={e => update('mealPreference', e.target.value)} style={s.input} placeholder="e.g. Vegetarian" />
            </div>
          </div>

          <div style={s.section}>
            <div style={s.passportToggleRow}>
              <h2 style={s.sectionTitle}>Passport details</h2>
              <label style={s.toggleLabel}>
                <input type="checkbox" checked={form.hasPassport} onChange={e => update('hasPassport', e.target.checked)} />
                I have a passport
              </label>
            </div>

            {form.hasPassport && (
              <>
                <div style={s.field}>
                  <label style={s.label}>Passport number</label>
                  <input type="text" required={form.hasPassport} value={form.passportNumber} onChange={e => update('passportNumber', e.target.value.toUpperCase())} style={s.input} />
                </div>
                <div style={s.row}>
                  <div style={s.field}>
                    <label style={s.label}>Issuing country</label>
                    <input type="text" required={form.hasPassport} value={form.issuingCountry} onChange={e => update('issuingCountry', e.target.value.toUpperCase())} style={s.input} maxLength={2} placeholder="IN" />
                  </div>
                  <div style={s.field}>
                    <label style={s.label}>Nationality</label>
                    <input type="text" required={form.hasPassport} value={form.nationality} onChange={e => update('nationality', e.target.value.toUpperCase())} style={s.input} maxLength={2} placeholder="IN" />
                  </div>
                </div>
                <div style={s.field}>
                  <label style={s.label}>Passport expiry</label>
                  <div style={s.dobRow}>
                    <input type="number" placeholder="DD" min={1} max={31} value={form.passportExpiryDay} onChange={e => update('passportExpiryDay', e.target.value)} style={s.dobInput} required={form.hasPassport} />
                    <input type="number" placeholder="MM" min={1} max={12} value={form.passportExpiryMonth} onChange={e => update('passportExpiryMonth', e.target.value)} style={s.dobInput} required={form.hasPassport} />
                    <input type="number" placeholder="YYYY" value={form.passportExpiryYear} onChange={e => update('passportExpiryYear', e.target.value)} style={{ ...s.dobInput, width: '76px' }} required={form.hasPassport} />
                  </div>
                </div>
              </>
            )}
          </div>

          <button type="submit" disabled={saving} style={s.submitBtn}>
            {saving ? 'Saving…' : isFirstLogin ? 'Save and continue →' : 'Save profile'}
          </button>
        </form>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: { background: '#F9FAFB', minHeight: '100vh' },
  root: { fontFamily: "'Inter', -apple-system, sans-serif", maxWidth: '520px', margin: '0 auto', padding: '32px 24px 64px' },

  backLink: { fontSize: '13px', color: '#6B7280', textDecoration: 'none', display: 'inline-block', marginBottom: '16px' },

  header: { marginBottom: '20px' },
  heading: { fontSize: '22px', fontWeight: 700, color: '#0A0A14', margin: '0 0 6px', letterSpacing: '-0.4px' },
  sub: { fontSize: '13px', color: '#6B7280', margin: 0, lineHeight: 1.5 },

  loadingCard: { display: 'flex', justifyContent: 'center', padding: '80px 0' },
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%' },

  errorCard: { padding: '14px 16px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '12px', marginBottom: '16px' },
  errorText: { fontSize: '13px', color: '#DC2626', margin: 0 },
  successCard: { padding: '12px 16px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '12px', marginBottom: '16px' },
  successText: { fontSize: '13px', color: '#166534', margin: 0, fontWeight: 600 },

  form: { display: 'flex', flexDirection: 'column' as const, gap: '20px' },
  section: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '16px', padding: '20px' },
  sectionTitle: { fontSize: '13px', fontWeight: 700, color: '#111827', margin: '0 0 14px' },

  passportToggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' },
  toggleLabel: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: '#6B7280', fontWeight: 500, cursor: 'pointer' },

  row: { display: 'flex', gap: '12px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '5px', marginBottom: '14px', flex: 1 },
  label: { fontSize: '11.5px', color: '#6B7280', fontWeight: 600 },
  input: {
    height: '40px', border: '1px solid #D1D5DB', borderRadius: '8px', padding: '0 12px',
    fontSize: '13.5px', color: '#111827', outline: 'none', width: '100%', boxSizing: 'border-box' as const,
  },
  dobRow: { display: 'flex', gap: '8px' },
  dobInput: {
    height: '40px', width: '56px', border: '1px solid #D1D5DB', borderRadius: '8px', padding: '0 10px',
    fontSize: '13.5px', color: '#111827', outline: 'none', textAlign: 'center' as const,
  },

  submitBtn: {
    height: '48px', width: '100%', background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700,
    border: 'none', borderRadius: '10px', cursor: 'pointer', letterSpacing: '0.2px',
  },
}
