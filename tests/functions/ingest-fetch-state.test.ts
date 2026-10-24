import { describe, expect, it } from "vitest";

import {
  FETCH_STATE_WRITE_MAX_CALLS,
  isRowScopedPgError,
} from "../../supabase/functions/ingest/fetch-state";

// ---------------------------------------------------------------------------
// Helpers behind persistSourceFetchState's bisecting retry (migration 119).
// One batched `ingest_set_source_fetch_state` write covers every source the
// cycle attempted, so one row Postgres refuses (a year-0 item date, say) fails
// the whole batch. A batch refused for a reason that belongs to a ROW's data is
// worth splitting; one refused for any other reason (a timeout, a dropped
// connection, a missing function, a permission error) would fail every half
// just the same, so splitting it only multiplies the load on a sick database.
// ---------------------------------------------------------------------------

describe("isRowScopedPgError", () => {
  it("is true for SQLSTATE class 22 (data exception): the datetime and numeric errors a bad row raises", () => {
    for (const code of ["22008", "22007", "22009", "22003", "22P02", "22001", "22000"]) {
      expect(isRowScopedPgError(code), code).toBe(true);
    }
  });

  it("is true for SQLSTATE class 23 (integrity constraint violation)", () => {
    for (const code of ["23502", "23503", "23505", "23514"]) {
      expect(isRowScopedPgError(code), code).toBe(true);
    }
  });

  it("is false for everything that would fail every half the same way", () => {
    for (const code of [
      "57014", // statement timeout
      "57P01", // admin shutdown
      "08006", // connection failure
      "53300", // too many connections
      "40001", // serialization failure
      "40P01", // deadlock
      "42883", // function does not exist
      "42703", // undefined column
      "42501", // permission denied
      "PGRST202", // PostgREST: function not found in schema cache
      "PGRST301", // PostgREST: JWT error
    ]) {
      expect(isRowScopedPgError(code), code).toBe(false);
    }
  });

  it("is false for a missing, empty, or malformed code", () => {
    for (const code of [undefined, null, "", "2", "22", "x22008", " 22008", 22008 as unknown as string]) {
      expect(isRowScopedPgError(code), String(code)).toBe(false);
    }
  });
});

describe("FETCH_STATE_WRITE_MAX_CALLS", () => {
  it("is 24: enough to isolate a couple of bad rows out of a flush (1 + 2*ceil(log2 n) calls for one), small enough to stay cheap", () => {
    expect(FETCH_STATE_WRITE_MAX_CALLS).toBe(24);
    // one bad row out of a 118-source roster costs 1 + 2*7 = 15 calls
    expect(1 + 2 * Math.ceil(Math.log2(118))).toBeLessThanOrEqual(FETCH_STATE_WRITE_MAX_CALLS);
  });
});
