import Image from 'next/image'

// ── AirlineMark ──────────────────────────────────────────────────────────────
// The airline's logo wherever an airline is named: results, fare, booking and
// ticket pages, and the desk's booking pages. Every airline shows something:
// a carrier we have no logo for gets a tile with its IATA code, tinted by a
// colour derived from the code, so the same airline always looks the same.
//
// The logos are square icons in public/airlines/<code>.png (128 px), fetched
// on 2026-11-10 from Kiwi.com's public airline image service
// (images.kiwi.com/airlines/128/<code>.png) for the carriers flown in India
// and the common international ones. Only codes listed here are requested, so
// an unknown carrier never costs a 404. To add one: drop <code>.png in that
// folder and add the code below. Check the image first: a code can be reused
// by a new airline (IC was Indian Airlines; Fly91 flies under it now), and the
// service still shows the old one.
// ─────────────────────────────────────────────────────────────────────────────

const WITH_LOGO: ReadonlySet<string> = new Set([
  // India
  'AI', '6E', 'QP', 'IX', 'SG', '9I', 'S5',
  // Gulf and Asia
  'EK', 'QR', 'EY', 'SV', 'GF', 'WY', 'FZ', 'G9', 'KU', 'SQ', 'CX', 'TG', 'MH', 'OD', 'UL', 'BG',
  'VN', 'JL', 'NH', 'KE', 'MU', 'CA', 'QF',
  // Europe, Africa and the Americas
  'LH', 'BA', 'VS', 'AF', 'KL', 'TK', 'LX', 'OS', 'ET', 'KQ', 'UA', 'AA', 'DL', 'AC',
])

export function hasAirlineLogo(code: string | undefined | null): boolean {
  return !!code && WITH_LOGO.has(code.toUpperCase())
}

// A stable hue per code, for the tile of an airline without a logo.
function hueOf(code: string): number {
  let h = 7
  for (const c of code) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

export default function AirlineMark({ code, name, size = 34 }: { code?: string | null; name?: string | null; size?: number }) {
  const upper = (code ?? '').toUpperCase()
  const radius = Math.round(size * 0.26)
  const label = name ? `${name} logo` : upper ? `${upper} logo` : 'Airline'

  if (hasAirlineLogo(upper)) {
    return (
      <Image
        src={`/airlines/${upper}.png`}
        alt={label}
        width={size}
        height={size}
        // 128 px icons, already small: served as they are.
        unoptimized
        style={{ width: size, height: size, borderRadius: radius, flexShrink: 0, objectFit: 'contain', background: '#fff', border: '1px solid #E5E7EB' }}
      />
    )
  }

  const h = hueOf(upper || '?')
  return (
    <span
      role="img"
      aria-label={label}
      style={{
        width: size, height: size, borderRadius: radius, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: `hsl(${h} 55% 94%)`, color: `hsl(${h} 60% 26%)`, border: `1px solid hsl(${h} 40% 86%)`,
        fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: Math.max(9, Math.round(size * 0.35)), letterSpacing: '-0.3px',
      }}
    >
      {upper || '✈'}
    </span>
  )
}
