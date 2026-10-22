import ReportsScreen from '@/app/components/reports/ReportsScreen'
import { CORPORATE_CATALOG } from '@/app/lib/reports/catalog'

export default function ReportsPage() {
  return (
    <ReportsScreen
      base="/api/reports"
      catalog={CORPORATE_CATALOG}
      title="Reports"
      intro="Your company’s travel from bookings already made: spend, policy compliance, savings, approvals, trips and patterns. Amounts are what the company pays."
    />
  )
}
