// Browser-side PostgREST client using the publishable anon key. The anon role
// has NO table or sequence privileges (migration 117; the RLS SELECT policies
// of 017 no longer apply), so the only thing this client may call is the
// allowlisted SECURITY DEFINER RPC saved_clusters (migration 116) or its
// saved_clusters_v2 (124) and saved_clusters_v3 (158, adds first_published)
// siblings: a bounded, read-only lookup of at most 200 clusters by id. Used by
// client components that need data keyed on
// browser-only state — e.g. the Saved page resolving localStorage bookmark ids
// to cluster titles. Never `.from(...)`: tests/guards/anon-surface.test.ts pins
// the importers and the RPC names.
//
// This used to wrap @supabase/supabase-js createClient. That library is
// 243.7 KB raw / 63 KB gz in the browser, GoTrue and realtime included, and the
// Saved page lazy-loaded all of it before its single RPC could even start. A
// plain fetch is the same request (the headers src/lib/seo/merged-cluster-gate.ts
// already sends in production) at a fraction of the weight. The result shape,
// {data, error: {code, message}}, is what the two callers read.
// tests/guards/browser-client-weight.test.ts keeps supabase-js out.
//
// Module-level singleton: every consumer shares one client per tab.

type SavedRpcName = "saved_clusters" | "saved_clusters_v2" | "saved_clusters_v3";

export interface BrowserRpcError {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

export interface BrowserClient {
  rpc<T = unknown>(
    name: SavedRpcName,
    args: Record<string, unknown>,
  ): Promise<{ data: T | null; error: BrowserRpcError | null }>;
}

// Enforced at runtime too: a cast cannot widen what the anon key may reach.
const ALLOWED_RPCS: ReadonlySet<string> = new Set(["saved_clusters", "saved_clusters_v2", "saved_clusters_v3"]);

const failure = (error: BrowserRpcError) => ({ data: null, error });

let client: BrowserClient | null = null;

export function createBrowserClient(): BrowserClient {
  if (client) return client;

  // Direct property reads: Next inlines only these literal forms.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }
  let base = url;
  while (base.endsWith("/")) base = base.slice(0, -1);

  client = {
    async rpc<T>(name: SavedRpcName, args: Record<string, unknown>) {
      if (!ALLOWED_RPCS.has(name)) return failure({ message: "rpc not allowed" });

      let res: Response;
      try {
        res = await fetch(`${base}/rest/v1/rpc/${name}`, {
          method: "POST",
          headers: {
            apikey: anonKey,
            Authorization: `Bearer ${anonKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(args),
          // No user sessions in Tayf: never send cookies to the API host.
          credentials: "omit",
        });
      } catch (err) {
        return failure({ message: err instanceof Error && err.message ? err.message : "Network error" });
      }

      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // An unreadable body is only an error on a 200; otherwise the status speaks.
        if (res.ok) return failure({ message: "Invalid JSON response" });
      }
      if (res.ok) return { data: body as T, error: null };

      // PostgREST error body: copy only its documented string fields.
      const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const error: BrowserRpcError = {
        message: typeof b.message === "string" && b.message ? b.message : `HTTP ${res.status}`,
      };
      if (typeof b.code === "string") error.code = b.code;
      if (typeof b.details === "string" || b.details === null) error.details = b.details;
      if (typeof b.hint === "string" || b.hint === null) error.hint = b.hint;
      return failure(error);
    },
  };
  return client;
}
