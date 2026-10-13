import { redirect } from 'next/navigation'

// Configurations has no landing screen of its own — it is a container. The
// page gate (proxy.ts, app/lib/navigation/tmcAccess.ts) sends each person to
// the first section they may open before this ever renders; this redirect to
// Policy, the first section, is only the fallback.
export default function ConfigurationsIndexPage() {
  redirect('/tmc/configurations/policy')
}
