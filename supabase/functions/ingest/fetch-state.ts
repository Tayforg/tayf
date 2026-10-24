// supabase/functions/ingest/fetch-state.ts
//
// Pure helpers for the batched sources.fetch_* write (migration 041/074/119).
// No Deno globals and no esm.sh imports, so vitest can import this module.
//
// One `ingest_set_source_fetch_state` call covers every source a cycle
// attempted, so a single row Postgres refuses fails the whole batch and every
// other source loses its etag, body hash, fail streak, quarantine escalation
// and freshness for that cycle. `persistSourceFetchState` therefore retries a
// refused batch in halves (`upsertWithBisect`), but only when the refusal is
// about a ROW'S DATA; any other failure would fail every half the same way.

/**
 * True for a Postgres SQLSTATE that a single bad row can raise: class 22 (data
 * exception: out-of-range or malformed timestamp, number or text) and class 23
 * (integrity constraint violation). Everything else (57014 statement timeout,
 * 08xxx connection, 40xxx serialization or deadlock, 42xxx missing function or
 * column or privilege, PostgREST's PGRSTxxx) is not row-scoped, so splitting
 * the batch would only multiply the load on a database that is already unwell.
 */
export function isRowScopedPgError(code: unknown): boolean {
  return typeof code === "string" && /^2[23][0-9A-Z]{3}$/.test(code);
}

/**
 * Most RPC calls one `persistSourceFetchState` may spend isolating bad rows.
 * One bad row out of n needs 1 + 2*ceil(log2 n) calls (15 for the whole
 * 118-source roster, 9 for a 16-row mid-cycle flush), so 24 covers a couple of
 * them; a batch that is bad everywhere stops here instead of spending ~2n calls.
 * Rows left unwritten are logged, and their sources are simply attempted again
 * next cycle.
 */
export const FETCH_STATE_WRITE_MAX_CALLS = 24;
