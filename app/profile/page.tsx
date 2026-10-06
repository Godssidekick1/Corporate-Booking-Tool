'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { CountrySelect, RegionSelect, CitySelect, DateField } from '@/app/components/places/PlacePickers'
import { genderForTitle, todayInput } from '@/app/lib/places/profileFormat'

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
  dateOfBirth: string             // DD/MM/YYYY, as stored
  hasPassport: boolean
  passportNumber: string
  issuingCountry: string
  nationality: string
  passportExpiryDate: string      // DD/MM/YYYY
  mealPreference: '' | 'Non-Veg' | 'Veg' | 'Vegan' | 'Eggetarian'
  email: string
  mobile: string
  address: string
  city: string
  state: string
  zipCode: string
  country: string                 // address country, ISO code
}

function emptyForm(): FormState {
  return {
    title: 'MR', gender: 'Male',
    dateOfBirth: '',
    hasPassport: false,
    passportNumber: '', issuingCountry: 'IN', nationality: 'IN',
    passportExpiryDate: '',
    mealPreference: '',
    email: '', mobile: '', address: '', city: '', state: '', zipCode: '', country: 'IN',
  }
}

export default function ProfilePage() {
  // useSearchParams() requires a Suspense boundary during static prerendering
  // (Next.js bails out to client-side rendering otherwise) — this wrapper is
  // the boundary; ProfilePageInner is the actual page content.
  return (
    <Suspense fallback={
      <div style={s.page}>
        <div style={s.root}>
          <div style={s.loadingCard}><div style={s.spinner} /></div>
        </div>
      </div>
    }>
      <ProfilePageInner />
    </Suspense>
  )
}

function ProfilePageInner() {
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
        setForm({
          title: p.title ?? 'MR',
          gender: p.gender ?? 'Male',
          dateOfBirth: p.dateOfBirth ?? '',
          hasPassport: Boolean(p.passportNumber),
          passportNumber: p.passportNumber ?? '',
          issuingCountry: p.issuingCountry ?? 'IN',
          nationality: p.nationality ?? 'IN',
          passportExpiryDate: p.passportExpiryDate ?? '',
          mealPreference: p.mealPreference ?? '',
          email: p.email ?? '',
          mobile: p.mobile ?? '',
          address: p.address ?? '',
          city: p.city ?? '',
          state: p.state ?? '',
          zipCode: p.zipCode ?? '',
          country: p.country ?? 'IN',
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

    const dateOfBirth = form.dateOfBirth
    if (!dateOfBirth) {
      setError('Please enter your complete date of birth.')
      return
    }

    const passportExpiryDate = form.hasPassport ? form.passportExpiryDate || undefined : undefined
    if (form.hasPassport && (!form.passportNumber || !passportExpiryDate)) {
      setError('Please complete all passport fields, or turn off "I have a passport" if you don\u2019t want to save one.')
      return
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      setError('Please enter a valid email address.')
      return
    }
    if (!/^[6-9]\d{9}$/.test(form.mobile)) {
      setError('Please enter a valid 10-digit mobile number.')
      return
    }
    if (!form.address.trim() || !form.city.trim() || !form.state.trim() || !form.zipCode.trim()) {
      setError('Please complete your address, city, state, and ZIP code.')
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
          email: form.email.trim(),
          mobile: form.mobile.trim(),
          address: form.address.trim(),
          city: form.city.trim(),
          state: form.state.trim(),
          zipCode: form.zipCode.trim(),
          country: form.country,
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
                <select
                  value={form.title}
                  onChange={e => {
                    update('title', e.target.value)
                    // MR is male, MRS / MS female: filled in, still editable.
                    const g = genderForTitle(e.target.value)
                    if (g) update('gender', g)
                  }}
                  style={s.input}
                >
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
              <DateField value={form.dateOfBirth} onChange={v => update('dateOfBirth', v)} max={todayInput()} style={{ ...s.input, maxWidth: '200px' }} />
            </div>

            <div style={s.field}>
  <label style={s.label}>Meal preference (optional)</label>
  <select
    value={form.mealPreference}
    onChange={e => update('mealPreference', e.target.value as FormState['mealPreference'])}
    style={s.input}
  >
    <option value="">Select meal preference</option>
    <option value="Non-Veg">Non-Veg</option>
    <option value="Veg">Veg</option>
    <option value="Vegan">Vegan</option>
    <option value="Eggetarian">Eggetarian</option>
  </select>
</div>
</div>
          <div style={s.section}>
            <h2 style={s.sectionTitle}>Contact details</h2>
            <p style={s.sectionSub}>Your primary number and address — used for booking confirmations and saved as your corporate record.</p>

            <div style={s.row}>
              <div style={s.field}>
                <label style={s.label}>Email</label>
                <input type="email" required value={form.email} onChange={e => update('email', e.target.value)} style={s.input} />
              </div>
              <div style={s.field}>
                <label style={s.label}>Mobile</label>
                <input type="tel" required value={form.mobile} onChange={e => update('mobile', e.target.value)} style={s.input} placeholder="10-digit number" />
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>Address</label>
              <input type="text" required value={form.address} onChange={e => update('address', e.target.value)} style={s.input} />
            </div>

            <div style={s.row}>
              <div style={s.field}>
                <label style={s.label}>Country</label>
                <CountrySelect
                  value={form.country}
                  onChange={v => { if (v !== form.country) setForm(prev => ({ ...prev, country: v, state: '', city: '' })) }}
                />
              </div>
              <div style={s.field}>
                <label style={s.label}>State</label>
                <RegionSelect
                  country={form.country} value={form.state}
                  onChange={v => setForm(prev => ({ ...prev, state: v, city: v === prev.state ? prev.city : '' }))}
                />
              </div>
            </div>

            <div style={s.row}>
              <div style={s.field}>
                <label style={s.label}>City</label>
                <CitySelect strict country={form.country} state={form.state} value={form.city} onChange={v => update('city', v)} />
              </div>
              <div style={s.field}>
                <label style={s.label}>ZIP code</label>
                <input type="text" required value={form.zipCode} onChange={e => update('zipCode', e.target.value)} style={s.input} />
              </div>
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
                    <CountrySelect value={form.issuingCountry} onChange={v => update('issuingCountry', v)} />
                  </div>
                  <div style={s.field}>
                    <label style={s.label}>Nationality</label>
                    <CountrySelect value={form.nationality} onChange={v => update('nationality', v)} />
                  </div>
                </div>
                <div style={s.field}>
                  <label style={s.label}>Passport expiry</label>
                  <DateField value={form.passportExpiryDate} onChange={v => update('passportExpiryDate', v)} min={todayInput()} style={{ ...s.input, maxWidth: '200px' }} />
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
  spinner: { width: '22px', height: '22px', border: '2.5px solid #E5E7EB', borderTopColor: '#000835', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },

  errorCard: { padding: '14px 16px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '12px', marginBottom: '16px' },
  errorText: { fontSize: '13px', color: '#DC2626', margin: 0 },
  successCard: { padding: '12px 16px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: '12px', marginBottom: '16px' },
  successText: { fontSize: '13px', color: '#166534', margin: 0, fontWeight: 600 },

  form: { display: 'flex', flexDirection: 'column' as const, gap: '20px' },
  section: { background: '#fff', border: '1px solid #E5E7EB', borderRadius: '16px', padding: '20px' },
  sectionTitle: { fontSize: '13px', fontWeight: 700, color: '#111827', margin: '0 0 14px' },
  sectionSub: { fontSize: '11.5px', color: '#9CA3AF', margin: '-8px 0 14px', lineHeight: 1.5 },

  passportToggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' },
  toggleLabel: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: '#6B7280', fontWeight: 500, cursor: 'pointer' },

  row: { display: 'flex', gap: '12px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '5px', marginBottom: '14px', flex: 1 },
  label: { fontSize: '11.5px', color: '#6B7280', fontWeight: 600 },
  input: {
    height: '40px', border: '1px solid #D1D5DB', borderRadius: '8px', padding: '0 12px',
    fontSize: '13.5px', color: '#111827', outline: 'none', width: '100%', boxSizing: 'border-box' as const,
  },
  submitBtn: {
    height: '48px', width: '100%', background: '#000835', color: '#fff', fontSize: '14px', fontWeight: 700,
    border: 'none', borderRadius: '10px', cursor: 'pointer', letterSpacing: '0.2px',
  },
}