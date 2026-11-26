'use client'

import { useEffect, type RefObject } from 'react'

// Closes a popover on a press outside it, or on Escape. On mousedown, not
// click: the box is gone before the click lands, so the press reaches what was
// under it (an open box over the Search button used to swallow the first
// click). Shared by the travellers popover and the date picker.
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [ref, open, close])
}
