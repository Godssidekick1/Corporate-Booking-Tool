import { setOutsideContext } from '@/app/lib/db'

// The suite's own queries -- setting up rows, asserting on them -- run outside
// any request, and see every tenant, as the owner's tools would. Requests do
// not: route() starts each one with no tenant, and signing in decides it, so
// every route test runs under the database's tenant policies exactly as the
// deployed app does (app/lib/db/context.ts).
setOutsideContext('system')
