'use client'

import { useEffect } from 'react'
import { ErrorScreen } from '@/app/components/StatusScreen'

// A crash anywhere without a section of its own: the whole screen (app/components/StatusScreen.tsx).
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error) }, [error])
  return <ErrorScreen error={error} retry={retry} fullScreen />
}
