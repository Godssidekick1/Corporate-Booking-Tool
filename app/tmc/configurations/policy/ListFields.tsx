'use client'

import { useEffect, useState } from 'react'
import AirlineDropdown from '@/app/components/AirlineDropdown'
import { FARE_TYPES } from '@/app/lib/policy/fareTypes'
import type { FieldDef } from '@/app/lib/policy/fields'

// ── List fields: airlines and fare types ─────────────────────────────────────
// A list rule is a set of codes, not one value, so it is edited as a stack of
// pickers rather than as a cell in the limits table. Airlines are picked from
// the reference list (searchable by code or name; a code nobody has searched
// yet can still be typed). Fare types are one row of chips.
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  fields: FieldDef[]
  values: Record<string, string[]>
  onChange: (key: string, value: string[]) => void
}

export default function ListFields({ fields, values, onChange }: Props) {
  const blocked = values['blocked_airlines'] ?? []
  const clash = (values['preferred_airlines'] ?? []).filter(code => blocked.includes(code))

  return (
    <div style={s.stack}>
      {fields.map(f => (
        <div key={f.key} style={s.field}>
          <div style={s.head}>
            <span style={s.label}>{f.label}</span>
            {f.help && <span style={s.help}>{f.help}</span>}
          </div>
          {f.listOf === 'fare_types'
            ? <FareTypeChips value={values[f.key] ?? []} onChange={v => onChange(f.key, v)} />
            : <AirlineList value={values[f.key] ?? []} onChange={v => onChange(f.key, v)} />}
          {f.key === 'preferred_airlines' && clash.length > 0 && (
            <p style={s.warn}>{clash.join(', ')} {clash.length === 1 ? 'is' : 'are'} also blocked; blocked wins, so {clash.length === 1 ? 'it' : 'they'} will not be shown.</p>
          )}
        </div>
      ))}
    </div>
  )
}

function AirlineList({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  // Names for the chips. Codes the list has never seen keep just their code.
  const [names, setNames] = useState<Record<string, string>>({})
  // Remounts the picker after each pick so it is empty for the next one.
  const [pickKey, setPickKey] = useState(0)

  const missing = value.filter(code => !(code in names)).join(',')
  useEffect(() => {
    if (!missing) return
    let live = true
    fetch(`/api/reference/airlines?ids=${encodeURIComponent(missing)}`)
      .then(r => r.json())
      .then(d => {
        if (!live) return
        const found: Record<string, string> = {}
        for (const code of missing.split(',')) found[code] = ''
        for (const row of (d.items ?? []) as { code: string; name: string }[]) found[row.code] = row.name
        setNames(n => ({ ...n, ...found }))
      })
      .catch(() => {})
    return () => { live = false }
  }, [missing])

  function add(code: string) {
    const c = code.trim().toUpperCase()
    if (/^[A-Z0-9]{2,3}$/.test(c) && !value.includes(c)) onChange([...value, c].sort())
    setPickKey(k => k + 1)
  }

  return (
    <div>
      {value.length > 0 && (
        <div style={s.chips}>
          {value.map(code => (
            <span key={code} style={s.chip}>
              <strong>{code}</strong>{names[code] ? <span style={s.chipName}> · {names[code]}</span> : null}
              <button type="button" aria-label={`Remove ${code}`} onClick={() => onChange(value.filter(v => v !== code))} style={s.chipX}>×</button>
            </span>
          ))}
        </div>
      )}
      <div style={s.picker}>
        <AirlineDropdown key={pickKey} value="" onChange={add} placeholder="Add an airline: search by code or name" />
      </div>
    </div>
  )
}

function FareTypeChips({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div style={s.chips}>
      {FARE_TYPES.map(t => {
        const on = value.includes(t.code)
        return (
          <button
            key={t.code}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter(v => v !== t.code) : [...value, t.code])}
            style={{ ...s.toggleChip, ...(on ? s.toggleChipOn : {}) }}
          >
            {on ? '✓ ' : ''}{t.label}
          </button>
        )
      })}
      {value.length === 0 && <span style={s.help}>All fare types allowed</span>}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  stack: { display: 'flex', flexDirection: 'column', gap: 18, padding: '4px 2px' },
  field: { display: 'flex', flexDirection: 'column', gap: 8 },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 },
  label: { fontSize: 13, fontWeight: 600, color: '#111827' },
  help: { fontSize: 12, color: '#6B7280' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 12, color: '#1E3A8A',
    background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 999, padding: '3px 4px 3px 10px',
  },
  chipName: { color: '#475569', fontWeight: 400 },
  chipX: {
    background: 'none', border: 'none', cursor: 'pointer', color: '#64748B', fontSize: 15,
    lineHeight: 1, padding: '0 6px',
  },
  picker: { maxWidth: 360, marginTop: 8 },
  toggleChip: {
    fontSize: 12, padding: '5px 11px', borderRadius: 999, border: '1px solid #D1D5DB',
    background: '#fff', color: '#374151', cursor: 'pointer', fontWeight: 500,
  },
  toggleChipOn: { background: '#000835', borderColor: '#000835', color: '#fff' },
  warn: { fontSize: 12, color: '#92400E', margin: 0 },
}
