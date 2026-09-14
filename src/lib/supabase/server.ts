import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { createFinanceFakeClient } from "@/lib/finance/dev-fixtures";

export function createServerClient(): SupabaseClient {
  // TAYF_FAKE_FINANCE=1 (dev only) serves the /ekonomi pages from fixture
  // rows so the layout can be reviewed before migrations 049/050 exist in
  // the database. Every other table answers empty.
  if (process.env.NODE_ENV !== "production" && process.env.TAYF_FAKE_FINANCE === "1") {
    return createFinanceFakeClient() as SupabaseClient;
  }

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
