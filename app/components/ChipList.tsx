'use client'

import SearchableSelect from '@/app/components/SearchableSelect'

// ── ChipList ─────────────────────────────────────────────────────────────────
// A set of things, shown as chips, with a search box to add another.
//
// This shape had been hand-rolled six times — buckets, deal codes, forms of
// payment, branches, cost centres, the traveller profile — with the same markup
// and slightly different styles each time, which is how the remove button ends
// up in a different place depending on which screen you are on.
//
// Chips can be removable, read-only, or removable-with-a-warning: a chip that
// came from somewhere else (a bucket a deal code reaches through, say) can be
// taken away here, but doing so edits that other thing, and `confirm` on the
// item says so before it happens.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChipItem {
  id: string
  label: string
  // Rendered muted after the label — "via bucket Retail-2026", a card's last4,
  // whatever says where this one came from.
  note?: string
  // Shown before removing. Returning false from the dialog cancels. Omit for
  // the ordinary case where removing is unremarkable.
  confirm?: string
  // No × at all. For things that are genuinely edited elsewhere.
  readOnly?: boolean
}

interface ChipListProps {
  items: ChipItem[]
  onRemove?: (id: string) => void
  // Omit the whole add row by leaving these out — a read-only list still wants
  // the chip rendering.
  addValue?: string
  onAddChange?: (id: string) => void
  onAdd?: () => void
  options?: { id: string; label: string; sublabel?: string }[]
  onSearch?: (q: string) => void
  loading?: boolean
  selectedLabel?: string
  placeholder?: string
  emptyMessage?: string
  // Shown instead of the chip row when there is nothing in the list. Says what
  // the emptiness means, not just that it is empty.
  emptyHint?: string
  disabled?: boolean
}

export default function ChipList({
  items, onRemove,
  addValue, onAddChange, onAdd, options, onSearch, loading, selectedLabel,
  placeholder = 'Search…', emptyMessage = 'No matches',
  emptyHint, disabled = false,
}: ChipListProps) {
  function remove(item: ChipItem) {
    if (!onRemove) return
    if (item.confirm && !window.confirm(item.confirm)) return
    onRemove(item.id)
  }

  const showAdd = onAdd !== undefined && options !== undefined

  return (
    <>
      {items.length === 0 ? (
        emptyHint ? <p style={s.hint}>{emptyHint}</p> : null
      ) : (
        <div style={s.chipRow}>
          {items.map(item => (
            <span key={item.id} style={item.readOnly ? s.readonlyChip : s.chip}>
              {item.label}
              {item.note && <span style={s.note}>{item.note}</span>}
              {!item.readOnly && onRemove && (
                <button
                  onClick={() => remove(item)}
                  disabled={disabled}
                  style={s.chipX}
                  title={`Remove ${item.label}`}
                >×</button>
              )}
            </span>
          ))}
        </div>
      )}

      {showAdd && (
        <div style={s.addRow}>
          <div style={{ flex: 1, maxWidth: 380 }}>
            <SearchableSelect
              value={addValue ?? ''}
              onChange={onAddChange ?? (() => {})}
              options={options ?? []}
              onSearch={onSearch}
              loading={loading}
              selectedLabel={selectedLabel}
              placeholder={placeholder}
              emptyMessage={emptyMessage}
              disabled={disabled}
            />
          </div>
          <button
            onClick={onAdd}
            disabled={disabled || !addValue}
            style={{ ...s.addBtn, opacity: disabled || !addValue ? 0.5 : 1 }}
          >Add</button>
        </div>
      )}
    </>
  )
}

const s: Record<string, React.CSSProperties> = {
  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 7, background: '#fff', border: '1px solid #D1D5DB', borderRadius: 6, padding: '4px 9px', fontSize: 12, color: '#374151' },
  readonlyChip: { display: 'inline-flex', alignItems: 'center', gap: 7, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 6, padding: '4px 9px', fontSize: 12, color: '#374151' },
  note: { color: '#9CA3AF' },
  chipX: { background: 'none', border: 'none', color: '#9CA3AF', fontSize: 15, lineHeight: 1, cursor: 'pointer', padding: 0 },

  addRow: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 },
  addBtn: { height: 36, padding: '0 16px', fontSize: 13, fontWeight: 600, color: '#fff', background: '#000835', border: 'none', borderRadius: 7, cursor: 'pointer' },

  hint: { fontSize: 12, color: '#9CA3AF', lineHeight: 1.55, margin: 0 },
}
