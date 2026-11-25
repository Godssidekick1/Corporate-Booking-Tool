'use client'

import { useEffect } from 'react'
import './globals.css'
import { ErrorScreen } from '@/app/components/StatusScreen'

// A crash in the root layout itself. This replaces the whole document, so it
// brings its own <html>, <body> and stylesheet (Next does not apply the root
// layout's here). Rare: every section has its own error.tsx inside it.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error) }, [error])
  return (
    <html lang="en">
      <body>
        <title>Something went wrong · TravelDesk</title>
        <ErrorScreen error={error} retry={retry} fullScreen />
      </body>
    </html>
  )
}
