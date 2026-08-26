'use client'

import { useRef } from 'react'

export interface BandDraft {
  code: string
  label: string
  rank: number
}

// ── nextBandCode ─────────────────────────────────────────────────────────────
// Guesses what the admin would type next, so a ladder can be built by holding
// Tab instead of typing every row. Handles the two shapes people actually use:
//
//   trailing number  A1 -> A2,  L09 -> L10,  Band 3 -> Band 4
//   trailing letter  A  -> B,   AC  -> AD
//
// Zero-padding is preserved (L09 -> L10, not L9) so a ladder stays visually
// aligned. Returns null when there's no sensible successor (empty, or ends in
// Z) — the caller then adds a blank row rather than inventing something wrong.
// ─────────────────────────────────────────────────────────────────────────────
export function nextBandCode(code: string): string | null {
  const trimmed = code.trim()
  if (!trimmed) return null

  const numMatch = trimmed.match(/^(.*?)(\d+)$/)
  if (numMatch) {
    const [, prefix, digits] = numMatch
    const incremented = String(Number(digits) + 1)
    // Keep the original width only if it was zero-padded to begin with.
    const padded = digits.startsWith('0')
      ? incremented.padStart(digits.length, '0')
      : incremented
    return prefix + padded
  }

  const last = trimmed[trimmed.length - 1]
  if (/[A-Ya-y]/.test(last)) {
    return trimmed.slice(0, -1) + String.fromCharCode(last.charCodeAt(0) + 1)
  }

  return null
}

interface Props {
  bands: BandDraft[]
  onChange: (bands: BandDraft[]) => void
  disabled?: boolean
}

export default function BandLadderEditor({ bands, onChange, disabled }: Props) {
  const codeRefs = useRef<(HTMLInputElement | null)[]>([])

  function update(index: number, patch: Partial<BandDraft>) {
    onChange(bands.map((b, i) => (i === index ? { ...b, ...patch } : b)))
  }

  function appendBand(fromIndex: number) {
    const previous = bands[fromIndex]
    const suggested = nextBandCode(previous.code) ?? ''
    const nextRank = Math.max(...bands.map(b => b.rank)) + 1

    onChange([...bands, { code: suggested, label: '', rank: nextRank }])

    // Focus the new row's code field on the next paint so Tab can be held to
    // build the whole ladder without touching the mouse.
    requestAnimationFrame(() => codeRefs.current[bands.length]?.focus())
  }

  function removeBand(index: number) {
    if (bands.length === 1) return
    onChange(bands.filter((_, i) => i !== index))
  }

  // Tab on the LAST row's code field means "and the next one" rather than
  // "move to the label field". Only when that row already has a code, so Tab
  // still behaves normally on an empty trailing row.
  function handleCodeKeyDown(e: React.KeyboardEvent<HTMLInputElement>, index: number) {
    const isLast = index === bands.length - 1
    if (e.key !== 'Tab' || e.shiftKey || !isLast) return
    if (!bands[index].code.trim()) return

    e.preventDefault()
    appendBand(index)
  }

  const duplicateCodes = new Set(
    bands
      .map(b => b.code.trim().toLowerCase())
      .filter((code, i, all) => code && all.indexOf(code) !== i)
  )

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <div>
          <span style={s.title}>Bands</span>
          <p style={s.hint}>
            Name these however the client does — <code style={s.code}>A1</code>,{' '}
            <code style={s.code}>C</code>, <code style={s.code}>Band 3</code>. Rank is what
            policy matches on, so rank 1 is the most junior. Type a code and press{' '}
            <kbd style={s.kbd}>Tab</kbd> to add the next one automatically.
          </p>
        </div>
      </div>

      <div style={s.grid}>
        <span style={s.colHead}>Code</span>
        <span style={s.colHead}>Label</span>
        <span style={s.colHead}>Rank</span>
        <span />

        {bands.map((band, i) => (
          <BandRow
            key={i}
            band={band}
            index={i}
            disabled={disabled}
            duplicate={duplicateCodes.has(band.code.trim().toLowerCase())}
            canRemove={bands.length > 1}
            registerRef={el => { codeRefs.current[i] = el }}
            onKeyDown={e => handleCodeKeyDown(e, i)}
            onUpdate={patch => update(i, patch)}
            onRemove={() => removeBand(i)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => appendBand(bands.length - 1)}
        disabled={disabled}
        style={s.addBtn}
      >
        + Add band
      </button>

      {duplicateCodes.size > 0 && (
        <p style={s.error}>Band codes must be unique.</p>
      )}
    </div>
  )
}

interface RowProps {
  band: BandDraft
  index: number
  disabled?: boolean
  duplicate: boolean
  canRemove: boolean
  registerRef: (el: HTMLInputElement | null) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onUpdate: (patch: Partial<BandDraft>) => void
  onRemove: () => void
}

function BandRow({
  band, disabled, duplicate, canRemove, registerRef, onKeyDown, onUpdate, onRemove,
}: RowProps) {
  return (
    <>
      <input
        ref={registerRef}
        type="text"
        value={band.code}
        onChange={e => onUpdate({ code: e.target.value })}
        onKeyDown={onKeyDown}
        placeholder="A1"
        disabled={disabled}
        style={{ ...s.input, borderColor: duplicate ? '#FCA5A5' : '#D1D5DB' }}
      />
      <input
        type="text"
        value={band.label}
        onChange={e => onUpdate({ label: e.target.value })}
        placeholder="Junior (defaults to the code)"
        disabled={disabled}
        style={s.input}
      />
      <input
        type="number"
        value={band.rank}
        onChange={e => onUpdate({ rank: Number(e.target.value) })}
        min={0}
        disabled={disabled}
        style={{ ...s.input, width: 70 }}
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled || !canRemove}
        style={{ ...s.removeBtn, opacity: canRemove ? 1 : 0.3 }}
        title={canRemove ? 'Remove band' : 'At least one band is required'}
      >
        ✕
      </button>
    </>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: { border: '1px solid #E5E7EB', borderRadius: 10, padding: 16, marginBottom: 16 },
  headerRow: { marginBottom: 12 },
  title: { fontSize: 13, fontWeight: 600, color: '#111827' },
  hint: { fontSize: 11, color: '#6B7280', margin: '4px 0 0', lineHeight: 1.6 },
  code: { background: '#F3F4F6', padding: '1px 5px', borderRadius: 3, fontSize: 10 },
  kbd: { background: '#F3F4F6', border: '1px solid #D1D5DB', borderBottomWidth: 2, padding: '1px 5px', borderRadius: 3, fontSize: 10 },
  grid: { display: 'grid', gridTemplateColumns: '1fr 2fr 70px 28px', gap: 8, alignItems: 'center' },
  colHead: { fontSize: 10, fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.5px' },
  input: { height: 34, padding: '0 9px', fontSize: 13, color: '#111827', background: '#fff', border: '1px solid #D1D5DB', borderRadius: 6, outline: 'none', minWidth: 0 },
  removeBtn: { height: 28, width: 28, background: 'transparent', border: 'none', color: '#9CA3AF', cursor: 'pointer', fontSize: 12 },
  addBtn: { marginTop: 12, height: 30, padding: '0 12px', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 500, border: '1px solid #D1D5DB', borderRadius: 6, cursor: 'pointer' },
  error: { fontSize: 11, color: '#DC2626', margin: '8px 0 0' },
}
