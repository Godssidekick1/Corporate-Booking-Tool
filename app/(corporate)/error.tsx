'use client'

import { useEffect } from 'react'
import { ErrorScreen } from '@/app/components/StatusScreen'

// A crash in a company page: shown in the content area, the rail stays.
export default function CorporateError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error) }, [error])
  return <ErrorScreen error={error} retry={retry} />
}
