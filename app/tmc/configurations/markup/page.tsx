import CommercialRulesPage from '../commercials/CommercialRulesPage'

// Three nav entries, one screen. Markup, discounts and processing fees are three
// different jobs to a desk, but they share a table, a resolver and a component —
// they compose in a fixed order into one sell price, and splitting them would
// put that order in whatever happened to call all three.
export default function MarkupPage() {
  return <CommercialRulesPage kind="markup" />
}
