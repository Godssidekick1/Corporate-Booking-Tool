import type { CSSProperties, ReactNode } from 'react'

// ── AuthShell ────────────────────────────────────────────────────────────────
// The two-panel frame of the pages a person sees before they are fully signed
// in: /auth/confirm (invite and reset links) and /auth/set-password (replacing
// an admin-set password). One copy of the layout and its styles, not one per
// page.
// ─────────────────────────────────────────────────────────────────────────────

export default function AuthShell({ tagline, children }: { tagline: string; children: ReactNode }) {
  return (
    <div style={authStyles.root}>
      <div style={authStyles.panel}>
        <div>
          <div style={authStyles.wordmark}>
            <span style={authStyles.wmMain}>TravelDesk</span>
            <span style={authStyles.wmBy}>by Amadeus</span>
          </div>
          <p style={authStyles.tagline}>{tagline}</p>
        </div>
        <p style={authStyles.panelFooter}>© {new Date().getFullYear()} Amadeus IT Group</p>
      </div>
      <div style={authStyles.formPanel}>
        <div style={authStyles.card}>{children}</div>
      </div>
    </div>
  )
}

export const authStyles: Record<string, CSSProperties> = {
  root: {
    display: 'flex', minHeight: '100vh',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    background: '#F7F8FC',
  },
  panel: {
    width: '420px', flexShrink: 0, background: '#000835',
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    padding: '48px 40px',
  },
  wordmark: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '24px' },
  wmMain: { fontSize: '28px', fontWeight: 600, color: '#fff', letterSpacing: '-0.5px' },
  wmBy: {
    fontSize: '11px', color: 'rgba(255,255,255,0.38)',
    letterSpacing: '0.6px', textTransform: 'uppercase',
  },
  tagline: {
    fontSize: '15px', lineHeight: '1.65',
    color: 'rgba(255,255,255,0.55)', maxWidth: '260px', margin: 0,
  },
  panelFooter: { fontSize: '11px', color: 'rgba(255,255,255,0.2)', margin: 0 },
  formPanel: {
    flex: 1, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    padding: '40px 24px',
  },
  card: { width: '100%', maxWidth: '400px' },
  heading: {
    fontSize: '24px', fontWeight: 600, color: '#0A0A14',
    margin: '0 0 8px', letterSpacing: '-0.3px',
  },
  sub: { fontSize: '14px', color: '#6B7280', margin: '0 0 32px', lineHeight: '1.6' },
  form: { display: 'flex', flexDirection: 'column', gap: '20px' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: '13px', fontWeight: 500, color: '#374151' },
  input: {
    height: '42px', padding: '0 12px',
    fontSize: '14px', color: '#0A0A14',
    background: '#fff', border: '1px solid #D1D5DB',
    borderRadius: '8px', outline: 'none',
  },
  error: {
    fontSize: '13px', color: '#DC2626',
    background: '#FEF2F2', border: '1px solid #FECACA',
    borderRadius: '6px', padding: '10px 12px', margin: 0,
  },
  button: {
    height: '42px', width: '100%', background: '#000835', color: '#fff',
    fontSize: '14px', fontWeight: 600,
    border: 'none', borderRadius: '8px', marginTop: '4px', cursor: 'pointer',
  },
}
