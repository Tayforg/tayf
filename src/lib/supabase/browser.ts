import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser-side Supabase client using the publishable anon key. The anon role
// has NO table or sequence privileges (migration 117; the RLS SELECT policies
// of 017 no longer apply), so the only thing this client may call is the
// allowlisted SECURITY DEFINER RPC saved_clusters (migration 116): a bounded,
// read-only lookup of at most 200 clusters by id. Used by client components
// that need data keyed on browser-only state — e.g. the Saved page resolving
// localStorage bookmark ids to cluster titles. Never `.from(...)`:
// tests/guards/anon-surface.test.ts pins the importers and the RPC name.
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
