// ---------------------------------------------------------------------------
// The anon RPC allowlist, shared by tests that must agree on it.
//
// The public anon key reaches data ONLY through these SECURITY DEFINER RPCs
// (migration 116, plus saved_clusters_v2 of migration 124, saved_clusters_v3 of
// migration 158 and saved_clusters_v4 of migration 192). The places that must
// name exactly this set, and a copy in each would drift:
//   * tests/guards/anon-surface.test.ts scans the migration text for grants;
//   * tests/migrations/192-saved-clusters-v4.test.ts pins the array literal that
//     ops_health_report() row 17 (anon_surface) excludes from its runtime check
//     (192 re-creates the function with v4 added to 173's six identities);
//   * tests/migrations/158-saved-clusters-v3.test.ts pins the same array as 158
//     (and, through 159 .. 173, up to 173) wrote it: the set BEFORE 192, below;
//   * tests/migrations/145-ops-anon-surface.test.ts pins the same array as 145
//     (and, through 150 and 157, up to 157) wrote it: the set BEFORE 158, below.
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
  "saved_clusters_v3",
  "saved_clusters_v4",
] as const;

// The migration that defines + grants each allowlisted RPC.
export const ALLOWED_RPC_MIGRATION: Record<(typeof ALLOWED_RPCS)[number], number> = {
  saved_clusters: 116,
  merged_cluster_map: 116,
  source_slugs: 116,
  source_slug_exists: 116,
  saved_clusters_v2: 124,
  saved_clusters_v3: 158,
  saved_clusters_v4: 192,
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
  saved_clusters_v3: "uuid[]",
  saved_clusters_v4: "uuid[]",
};

/** `name(argument types)` of each allowlisted RPC, in ALLOWED_RPCS order. */
export const ALLOWED_RPC_IDENTITIES: readonly string[] = ALLOWED_RPCS.map(
  (name) => `${name}(${ALLOWED_RPC_ARGS[name]})`,
);

/**
 * The allowlist as migrations 145, 150 and 157 spell it in ops_health_report() row 17: the five RPCs
 * that existed before migration 158 added saved_clusters_v3. Those migrations are frozen text, so
 * their tests pin THIS set, not the current one.
 */
export const ALLOWED_RPCS_BEFORE_158: readonly (typeof ALLOWED_RPCS)[number][] = ALLOWED_RPCS.filter(
  (name) => ALLOWED_RPC_MIGRATION[name] < 158,
);

/** `name(argument types)` of each RPC in {@link ALLOWED_RPCS_BEFORE_158}, in the same order. */
export const ALLOWED_RPC_IDENTITIES_BEFORE_158: readonly string[] = ALLOWED_RPCS_BEFORE_158.map(
  (name) => `${name}(${ALLOWED_RPC_ARGS[name]})`,
);

/**
 * The allowlist as migrations 158 .. 173 spell it in ops_health_report() row 17: the six RPCs that existed
 * before migration 192 added saved_clusters_v4. Those migrations are frozen text, so their tests pin THIS
 * set, not the current one.
 */
export const ALLOWED_RPCS_BEFORE_192: readonly (typeof ALLOWED_RPCS)[number][] = ALLOWED_RPCS.filter(
  (name) => ALLOWED_RPC_MIGRATION[name] < 192,
);

/** `name(argument types)` of each RPC in {@link ALLOWED_RPCS_BEFORE_192}, in the same order. */
export const ALLOWED_RPC_IDENTITIES_BEFORE_192: readonly string[] = ALLOWED_RPCS_BEFORE_192.map(
  (name) => `${name}(${ALLOWED_RPC_ARGS[name]})`,
);
