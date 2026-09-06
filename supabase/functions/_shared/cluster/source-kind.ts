// The source-kind contract: which kinds of source VOTE in bias_distribution,
// blindspot/surprise detection and the trends view. Consumers:
//   * Deno: cluster-consumer imports "../_shared/cluster/source-kind.ts".
//   * Next: src/lib/bias/config.ts re-exports SOURCE_KINDS / VOTING_SOURCE_KINDS /
//     isVotingKind / normalizeSourceKind; src/lib/sources/kind.ts builds UI helpers on it.
//   * SQL: migration 034 carries the CHECK list and the `kind in ('outlet', 'wire')`
//     filters; tests/migrations/zone-parity.test.ts fails if they drift from here.
//
// Keep this module dependency-free — it has to compile under tsc (Next,
// vitest) and deno with no import map. Do NOT import from ./blindspot.ts:
// the two contracts are independent (bias zone vs. source kind) and either
// one must be importable on its own.

export const SOURCE_KINDS = ["outlet", "aggregator", "wire", "niche"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

// Mirrors `sources.kind ... default 'outlet'` in migration 034.
export const DEFAULT_SOURCE_KIND: SourceKind = "outlet";

// Only these count toward bias_distribution, blindspot/surprise, trends.
export const VOTING_SOURCE_KINDS = ["outlet", "wire"] as const satisfies readonly SourceKind[];

export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && (SOURCE_KINDS as readonly string[]).includes(value);
}

export function normalizeSourceKind(value: unknown): SourceKind {
  return isSourceKind(value) ? value : DEFAULT_SOURCE_KIND;
}

// null/undefined (legacy rows, or a select that never fetched `kind`) keep
// voting — the column is `not null default 'outlet'`, so an absent value on
// an existing row means "outlet", not "unknown, exclude it".
export function isVotingKind(value: unknown): boolean {
  return (VOTING_SOURCE_KINDS as readonly SourceKind[]).includes(normalizeSourceKind(value));
}

// Keeps order; drops null/undefined rows, rows with null/undefined bias, and
// rows whose kind does not vote. A row with no `kind` key at all still votes
// (isVotingKind's null/undefined default).
export function votingBiasKeys<B extends string>(
  rows: ReadonlyArray<{ bias: B | null | undefined; kind?: unknown } | null | undefined>,
): B[] {
  const out: B[] = [];
  for (const row of rows) {
    if (!row) continue;
    if (row.bias === null || row.bias === undefined) continue;
    if (!isVotingKind(row.kind)) continue;
    out.push(row.bias);
  }
  return out;
}
