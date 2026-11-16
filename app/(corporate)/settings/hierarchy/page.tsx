import { redirect } from 'next/navigation'

// ── /settings/hierarchy ──────────────────────────────────────────────────────
// Moved: who reports to whom is now the Organization page, on everyone's
// sidebar (/organization). Old links and bookmarks land there.
// ─────────────────────────────────────────────────────────────────────────────

export default function SettingsHierarchyPage() {
  redirect('/organization')
}
