import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function createRealServerClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Copy .env.local.example to .env.local and fill in your Supabase credentials."
    );
  }

  return createClient(supabaseUrl, supabaseServiceKey);
}

export function createServerClient(): SupabaseClient {
  return createRealServerClient();
}

let warnedFakeFinance = false;

/**
 * Finance-only client factory (SEC-09/TS-07).
 *
 * TAYF_FAKE_FINANCE=1 in local development serves the /ekonomi pages from
 * fixture rows so the layout can be reviewed before migrations 049-051
 * exist in the database. The gate is `NODE_ENV === 'development'`
 * specifically — not `!== 'production'` — so `NODE_ENV=test` (vitest) can
 * never reach the fixture branch. The fixture module is loaded with a
 * dynamic `import()` inside the branch so it (and the chainable test
 * helper it used to import) leaves the static production bundle graph
 * entirely, rather than sitting behind nothing but this runtime check.
 *
 * Only the finance query layer (lib/finance/queries.ts) should call this;
 * every other caller keeps using the synchronous `createServerClient()`
 * above, which never has a fixture path.
 */
export async function createFinanceServerClient(): Promise<SupabaseClient> {
  if (process.env.NODE_ENV === "development" && process.env.TAYF_FAKE_FINANCE === "1") {
    if (!warnedFakeFinance) {
      console.warn("[finance] TAYF_FAKE_FINANCE=1 — serving /ekonomi from dev fixtures, not the database.");
      warnedFakeFinance = true;
    }
    const { createFinanceFakeClient } = await import("@/lib/finance/dev-fixtures");
    return createFinanceFakeClient() as SupabaseClient;
  }

  return createRealServerClient();
}
