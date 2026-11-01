import { describe, expect, it } from "vitest";

import * as dbPaging from "@/lib/db/paging";

import * as financePaging from "./paging";

// The paging loop moved to src/lib/db/paging.ts (its cases live in
// src/lib/db/paging.test.ts). This module only has to keep the old import path
// working, with the very same bindings.
describe("finance/paging re-export", () => {
  it("exposes the db module's bindings, not copies", () => {
    expect(financePaging.readAllPages).toBe(dbPaging.readAllPages);
    expect(financePaging.POSTGREST_MAX_ROWS).toBe(dbPaging.POSTGREST_MAX_ROWS);
  });
});
