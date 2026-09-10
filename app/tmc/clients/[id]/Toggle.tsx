'use client'

// ── Toggle ───────────────────────────────────────────────────────────────────
// One Corporate Settings switch, with the thing it gates written next to it.
//
// The label is not decoration. A switch that silently does nothing is worse than
// no switch — the call already made about the `book_on_behalf` permission — so
// every toggle here says what it stops, and the ones with no enforcement point
// yet say THAT instead of implying they work.
// ─────────────────────────────────────────────────────────────────────────────

interface ToggleProps {
  label: string
  // What turning this off actually prevents. Shown under the label.
  effect: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  // Marks a switch that is stored but not yet enforced anywhere. Rendered
  // plainly rather than hidden: the setting is real, its effect is not, and
  // pretending otherwise is how people stop trusting the whole screen.
  reserved?: boolean
}

export default function Toggle({ label, effect, checked, onChange, disabled, reserved }: ToggleProps) {
  return (
    <label style={{ ...s.row, opacity: disabled ? 0.5 : 1 }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        style={s.box}
      />
      <span>
        <span style={s.label}>
          {label}
          {reserved && <span style={s.reserved}>not yet enforced</span>}
        </span>
        <span style={s.effect}>{effect}</span>
      </span>
    </label>
  )
}

const s: Record<string, React.CSSProperties> = {
  row: { display: 'flex', alignItems: 'flex-start', gap: 9, padding: '7px 0', cursor: 'pointer' },
  box: { marginTop: 2, flexShrink: 0 },
  label: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 500, color: '#111827' },
  effect: { display: 'block', fontSize: 11.5, color: '#6B7280', lineHeight: 1.5, marginTop: 1 },
  reserved: {
    fontSize: 9.5, fontWeight: 600, color: '#92400E', background: '#FEF3C7',
    border: '1px solid #FDE68A', borderRadius: 4, padding: '1px 5px',
    textTransform: 'uppercase', letterSpacing: '0.04em',
  },
}
