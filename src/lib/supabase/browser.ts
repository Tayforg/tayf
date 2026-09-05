import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser-side Supabase client using the publishable anon key. RLS (017)
// grants anon SELECT on the content tables (sources/articles/clusters/…)
// and nothing else, so this client is read-only by construction. Used by
// client components that need data keyed on browser-only state — e.g. the
// Saved page resolving localStorage bookmark ids to cluster titles.
//
// Module-level singleton: every consumer shares one client (and one
// connection pool) per tab.

let client: SupabaseClient | null = null;

export function createBrowserClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  client = createClient(url, anonKey, {
    // No user sessions in Tayf — don't persist/refresh auth state.
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
