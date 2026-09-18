import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Permanent guard for SEC-09/TS-07.
//
// The dev-only fixture client (createFinanceFakeClient, this directory's
// dev-fixtures.ts) used to import the shared chainable test helper from
// tests/_helpers/supabase-fake, which put a test-only module on the
// production bundle graph behind nothing but a runtime env check
// (NODE_ENV !== 'production' && TAYF_FAKE_FINANCE === '1', a branch
// webpack/Next can't tree-shake away). dev-fixtures.ts now inlines its own
// small fake instead (see below in this same file) and no longer imports
// tests/_helpers at all.
//
// This is the repo-wide sweep so the same mistake can't land anywhere else
// under src/: no non-test .ts/.tsx file should reference tests/_helpers.
// ---------------------------------------------------------------------------

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_EXT_RE = /\.test\.(ts|tsx)$/;
const SRC_EXT_RE = /\.(ts|tsx)$/;

function walkNonTestSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkNonTestSourceFiles(full, out);
      continue;
    }
    if (SRC_EXT_RE.test(entry) && !TEST_EXT_RE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("finance dev-fixtures / production bundle graph boundary", () => {
  it("no file under src/ outside *.test.ts(x) references tests/_helpers (SEC-09/TS-07)", () => {
    const offenders = walkNonTestSourceFiles(SRC_ROOT).filter((f) => readFileSync(f, "utf8").includes("tests/_helpers"));
    expect(offenders).toEqual([]);
  });
});
