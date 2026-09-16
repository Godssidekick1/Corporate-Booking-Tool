import BookingFlowChrome from './BookingFlowChrome'

// ── /book layout ─────────────────────────────────────────────────────────────
// There was no layout under /book at all, and the root layout renders a bare
// <body>{children}</body> — so every booking page had no navigation of any kind.
//
// A server component holding a client one, so the chrome can read the pathname
// and sessionStorage without turning every page beneath it into a client
// component. The pages already declare 'use client' themselves where they need
// it; nothing here changes that.
// ─────────────────────────────────────────────────────────────────────────────

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return <BookingFlowChrome>{children}</BookingFlowChrome>
}
