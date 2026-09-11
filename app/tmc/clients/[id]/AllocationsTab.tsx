'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import ChipList, { type ChipItem } from '@/app/components/ChipList'
import Toggle from './Toggle'
import { useLookup } from '@/app/hooks/useLookup'
import {
  DEFAULT_PAYMENT_PRIORITY, PAYMENT_TYPES, PAYMENT_TYPE_EFFECTS, PAYMENT_TYPE_LABELS,
  normalisePriority, type PaymentType,
} from '@/app/lib/fop/paymentTypes'
import { Field, s, type Client, type SetField } from './shared'

// ── Allocations ──────────────────────────────────────────────────────────────
// The warehouse. What this client has been given, and who pays.
//
// Everything here can also be done from the master it belongs to — a deal code
// can be pointed at a client from the deal, a client can be dropped into a
// bucket from the bucket. This is the other direction, which is the faster one
// when you are configuring a corporate rather than rolling out a deal.
//
// INHERITED ROWS ARE REAL. A deal code can reach this client directly, through
// a bucket they are in, or through their client group. Showing only the direct
// ones would make this screen lie about what applies at booking time. So all
// three are listed, each labelled with where it came from — and removing an
// inherited one says, before it happens, that it is editing a bucket other
// clients are in too.
// ─────────────────────────────────────────────────────────────────────────────

interface Bucket { id: string; name: string; code: string | null }

interface Allocation {
  assignmentId: string
  id: string
  code: string
  label: string
  source: 'client' | 'bucket' | 'client_group'
  sourceId: string | null
  sourceName: string | null
  isActive?: boolean
}

interface CardRow {
  id: string; label: string; card_type: string | null; last4: string | null; description: string
}

const CARD_TYPES = [
  { value: 'VI', label: 'Visa' },
  { value: 'CA', label: 'Mastercard' },
  { value: 'AX', label: 'American Express' },
  { value: 'DC', label: 'Diners Club' },
]

const EMPTY_CARD = { label: '', card_type: 'VI', last4: '', expiry_month: '', expiry_year: '', gds_alias: '' }

export default function AllocationsTab({ clientId, form, set }: {
  clientId: string
  form: Partial<Client>
  set: SetField
}) {
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [deals, setDeals] = useState<Allocation[]>([])
  const [fops, setFops] = useState<Allocation[]>([])
  const [bucketSizes, setBucketSizes] = useState<Record<string, number>>({})
  const [cards, setCards] = useState<CardRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [addBucketId, setAddBucketId] = useState('')
  const [addDealId, setAddDealId] = useState('')
  const [addFopId, setAddFopId] = useState('')
  const [card, setCard] = useState(EMPTY_CARD)
  const [cardOpen, setCardOpen] = useState(false)

  const bucketLookup = useLookup('/api/tmc/buckets', addBucketId)
  const dealLookup = useLookup('/api/tmc/deal-codes', addDealId, {
    toOption: row => ({
      id: String(row.id),
      label: String(row.code),
      sublabel: [row.airline_code, row.code_type].filter(Boolean).join(' · ') || undefined,
    }),
  })
  const fopLookup = useLookup('/api/tmc/forms-of-payment', addFopId, {
    toOption: row => ({
      id: String(row.id),
      label: String(row.label),
      sublabel: [row.fop_code, row.payer].filter(Boolean).join(' · ') || undefined,
    }),
  })

  const loadAllocations = useCallback(() => {
    fetch(`/api/tmc/clients/${clientId}/allocations`)
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { setError(d.error || 'Could not load allocations.'); return }
        setDeals(d.dealCodes)
        setFops(d.formsOfPayment)
        setBucketSizes(d.bucketSizes ?? {})
      })
      .catch(() => setError('Could not load allocations.'))
  }, [clientId])

  const loadBuckets = useCallback(() => {
    fetch(`/api/tmc/clients/${clientId}/buckets`)
      .then(r => r.json())
      .then(d => { if (d.ok) setBuckets(d.buckets) })
      .catch(() => {})
  }, [clientId])

  const loadCards = useCallback(() => {
    fetch(`/api/tmc/forms-of-payment?payer=corporate&ownerClientId=${clientId}`)
      .then(r => r.json())
      .then(d => { if (d.ok) setCards(d.items ?? []) })
      .catch(() => {})
  }, [clientId])

  useEffect(() => { loadBuckets(); loadAllocations(); loadCards() }, [loadBuckets, loadAllocations, loadCards])

  // ── Buckets ────────────────────────────────────────────────────────────────
  // The whole list goes up, not a delta. Two screens doing read-modify-write on
  // the same membership will drop an edit made between one screen's read and its
  // write; sending the intended end state has no such window.
  async function saveBuckets(next: Bucket[]) {
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/tmc/clients/${clientId}/buckets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucketIds: next.map(b => b.id) }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d.error || 'Could not save buckets.'); return }
      setBuckets(d.buckets)
      // Membership changes what reaches this client through a bucket, so the
      // effective lists below are now stale.
      loadAllocations()
    } finally { setBusy(false) }
  }

  function addBucket() {
    const picked = bucketLookup.options.find(o => o.id === addBucketId)
    if (!picked || buckets.some(b => b.id === picked.id)) { setAddBucketId(''); return }
    saveBuckets([...buckets, { id: picked.id, name: picked.label, code: null }])
    setAddBucketId('')
  }

  // ── Deal codes and forms of payment ────────────────────────────────────────
  async function attach(kind: 'deal' | 'fop', targetId: string) {
    if (!targetId) return
    setBusy(true); setError('')
    try {
      const url = kind === 'deal' ? '/api/tmc/deal-code-assignments' : '/api/tmc/fop-assignments'
      const body = kind === 'deal'
        ? { dealCodeId: targetId, targets: [{ kind: 'client', id: clientId }] }
        : { fopId: targetId, targets: [{ kind: 'client', id: clientId }] }

      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json()
      if (!res.ok) { setError(d.error || 'Could not attach that.'); return }
      if (kind === 'deal') setAddDealId(''); else setAddFopId('')
      loadAllocations()
    } finally { setBusy(false) }
  }

  async function detach(kind: 'deal' | 'fop', row: Allocation) {
    setBusy(true); setError('')
    try {
      if (row.source === 'client') {
        const base = kind === 'deal' ? '/api/tmc/deal-code-assignments' : '/api/tmc/fop-assignments'
        await fetch(`${base}?id=${row.assignmentId}`, { method: 'DELETE' })
        loadAllocations()
        return
      }

      // Inherited through a bucket: the only way to stop it reaching this client
      // from here is to take the client out of that bucket. ChipList has already
      // shown the confirm naming the bucket and its other members.
      if (row.source === 'bucket' && row.sourceId) {
        await saveBuckets(buckets.filter(b => b.id !== row.sourceId))
        return
      }

      // Client group membership is identity, not allocation — changing it here
      // would move the client to a different group to drop one deal code.
      setError(
        'This one reaches the client through their client group. Change it on the deal itself, ' +
        'or move the client to a different group on the Identity tab.'
      )
    } finally { setBusy(false) }
  }

  function toChips(kind: 'deal' | 'fop', rows: Allocation[]): ChipItem[] {
    return rows.map(row => {
      const others = row.source === 'bucket' && row.sourceId ? (bucketSizes[row.sourceId] ?? 1) - 1 : 0
      return {
        id: row.assignmentId,
        label: row.code,
        note: row.source === 'client'
          ? row.label
          : `${row.label} · via ${row.source === 'bucket' ? 'bucket' : 'group'} ${row.sourceName ?? '—'}`,
        readOnly: row.source === 'client_group',
        confirm: row.source === 'bucket'
          ? `${row.code} reaches this client through the bucket "${row.sourceName}".\n\n` +
            `Removing it here takes this client OUT of that bucket, which also removes everything ` +
            `else the bucket hands them.` +
            (others > 0
              ? `\n\nThe bucket itself is not deleted — the ${others} other client${others > 1 ? 's' : ''} in it are unaffected.`
              : '\n\nNo other client is in that bucket.')
          : undefined,
      }
    })
  }

  // ── Corporate cards ────────────────────────────────────────────────────────
  async function addCard() {
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/tmc/forms-of-payment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: card.label,
          fop_type: 'card',
          payer: 'corporate',
          owner_client_id: clientId,
          card_type: card.card_type,
          last4: card.last4,
          expiry_month: card.expiry_month ? Number(card.expiry_month) : null,
          expiry_year: card.expiry_year ? Number(card.expiry_year) : null,
          gds_alias: card.gds_alias || null,
        }),
      })
      const d = await res.json()
      if (!res.ok) { setError(d.error || 'Could not add that card.'); return }
      setCard(EMPTY_CARD); setCardOpen(false)
      loadCards()
    } finally { setBusy(false) }
  }

  // ── Payment types and priority ─────────────────────────────────────────────
  const priority = normalisePriority(form.fop_priority ?? DEFAULT_PAYMENT_PRIORITY)

  const enabled: Record<PaymentType, boolean> = {
    agency: form.agency_fop_allowed !== false,
    corporate: form.corporate_fop_allowed !== false,
    bta_cta: form.bta_cta_allowed !== false,
    bta_cta_manual: form.bta_cta_manual_allowed === true,
  }

  const FLAG_FIELD: Record<PaymentType, keyof Client> = {
    agency: 'agency_fop_allowed',
    corporate: 'corporate_fop_allowed',
    bta_cta: 'bta_cta_allowed',
    bta_cta_manual: 'bta_cta_manual_allowed',
  }

  function move(type: PaymentType, direction: -1 | 1) {
    const index = priority.indexOf(type)
    const target = index + direction
    if (index < 0 || target < 0 || target >= priority.length) return
    const next = [...priority]
    ;[next[index], next[target]] = [next[target], next[index]]
    set('fop_priority', next)
  }

  // The ordering in one sentence, so nobody has to read a list of arrows and
  // work out what it means at the counter.
  const live = priority.filter(t => enabled[t])
  const outcome = live.length === 0
    ? 'No payment type is switched on — nothing can settle a booking for this client.'
    : live.length === 1
      ? `Only ${PAYMENT_TYPE_LABELS[live[0]]} applies.`
      : `${PAYMENT_TYPE_LABELS[live[0]]} first; if none applies, ` +
        live.slice(1).map(t => PAYMENT_TYPE_LABELS[t]).join(', then ') + '.'

  return (
    <>
      {error && <div style={s.errorBanner}>{error}</div>}

      {/* ── Buckets ──────────────────────────────────────────────────────── */}
      <p style={{ ...s.subLabel, marginTop: 0 }}>Buckets</p>
      <p style={s.blockDesc}>
        Curated sets of clients. Anything pointed at a bucket reaches every client in it — which is
        how deal codes and forms of payment are handed out in bulk. A client can be in as many as
        you like.
      </p>
      <ChipList
        items={buckets.map(b => ({ id: b.id, label: b.name, note: b.code ?? undefined }))}
        onRemove={id => saveBuckets(buckets.filter(b => b.id !== id))}
        addValue={addBucketId}
        onAddChange={setAddBucketId}
        onAdd={addBucket}
        options={bucketLookup.options.filter(o => !buckets.some(b => b.id === o.id))}
        onSearch={bucketLookup.onSearch}
        loading={bucketLookup.loading}
        selectedLabel={bucketLookup.selectedLabel}
        placeholder="Search buckets to add…"
        emptyMessage="No buckets match"
        emptyHint="Not in any bucket. Only directly-assigned deal codes and payment methods reach this client."
        disabled={busy}
      />

      {/* ── Deal codes ───────────────────────────────────────────────────── */}
      <p style={s.subLabel}>Deal codes</p>
      <p style={s.blockDesc}>
        Everything reaching this client, however it gets here. Rows marked <em>via</em> come from a
        bucket or the client&rsquo;s group rather than from this client directly.
      </p>
      <ChipList
        items={toChips('deal', deals)}
        onRemove={id => {
          const row = deals.find(d => d.assignmentId === id)
          if (row) detach('deal', row)
        }}
        addValue={addDealId}
        onAddChange={setAddDealId}
        onAdd={() => attach('deal', addDealId)}
        options={dealLookup.options}
        onSearch={dealLookup.onSearch}
        loading={dealLookup.loading}
        selectedLabel={dealLookup.selectedLabel}
        placeholder="Search deal codes to attach…"
        emptyMessage="No deal codes match"
        emptyHint="No deal code reaches this client. Their bookings will use published fares."
        disabled={busy}
      />

      {/* ── Forms of payment ─────────────────────────────────────────────── */}
      <p style={s.subLabel}>Forms of payment</p>
      <p style={s.blockDesc}>
        Which payment methods are available to this client. Whichever wins is decided by the
        priority below, then by how specifically it was assigned.
      </p>
      <ChipList
        items={toChips('fop', fops)}
        onRemove={id => {
          const row = fops.find(f => f.assignmentId === id)
          if (row) detach('fop', row)
        }}
        addValue={addFopId}
        onAddChange={setAddFopId}
        onAdd={() => attach('fop', addFopId)}
        options={fopLookup.options}
        onSearch={fopLookup.onSearch}
        loading={fopLookup.loading}
        selectedLabel={fopLookup.selectedLabel}
        placeholder="Search forms of payment to attach…"
        emptyMessage="No forms of payment match"
        emptyHint="Nothing assigned. Bookings fall back to whichever method is marked default for your TMC."
        disabled={busy}
      />

      {/* ── Corporate cards ──────────────────────────────────────────────── */}
      <p style={s.subLabel}>Corporate cards</p>
      <p style={s.blockDesc}>
        Cards this client owns. Only the type, last four digits and expiry are ever stored —
        never a full card number, here or anywhere else.
      </p>
      {cards.length === 0 ? (
        <p style={s.hint}>None recorded.</p>
      ) : (
        <ul style={s.linkList}>
          {cards.map(c => (
            <li key={c.id} style={s.linkItem}>
              <span style={s.linkName}>{c.label}</span>
              <span style={s.muted}>{c.description}</span>
              <Link href="/tmc/configurations/forms-of-payment" style={{ ...s.inlineLink, marginLeft: 'auto', fontSize: 11.5 }}>
                Edit →
              </Link>
            </li>
          ))}
        </ul>
      )}

      {!cardOpen ? (
        <div style={s.actions}>
          <button onClick={() => setCardOpen(true)} style={s.primaryBtn}>Add a card</button>
        </div>
      ) : (
        <>
          <div style={{ ...s.grid, marginTop: 12 }}>
            <Field label="Alias" hint="What a counsellor will recognise it by.">
              <input value={card.label} onChange={e => setCard({ ...card, label: e.target.value })} style={s.input} />
            </Field>
            <Field label="Card type">
              <select value={card.card_type} onChange={e => setCard({ ...card, card_type: e.target.value })} style={s.input}>
                {CARD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="Last 4 digits" hint="The full number is never stored.">
              <input
                value={card.last4} maxLength={4}
                onChange={e => setCard({ ...card, last4: e.target.value.replace(/\D/g, '') })}
                style={{ ...s.input, ...s.mono }}
              />
            </Field>
            <Field label="Expiry month">
              <input
                value={card.expiry_month} maxLength={2} placeholder="09"
                onChange={e => setCard({ ...card, expiry_month: e.target.value.replace(/\D/g, '') })}
                style={{ ...s.input, ...s.mono }}
              />
            </Field>
            <Field label="Expiry year">
              <input
                value={card.expiry_year} maxLength={4} placeholder="2029"
                onChange={e => setCard({ ...card, expiry_year: e.target.value.replace(/\D/g, '') })}
                style={{ ...s.input, ...s.mono }}
              />
            </Field>
            <Field label="GDS alias" hint="The alias this card is lodged under, if it is.">
              <input value={card.gds_alias} onChange={e => setCard({ ...card, gds_alias: e.target.value })} style={{ ...s.input, ...s.mono }} />
            </Field>
          </div>
          <div style={s.actions}>
            <button onClick={addCard} disabled={busy || !card.label} style={{ ...s.primaryBtn, opacity: busy || !card.label ? 0.5 : 1 }}>
              {busy ? 'Adding…' : 'Add card'}
            </button>
            <button onClick={() => { setCardOpen(false); setCard(EMPTY_CARD) }} style={s.smallBtn}>Cancel</button>
          </div>
        </>
      )}

      {/* ── Payment types and priority ───────────────────────────────────── */}
      <p style={s.subLabel}>Payment types</p>
      <p style={s.blockDesc}>
        Who may pay for this client&rsquo;s bookings. BTA/CTA here means the traveller&rsquo;s own
        card — stored against them in this system, or typed by them at the gateway.
      </p>
      <div style={s.toggles}>
        {PAYMENT_TYPES.map(type => (
          <Toggle
            key={type}
            label={PAYMENT_TYPE_LABELS[type]}
            checked={enabled[type]}
            onChange={v => set(FLAG_FIELD[type] as 'agency_fop_allowed', v)}
            effect={PAYMENT_TYPE_EFFECTS[type]}
            reserved={type === 'bta_cta_manual'}
          />
        ))}
      </div>

      <p style={s.subLabel}>Priority</p>
      <p style={s.blockDesc}>
        When more than one payment type could settle a booking, the highest one here wins. The
        order covers all four, including the ones switched off, so turning one back on puts it
        straight back where you left it.
      </p>
      <ol style={s.linkList}>
        {priority.map((type, i) => (
          <li key={type} style={{ ...s.linkItem, opacity: enabled[type] ? 1 : 0.5 }}>
            <span style={s.countBadge}>{i + 1}</span>
            <span style={s.linkName}>{PAYMENT_TYPE_LABELS[type]}</span>
            {!enabled[type] && <span style={s.pill}>off</span>}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button onClick={() => move(type, -1)} disabled={i === 0} style={{ ...s.smallBtn, opacity: i === 0 ? 0.4 : 1 }} title="Move up">↑</button>
              <button onClick={() => move(type, 1)} disabled={i === priority.length - 1} style={{ ...s.smallBtn, opacity: i === priority.length - 1 ? 0.4 : 1 }} title="Move down">↓</button>
            </span>
          </li>
        ))}
      </ol>
      <p style={s.hint}><strong>Right now:</strong> {outcome}</p>
      {enabled.bta_cta_manual && (
        <p style={s.warnNote}>
          BTA/CTA manual is switched on, but there is no payment gateway in this product yet. The
          setting is stored and the resolver honours it — a booking that falls through to it will
          simply resolve to no stored payment method until that flow is built.
        </p>
      )}
    </>
  )
}
