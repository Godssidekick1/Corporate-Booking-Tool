import { stateForGstCode, gstCodeForState } from './locations'

// ── GSTIN ────────────────────────────────────────────────────────────────────
// An Indian GST identification number carries its own metadata, which the screen
// this replaces never used:
//
//   22AAAAA0000A1Z5
//   ││└──── 3-12: PAN ────┘│││
//   ││                     ││└─ 15: checksum
//   ││                     │└── 14: 'Z' by convention
//   ││                     └─── 13: entity serial for this PAN in this state
//   └┴─ 1-2: state code
//
// Two things follow, and both are worth having:
//
//   1. The state code and a separately-entered state can CONTRADICT each other,
//      and the GSTIN says which is which. Typing a Maharashtra GSTIN against a
//      Delhi address is a data-entry slip that otherwise reaches an invoice.
//
//   2. PAN is characters 3-12, so storing PAN as its own column would be a
//      second copy of the same fact that can drift out of step. It is derived
//      here for display instead.
//
// NOTHING HERE BLOCKS A SAVE. Same call as client GST numbers in
// api/tmc/clients/[id]: this is the TMC recording its own certificate, and
// refusing an unusual-but-real identifier is worse than storing one that needs
// correcting. Every function returns a finding for the UI to show, never a
// rejection.
// ─────────────────────────────────────────────────────────────────────────────

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}[A-Z]{1}[0-9A-Z]{1}$/

export interface GstinReading {
  // Structurally a GSTIN. False for a half-typed value, which is the normal
  // state of the field while somebody is using it.
  wellFormed: boolean
  stateCode: string | null
  // The state the GSTIN itself claims, by its first two digits.
  impliedState: string | null
  pan: string | null
  checksumValid: boolean | null
}

export function readGstin(raw: string | null | undefined): GstinReading {
  const value = (raw ?? '').trim().toUpperCase()

  if (!GSTIN_SHAPE.test(value)) {
    return { wellFormed: false, stateCode: null, impliedState: null, pan: null, checksumValid: null }
  }

  const stateCode = value.slice(0, 2)

  return {
    wellFormed: true,
    stateCode,
    impliedState: stateForGstCode(stateCode),
    pan: value.slice(2, 12),
    checksumValid: verifyChecksum(value),
  }
}

// ── verifyChecksum ───────────────────────────────────────────────────────────
// The standard GSTIN check digit. Each of the first 14 characters is converted
// to its value in the 36-character alphabet (0-9 then A-Z), multiplied by an
// alternating 1/2 weight, and the products' digits summed in base 36.
//
// Implemented rather than skipped because it catches the failure a shape regex
// cannot: a transposed pair of characters still matches the pattern.
// ─────────────────────────────────────────────────────────────────────────────
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function verifyChecksum(gstin: string): boolean {
  let total = 0

  for (let i = 0; i < 14; i++) {
    const value = ALPHABET.indexOf(gstin[i])
    if (value < 0) return false

    // Weights alternate 1,2,1,2… across the 14 characters.
    const product = value * (i % 2 === 0 ? 1 : 2)
    // Sum the product's digits IN BASE 36, not base 10 — the usual place this
    // is got wrong.
    total += Math.floor(product / 36) + (product % 36)
  }

  const expected = ALPHABET[(36 - (total % 36)) % 36]
  return expected === gstin[14]
}

// ── gstinFinding ─────────────────────────────────────────────────────────────
// The single sentence the form shows under the GST number, or null when there
// is nothing worth saying. Ordered by how much it matters: a state that
// disagrees is a wrong invoice, a bad checksum is a typo, a malformed value is
// probably just half-typed.
// ─────────────────────────────────────────────────────────────────────────────
export function gstinFinding(raw: string | null | undefined, state: string | null | undefined): string | null {
  const value = (raw ?? '').trim()
  if (!value) return null

  const reading = readGstin(value)

  if (!reading.wellFormed) {
    return value.length >= 15
      ? 'This does not look like a 15-character GSTIN.'
      : null // Still being typed — saying anything yet would just nag.
  }

  if (state && reading.impliedState && reading.impliedState !== state) {
    return `This GSTIN starts ${reading.stateCode}, which is ${reading.impliedState} — but the state is set to ${state}. One of the two is wrong.`
  }

  if (state && !reading.impliedState) {
    return `${reading.stateCode} is not a state code we recognise.`
  }

  if (reading.checksumValid === false) {
    return 'The check digit does not match — this GSTIN has a typo in it somewhere.'
  }

  return null
}

// Convenience for the reverse direction: what a chosen state implies the GSTIN
// should start with, used to explain a mismatch from the other side.
export function expectedGstPrefix(state: string | null | undefined): string | null {
  return state ? gstCodeForState(state) : null
}
