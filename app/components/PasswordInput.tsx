'use client'

import { useState } from 'react'

// ── PasswordInput ────────────────────────────────────────────────────────────
// A password field with a reveal toggle.
//
// One component rather than a toggle copied into five places — login, both
// fields on set-password, and both on the TMC profile. Copies drift, and the
// accessibility details below are exactly the sort that get dropped on the
// fourth copy.
//
// WHY THE REVEAL MATTERS MOST ON SET-PASSWORD
// Signing in, you are typing something you already know and a typo just fails.
// Setting a password, you are inventing one — a typo you cannot see becomes a
// password you cannot reproduce, twice, and the confirm field agrees with it.
//
// `autoComplete` is passed through untouched: browsers and password managers
// use it to decide whether to offer a saved credential or generate a new one,
// and getting it wrong quietly breaks that.
// ─────────────────────────────────────────────────────────────────────────────

interface PasswordInputProps {
  id?: string
  name?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  required?: boolean
  disabled?: boolean
  autoComplete?: string
  // The page's own input style. Every screen here carries its own `styles`
  // record, so the component borrows the caller's rather than imposing one and
  // looking foreign.
  style?: React.CSSProperties
}

export default function PasswordInput({
  id, name, value, onChange, placeholder, required, disabled, autoComplete, style,
}: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false)

  return (
    <div style={s.wrap}>
      <input
        id={id}
        name={name}
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autoComplete={autoComplete}
        // Room for the button, so a long password does not run underneath it.
        style={{ ...style, paddingRight: 42 }}
      />
      <button
        type="button"
        onClick={() => setRevealed(r => !r)}
        disabled={disabled}
        // aria-pressed carries the STATE. A label alone would announce
        // "button" and leave a screen-reader user unsure whether their password
        // is currently on screen.
        aria-pressed={revealed}
        aria-label={revealed ? 'Hide password' : 'Show password'}
        title={revealed ? 'Hide password' : 'Show password'}
        style={{ ...s.toggle, opacity: disabled ? 0.4 : 1 }}
      >
        {revealed ? (
          // Eye with a slash — currently visible, click to hide.
          <svg style={s.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10.6 10.6a3 3 0 0 0 4.2 4.2" />
            <path d="M16.7 16.7A9.7 9.7 0 0 1 12 18c-5 0-9-6-9-6a17.6 17.6 0 0 1 4.2-4.9" />
            <path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c5 0 9 6 9 6a17.7 17.7 0 0 1-2.2 2.9" />
            <path d="M3 3l18 18" />
          </svg>
        ) : (
          <svg style={s.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: { position: 'relative', display: 'flex', alignItems: 'stretch', width: '100%' },
  toggle: {
    position: 'absolute', right: 4, top: 0, bottom: 0,
    width: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#6B7280',
  },
  icon: { width: 17, height: 17 },
}
