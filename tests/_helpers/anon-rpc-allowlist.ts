// ---------------------------------------------------------------------------
// The anon RPC allowlist, shared by tests that must agree on it.
//
// The public anon key reaches data ONLY through these SECURITY DEFINER RPCs
// (migration 116, plus saved_clusters_v2 of migration 124). Two places must name
// exactly this set, and a copy in each would drift:
//   * tests/guards/anon-surface.test.ts scans the migration text for grants;
//   * tests/migrations/145-ops-anon-surface.test.ts pins the array literal that
//     ops_health_report() row 17 (anon_surface) excludes from its runtime check.
//
// It lives in a helper, not in anon-surface.test.ts, because importing a
// *.test.ts file registers that file's tests in the importer.
// ---------------------------------------------------------------------------

export const ALLOWED_RPCS = [
  "saved_clusters",
  "merged_cluster_map",
  "source_slugs",
  "source_slug_exists",
  "saved_clusters_v2",
] as const;

// The migration that defines + grants each allowlisted RPC.
export const ALLOWED_RPC_MIGRATION: Record<(typeof ALLOWED_RPCS)[number], number> = {
  saved_clusters: 116,
  merged_cluster_map: 116,
  source_slugs: 116,
  source_slug_exists: 116,
  saved_clusters_v2: 124,
};

// The allowlist is by FULL IDENTITY (name + argument types), not by name: each allowlisted
// RPC has exactly one signature, and PUBLIC still gets EXECUTE on every new function
// (migration 117), so an overload such as source_slug_exists(text, boolean) created from
// the dashboard would be anon-executable. The argument types are written the way
// pg_catalog.oidvectortypes(proargtypes) prints them (the same text the migration-145
// check builds), which is also how migrations 116/124/138 spell their grants.
export const ALLOWED_RPC_ARGS: Record<(typeof ALLOWED_RPCS)[number], string> = {
  saved_clusters: "uuid[]",
  merged_cluster_map: "",
  source_slugs: "",
  source_slug_exists: "text",
  saved_clusters_v2: "uuid[]",
};

/** `name(argument types)` of each allowlisted RPC, in ALLOWED_RPCS order. */
export const ALLOWED_RPC_IDENTITIES: readonly string[] = ALLOWED_RPCS.map(
  (name) => `${name}(${ALLOWED_RPC_ARGS[name]})`,
);
