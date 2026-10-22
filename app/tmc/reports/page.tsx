import ReportsScreen from '@/app/components/reports/ReportsScreen'
import { TMC_CATALOG } from '@/app/lib/reports/catalog'

export default function TmcReportsPage() {
  return (
    <ReportsScreen
      base="/api/tmc/reports"
      catalog={TMC_CATALOG}
      title="Reports"
      intro="Across your clients, from bookings already made: revenue and margin, client activity, airlines and deals, the desk’s work, compliance and payments."
    />
  )
}
