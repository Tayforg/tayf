// The paging loop moved to src/lib/db/paging.ts; this re-export keeps the finance import path working.
export { POSTGREST_MAX_ROWS, readAllPages, type ReadAllPagesOptions } from "@/lib/db/paging";
