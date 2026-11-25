'use client'

import { useEffect } from 'react'
import { ErrorScreen } from '@/app/components/StatusScreen'

// A crash in the platform console: shown inside its layout.
export default function PlatformError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error) }, [error])
  return <ErrorScreen error={error} retry={retry} />
}
