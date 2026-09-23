import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ── Data-layer boundaries ────────────────────────────────────────────────────
// SQL has exactly one home: app/lib/repositories (with app/lib/db as the
// driver underneath it). Routes, app/lib domain code and proxy.ts talk to the
// database only by calling repository functions with `db` from '@/app/lib/db'.
//
// Enforced here rather than left as a convention, because a convention is what
// let 537 call sites build queries inline in the first place.
// ─────────────────────────────────────────────────────────────────────────────
const SQL_ONLY_IN_REPOSITORIES = {
  paths: [
    { name: "pg", message: "Query through a repository in app/lib/repositories, passing `db` from '@/app/lib/db'." },
  ],
  patterns: [
    {
      group: ["@/app/lib/db/sql", "@/app/lib/db/fragments", "pg-types"],
      message: "SQL is written only in app/lib/repositories. Call a repository function instead.",
    },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["app/**/*.{ts,tsx}", "utils/**/*.ts", "proxy.ts"],
    ignores: ["app/lib/db/**", "app/lib/repositories/**", "**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", SQL_ONLY_IN_REPOSITORIES],
    },
  },
  {
    // Repositories: typed, and never reaching sideways into auth or
    // transactions. A repository that opened its own transaction would commit
    // independently of the caller's.
    files: ["app/lib/repositories/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@/utils/supabase/*"], message: "Repositories do data only. Auth stays in routes." },
          {
            group: ["@/app/lib/db/transaction", "@/app/lib/db/tx", "@/app/lib/db/client", "@/app/lib/db/builder"],
            message: "Repositories never open transactions or use the shim. Take `db: Queryable` from the caller.",
          },
        ],
      }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
