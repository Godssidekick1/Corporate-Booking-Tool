// ── How a policy outcome reads ───────────────────────────────────────────────
// One wording for the three outcomes wherever they are shown: the fare,
// passenger and confirm pages, the approvals queue and the rule-engine test.
// Stored by their old colour names (green / amber / red); never shown as a
// colour word, since what they mean is what someone configured:
//   green  Within policy   every cap and rule met
//   amber  Needs approval  within a fare cap's grace: always goes for approval
//   red    Out of policy   beyond grace, or a rule broken
// ─────────────────────────────────────────────────────────────────────────────

export interface VerdictMeta { label: string; color: string; bg: string; border: string }

export const VERDICT_META: Record<string, VerdictMeta> = {
  green: { label: 'Within policy',  color: '#166534', bg: '#F0FDF4', border: '#BBF7D0' },
  amber: { label: 'Needs approval', color: '#92400E', bg: '#FFFBEB', border: '#FDE68A' },
  red:   { label: 'Out of policy',  color: '#991B1B', bg: '#FEF2F2', border: '#FECACA' },
}

// Which bookings an approval chain step acts on, by its min_verdict. Anything
// sent for approval reaches at least the chain's first step (stepsFor in
// app/lib/approval-engine/resolveApprovalTier.ts), so these say what a LATER
// step adds.
export const STEP_CONDITIONS: { value: string; label: string }[] = [
  { value: 'green', label: 'Every booking sent for approval' },
  { value: 'amber', label: 'Needs approval or out of policy' },
  { value: 'red',   label: 'Out of policy only' },
]

export const STEP_CONDITION_LABEL: Record<string, string> =
  Object.fromEntries(STEP_CONDITIONS.map(c => [c.value, c.label]))
