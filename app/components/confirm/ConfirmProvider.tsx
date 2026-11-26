'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import css from './Confirm.module.css'

// ── Our own confirm box ──────────────────────────────────────────────────────
// Replaces window.confirm(), which the browser draws as "localhost says…" in
// its own look, cannot be styled, and reads like a warning from the browser
// rather than a question from the app (user, 2026-11-25).
//
//   const confirm = useConfirm()
//   if (!(await confirm({ title: 'Delete this trip?', message: '…', tone: 'danger', confirmLabel: 'Delete trip' }))) return
//
// One box, mounted once in app/layout.tsx. Our look, kept simple: a card with
// a ticket's tear line above the buttons, and for money or records, a stub of
// the facts being confirmed (a credit note's number and amount). Danger opens
// with Cancel focused, so Enter never destroys anything by accident; Escape and
// the backdrop cancel; Tab stays inside; focus goes back where it was.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfirmOptions {
  title: string
  // Paragraphs separated by a blank line.
  message?: string
  // Facts shown on the stub ("Amount", "₹4,250").
  details?: { label: string; value: string }[]
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'default'
}

type Ask = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<Ask | null>(null)

export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext)
  // Outside the provider (should not happen: it wraps the whole app), the
  // browser's own box still asks rather than letting the action through.
  return ask ?? (async o => window.confirm([o.title, o.message].filter(Boolean).join('\n\n')))
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null)

  const ask = useCallback<Ask>(options => new Promise<boolean>(resolve => {
    // A second question while one is open: the first is answered "no".
    setPending(prev => { prev?.resolve(false); return { options, resolve } })
  }), [])

  const answer = useCallback((ok: boolean) => {
    setPending(prev => { prev?.resolve(ok); return null })
  }, [])

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {pending && <ConfirmDialog options={pending.options} onAnswer={answer} />}
    </ConfirmContext.Provider>
  )
}

function ConfirmDialog({ options, onAnswer }: { options: ConfirmOptions; onAnswer: (ok: boolean) => void }) {
  const { title, message, details, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'default' } = options
  const danger = tone === 'danger'
  const cancelRef = useRef<HTMLButtonElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ;(danger ? cancelRef : okRef).current?.focus()
    // Caught first (window, capture phase) and stopped there: the page under
    // the box has its own Escape handlers (a slide-over closing, which asks
    // "discard your changes?" again), and they must not see the Escape that
    // answered this box, or it would reopen at once.
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onAnswer(false) }
      if (e.key === 'Tab') {
        // Two buttons: Tab and Shift+Tab move between them, never out.
        e.preventDefault(); e.stopPropagation()
        const next = document.activeElement === cancelRef.current ? okRef.current : cancelRef.current
        next?.focus()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('keydown', key, true); before?.focus?.() }
  }, [danger, onAnswer])

  const paragraphs = (message ?? '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)

  return (
    <div className={css.backdrop} onMouseDown={e => { if (e.target === e.currentTarget) onAnswer(false) }}>
      <div className={css.card} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"
        aria-describedby={paragraphs.length ? 'confirm-message' : undefined}>
        <div className={css.head}>
          <span className={`${css.badge} ${danger ? css.badgeDanger : ''}`} aria-hidden>{danger ? '!' : '?'}</span>
          <h2 id="confirm-title" className={css.title}>{title}</h2>
        </div>
        {paragraphs.length > 0 && (
          <div id="confirm-message" className={css.message}>
            {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
          </div>
        )}
        {details && details.length > 0 && (
          <dl className={css.details}>
            {details.map(d => (
              <div key={d.label} className={css.detail}>
                <dt>{d.label}</dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className={css.foot}>
          <button ref={cancelRef} type="button" className={css.cancel} onClick={() => onAnswer(false)}>{cancelLabel}</button>
          <button ref={okRef} type="button" className={danger ? css.danger : css.ok} onClick={() => onAnswer(true)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
