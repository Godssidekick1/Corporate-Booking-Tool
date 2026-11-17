'use client'

import { useState, type ReactNode } from 'react'
import { CATEGORIES, formatFieldValue, type CategoryDef, type FieldDef } from '@/app/lib/policy/fields'
import FieldForm from './FieldForm'
import ListFields from './ListFields'

// ── A policy group's limits, one section at a time ───────────────────────────
// The policy's categories (app/lib/policy/fields.ts) as an accordion: one open
// at a time, Fares first. A folded section says how many limits it sets and
// the first few of them. The TMC's editor and the company admin's read-only
// view are this same component; readOnly turns the inputs into text.
// ─────────────────────────────────────────────────────────────────────────────

export type CellVal = number | boolean | string[] | null
export type Grid = Record<string, CellVal>

const isSet = (v: CellVal | undefined) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)

// Booleans are real configuration but not counted: a correct "No" is not less
// configured than a "Yes".
export function countSetFields(grid: Grid, category: CategoryDef): { set: number; total: number } {
  const countable = category.fields.filter(f => f.kind !== 'boolean' && !f.inlineWith)
  return { set: countable.filter(f => isSet(grid[f.key])).length, total: countable.length }
}

// What a folded section holds, in a line: its set values, the first few.
export function sectionSummary(grid: Grid, category: CategoryDef): string {
  const shown = category.fields
    .filter(f => !f.inlineWith && f.kind !== 'boolean')
    .filter(f => isSet(grid[f.key]))
    .map(f => {
      // A value whose unit is a field of its own (the grace) says it.
      const unit = category.fields.find(u => u.inlineWith === f.key)
      const unitText = unit ? ' ' + formatFieldValue(unit, (grid[unit.key] ?? unit.options?.[0]?.value) as number) : ''
      return `${f.label}: ${formatFieldValue(f, grid[f.key] as number | boolean | string[])}${unitText}`
    })
  if (shown.length === 0) return 'Nothing set'
  return shown.length > 3 ? `${shown.slice(0, 3).join(' · ')} · +${shown.length - 3} more` : shown.join(' · ')
}

interface Props {
  grid: Grid
  readOnly?: boolean
  onChange?: (key: string, value: CellVal) => void
  onNumeric?: (field: FieldDef, raw: string) => void
  // Anything a section needs below its fields (the TMC's override note).
  extra?: (category: CategoryDef) => ReactNode
}

export default function PolicyAccordion({ grid, readOnly = false, onChange, onNumeric, extra }: Props) {
  const [open, setOpen] = useState<string | null>('flight')
  return (
    <div style={s.categories}>
      {CATEGORIES.map((cat, ci) => {
        const isOpen = open === cat.id
        const { set, total } = countSetFields(grid, cat)
        return (
          <div key={cat.id} style={{ ...s.block, marginTop: ci === 0 ? 0 : 12 }}>
            <button type="button" onClick={() => setOpen(isOpen ? null : cat.id)} aria-expanded={isOpen}
              style={{ ...s.header, background: cat.color }}>
              <div style={s.headerLeft}>
                <span style={{ ...s.dot, background: cat.textColor }} />
                <span style={{ ...s.label, color: cat.textColor }}>{cat.label}</span>
                {total > 0 && (
                  <span style={{ ...s.badge, color: cat.textColor, border: `1px solid ${cat.textColor}40`, background: cat.textColor + '12' }}>
                    {readOnly ? `${set} ${set === 1 ? 'limit' : 'limits'} set` : `${set} / ${total} set`}
                  </span>
                )}
              </div>
              {!isOpen && <span style={{ ...s.summary, color: cat.textColor }}>{sectionSummary(grid, cat)}</span>}
              <span aria-hidden="true" style={{ ...s.chevron, color: cat.textColor, transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>▾</span>
            </button>

            {isOpen && (
              <div style={s.inner}>
                {cat.description && <p style={s.desc}>{cat.description}</p>}
                {cat.fields.every(f => f.kind === 'list') ? (
                  <ListFields
                    fields={cat.fields} readOnly={readOnly}
                    values={Object.fromEntries(cat.fields.map(f => [f.key, Array.isArray(grid[f.key]) ? grid[f.key] as string[] : []]))}
                    onChange={onChange}
                  />
                ) : (
                  <FieldForm fields={cat.fields} values={grid} readOnly={readOnly} onChange={onChange} onNumeric={onNumeric} />
                )}
                {extra?.(cat)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  categories: { display: 'flex', flexDirection: 'column' },
  block: { border: '1px solid #E5E7EB', borderRadius: 9, overflow: 'hidden', background: '#fff' },
  header: { width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', border: 'none', cursor: 'pointer', textAlign: 'left' },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  dot: { width: 6, height: 6, borderRadius: '50%', display: 'inline-block' },
  label: { fontSize: 13, fontWeight: 600 },
  badge: { fontSize: 10, fontWeight: 600, border: '1px solid', borderRadius: 4, padding: '2px 7px' },
  chevron: { fontSize: 13, transition: 'transform 0.2s', display: 'block' },
  summary: { flex: 1, minWidth: 0, margin: '0 12px', fontSize: 12, opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'right' },
  desc: { fontSize: 12, color: '#6B7280', margin: '10px 16px 0', lineHeight: 1.5 },
  inner: { display: 'flex', flexDirection: 'column', gap: 4 },
}
