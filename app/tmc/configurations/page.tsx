import { redirect } from 'next/navigation'

// Configurations has no landing screen of its own — it is a container. Redirect
// to Policy rather than Client groups (the previous target): Policy is the
// first item in the first group, so the second column's highlight matches where
// you land, and it is the section a TMC opens most.
export default function ConfigurationsIndexPage() {
  redirect('/tmc/configurations/policy')
}
