import type { NextConfig } from "next";

// ── Security headers, on every response ─────────────────────────────────────
// What a browser should refuse on this site's behalf:
//   framing        no other site may load these pages in a frame, so a
//                  click on a hidden "Approve" cannot be stolen (both the old
//                  header and CSP's frame-ancestors, for older browsers)
//   CSP            only the rules that cannot break a page: no plugins, no
//                  <base> or form posts to another origin. Scripts and styles
//                  are not restricted yet; a nonce-based script policy needs
//                  every page rendered per request (docs/future-changes.md).
//   nosniff        a file is what its Content-Type says (CSVs, QR images)
//   referrer       other sites see our origin, never a path with an id in it
//   permissions    no camera, microphone, location or payment APIs
//   HSTS           production only: browsers then refuse plain HTTP to this
//                  host for a year. Not includeSubDomains, so it never reaches
//                  other sites on the same parent domain.
// X-Powered-By is dropped: no need to announce the framework.
// tests/security/headers.test.ts holds this list.
// ─────────────────────────────────────────────────────────────────────────────

const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
    : []),
];

const nextConfig: NextConfig = {
  // This directory is the project root. Without it Turbopack infers the root
  // from the nearest lockfile it finds walking up, and C:\CBT holds a stray
  // package.json/package-lock.json of its own -- so it guessed the parent, and
  // resolved and watched files outside the repository.
  turbopack: {
    root: __dirname,
  },
  // A self-contained server for deployment (scripts/publish.mjs): .next/
  // standalone holds server.js and only the node_modules it needs, so the
  // target machine needs Node and nothing from npm. Tracing is rooted here for
  // the same reason as Turbopack's root above.
  output: "standalone",
  outputFileTracingRoot: __dirname,
  poweredByHeader: false,
  // Coding agents are told about Next.js security upgrades (set by
  // `next upgrade --agent=security`, 16.4.3 → 16.4.6).
  experimental: {
    agentUpgrade: "security",
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
