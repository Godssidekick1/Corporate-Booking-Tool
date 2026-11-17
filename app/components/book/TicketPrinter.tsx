'use client'

import css from './TicketPrinter.module.css'

// ── The ticketing loader ─────────────────────────────────────────────────────
// While the airline issues the ticket: a printer feeding out a boarding pass
// (route, a plane, a tear line and a barcode), torn away, then the next.
// Our own drawing, inline SVG and CSS: nothing fetched. With reduced motion,
// a pass rests half out of the printer.
// ─────────────────────────────────────────────────────────────────────────────

// A barcode: bar widths in units, fixed so it never flickers between renders.
const WIDTHS = [2, 1, 1, 3, 1, 2, 1, 1, 2, 3, 1, 1, 2, 1, 3, 1, 2, 2, 1, 1, 3, 1, 2, 1, 1, 2]
// Laid out once: each bar starts where the one before it ended, plus a gap.
const BARS = WIDTHS.reduce<{ x: number; w: number; dark: boolean }[]>((list, w, i) => {
  const prev = list[list.length - 1]
  return [...list, { x: prev ? prev.x + prev.w + 1.1 : 76, w: w * 1.3, dark: i % 2 === 0 }]
}, [])

export default function TicketPrinter({ label, note }: { label: string; note?: string }) {
  const bars = BARS
  return (
    <div className={css.wrap} role="status" aria-live="polite">
      <svg className={css.scene} viewBox="0 0 240 210" aria-hidden="true" focusable="false">
        <defs>
          {/* Paper is seen only below the slot: it comes out of the printer. */}
          <clipPath id="ticket-printer-out"><rect x="0" y="66" width="240" height="150" /></clipPath>
        </defs>

        <ellipse className={css.shadow} cx="120" cy="72" rx="98" ry="6" />

        {/* The pass. */}
        <g clipPath="url(#ticket-printer-out)">
          <g className={css.paper}>
            <rect className={css.sheet} x="64" y="66" width="112" height="128" rx="6" />
            <rect className={css.band} x="64.5" y="66.5" width="111" height="26" />
            {/* A little plane in the band. */}
            <path className={css.plane} d="M79 79.5l12-1.6 5-6 2.4.4-2.6 5.2 5.6-.8 1.8-2.4 1.6.2-1 3.1 1 3.1-1.6.2-1.8-2.4-5.6-.8 2.6 5.2-2.4.4-5-6z" />
            {/* "DEL → BLR" as printed blocks. */}
            <rect className={css.inkDark} x="111" y="75" width="16" height="6" rx="1.5" />
            <rect className={css.ink} x="130" y="77" width="8" height="2" rx="1" />
            <rect className={css.inkDark} x="141" y="75" width="16" height="6" rx="1.5" />
            {/* Name, flight, seat, gate. */}
            <rect className={css.inkDark} x="74" y="100" width="58" height="5" rx="1.5" />
            <rect className={css.ink} x="74" y="110" width="40" height="4" rx="1.5" />
            <rect className={css.ink} x="122" y="110" width="24" height="4" rx="1.5" />
            <rect className={css.ink} x="74" y="119" width="30" height="4" rx="1.5" />
            <rect className={css.inkDark} x="146" y="98" width="20" height="15" rx="3" />
            {/* The tear line, notched at both edges. */}
            <line className={css.tear} x1="68" y1="135" x2="172" y2="135" />
            <circle className={css.notch} cx="64" cy="135" r="4" />
            <circle className={css.notch} cx="176" cy="135" r="4" />
            {/* The stub: a barcode. */}
            {bars.map((b, i) => (
              <rect key={i} className={css.bar} x={b.x} y="146" width={b.w} height="30" opacity={b.dark ? 1 : 0.75} />
            ))}
            <rect className={css.ink} x="96" y="181" width="48" height="3" rx="1.5" />
          </g>
        </g>

        {/* The printer, drawn over the paper's top edge. */}
        <rect className={css.body} x="26" y="10" width="188" height="60" rx="14" />
        <rect className={css.top} x="26" y="10" width="188" height="20" rx="14" />
        <rect className={css.top} x="26" y="20" width="188" height="10" />
        <line className={css.vent} x1="44" y1="40" x2="70" y2="40" />
        <line className={css.vent} x1="44" y1="47" x2="62" y2="47" />
        <circle className={css.led} cx="194" cy="42" r="4" />
        <rect className={css.slot} x="56" y="60" width="128" height="7" rx="3.5" />
        <rect className={css.head} x="60" y="61.5" width="120" height="3" rx="1.5" />
      </svg>
      <p className={css.label}>{label}</p>
      {note && <p className={css.note}>{note}</p>}
    </div>
  )
}
