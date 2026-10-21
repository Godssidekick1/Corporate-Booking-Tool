'use client'

import type { FieldDef } from '@/app/lib/policy/fields'

// ── One section of a policy group, as a form ─────────────────────────────────
// A row per field: what it is and a plain hint on the left, the value on the
// right. It replaces a table one row deep and up to twenty columns wide, which
// had to be scrolled sideways to reach most limits and gave no hint what any
// of them meant.
//
//   numeric   an amount with its unit beside it; empty means "no limit", and a
//             set value can be cleared in one click
//   tier      up to four choices as buttons, more as a list; "Not set" is a
//             choice of its own
//   boolean   Yes / No
// A field with inlineWith (the grace's unit) sits beside that field's input.
// ─────────────────────────────────────────────────────────────────────────────

type Value = number | boolean | string[] | null | undefined

interface Props {
  fields: FieldDef[]
  values: Record<string, Value>
  onChange: (key: string, value: number | boolean | null) => void
  onNumeric: (field: FieldDef, raw: string) => void
}

export default function FieldForm({ fields, values, onChange, onNumeric }: Props) {
  const inline = new Map(fields.filter(f => f.inlineWith).map(f => [f.inlineWith!, f]))
  return (
    <div style={s.form}>
      {fields.filter(f => !f.inlineWith).map(f => (
        <div key={f.key} style={s.row}>
          <div style={s.labelCol}>
            <span style={s.label}>{f.label}</span>
            {f.help && <span style={s.help}>{f.help}</span>}
          </div>
          <div style={s.control}>
            <Control field={f} value={values[f.key]} onChange={onChange} onNumeric={onNumeric} />
            {inline.has(f.key) && (
              <Control field={inline.get(f.key)!} value={values[inline.get(f.key)!.key]} onChange={onChange} onNumeric={onNumeric} compact />
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function Control({ field: f, value, onChange, onNumeric, compact = false }: {
  field: FieldDef
  value: Value
  onChange: Props['onChange']
  onNumeric: Props['onNumeric']
  compact?: boolean
}) {
  if (f.kind === 'boolean') {
    const on = Boolean(value)
    return (
      <div style={s.segment} role="group" aria-label={f.label}>
        <button type="button" onClick={() => onChange(f.key, true)} style={{ ...s.segBtn, ...(on ? s.segOn : {}) }}>Yes</button>
        <button type="button" onClick={() => onChange(f.key, false)} style={{ ...s.segBtn, ...(!on ? s.segOn : {}) }}>No</button>
      </div>
    )
  }

  if (f.kind === 'tier') {
    const options = f.options ?? []
    const current = value === null || value === undefined ? null : Number(value)
    if (options.length <= 4) {
      return (
        <div style={s.segment} role="group" aria-label={f.label}>
          {!compact && (
            <button type="button" onClick={() => onChange(f.key, null)} style={{ ...s.segBtn, ...(current === null ? s.segUnset : {}) }}>
              Not set
            </button>
          )}
          {options.map(o => (
            <button key={o.value} type="button" onClick={() => onChange(f.key, o.value)}
              style={{ ...s.segBtn, ...(current === o.value || (compact && current === null && o.value === options[0].value) ? s.segOn : {}) }}>
              {o.label}
            </button>
          ))}
        </div>
      )
    }
    return (
      <select
        value={current === null ? '' : String(current)}
        onChange={e => onChange(f.key, e.target.value === '' ? null : Number(e.target.value))}
        style={s.select}
      >
        <option value="">Not set</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  }

  // numeric
  const empty = value === null || value === undefined
  const prefix = f.unit === '₹' ? '₹' : null
  const suffix = f.unit && f.unit !== '₹' ? f.unit : null
  return (
    <div style={s.amount}>
      {prefix && <span style={s.adorn}>{prefix}</span>}
      <input
        type="number" inputMode="decimal"
        value={empty ? '' : Number(value)}
        onChange={e => onNumeric(f, e.target.value)}
        placeholder="No limit"
        min={0}
        step={f.wholeNumber ? 1 : 'any'}
        aria-label={f.label}
        style={s.numInput}
      />
      {suffix && <span style={s.adorn}>{suffix}</span>}
      {!empty && (
        <button type="button" onClick={() => onChange(f.key, null)} style={s.clear} aria-label={`Clear ${f.label}`} title="Clear">
          ×
        </button>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  form: { display: 'flex', flexDirection: 'column', padding: '4px 16px 12px' },
  row: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px 24px',
    padding: '12px 0', borderBottom: '1px solid #F3F4F6',
  },
  labelCol: { display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 260px', minWidth: 0 },
  label: { fontSize: 13, fontWeight: 600, color: '#111827' },
  help: { fontSize: 12, color: '#6B7280', lineHeight: 1.45 },
  control: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: '0 1 auto' },

  amount: {
    display: 'inline-flex', alignItems: 'center', height: 36, border: '1px solid #D1D5DB', borderRadius: 8,
    background: '#fff', overflow: 'hidden',
  },
  adorn: { padding: '0 10px', fontSize: 13, color: '#6B7280', background: '#F9FAFB', alignSelf: 'stretch', display: 'flex', alignItems: 'center' },
  numInput: { width: 120, height: '100%', padding: '0 10px', fontSize: 14, color: '#111827', border: 'none', outline: 'none', background: 'transparent' },
  clear: {
    alignSelf: 'stretch', padding: '0 10px', fontSize: 16, color: '#9CA3AF', background: 'none',
    borderWidth: '0 0 0 1px', borderStyle: 'solid', borderColor: '#E5E7EB', cursor: 'pointer',
  },

  segment: { display: 'inline-flex', flexWrap: 'wrap', borderRadius: 8, border: '1px solid #D1D5DB', overflow: 'hidden' },
  segBtn: {
    padding: '7px 12px', fontSize: 12.5, fontWeight: 500, color: '#374151', background: '#fff', cursor: 'pointer',
    borderWidth: '0 1px 0 0', borderStyle: 'solid', borderColor: '#E5E7EB',
  },
  segOn: { background: '#000835', color: '#fff' },
  segUnset: { background: '#F3F4F6', color: '#111827' },
  select: { height: 36, padding: '0 10px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 8, cursor: 'pointer', minWidth: 180 },
}
