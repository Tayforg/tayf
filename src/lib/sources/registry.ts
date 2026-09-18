import { BIAS_LABELS, ZONE_META, zoneOf } from "@/lib/bias/config";
import { getSourceMetadata } from "@/lib/sources/factuality";
import { OWNER_GROUPS } from "@/lib/sources/ownership";
import { siteUrl } from "@/lib/site-url";
import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";

/**
 * Public, attribution-licensed source registry (S-20 + M-04).
 *
 * `src/app/api/sources/route.ts` and `src/app/api/sources/[slug]/route.ts`
 * both import this module instead of building the wire shape inline, so
 * the two routes can never drift on field names, the licence string, or
 * the envelope shape.
 *
 * Must stay byte-identical to pack A's `/llms.txt` licence line
 * (`src/app/llms.txt/route.ts`, on a different branch as of this pack) --
 * pinned locally here by `tests/api/sources-json.test.ts`; add the genuine
 * cross-file assertion once both branches merge. Do NOT append anything (a
 * trailing URL, a parenthetical) to this constant; the exact string is
 * part of the cross-pack contract.
 */
export const REGISTRY_LICENCE = "CC BY-SA 4.0 — Tayf'a göre";

/**
 * Where a copier is pointed for the attribution + methodology text.
 * Derived from `siteUrl()` (same as `methodology` in `registryEnvelope`
 * below) so the two never disagree on a preview/dev deploy where
 * `NEXT_PUBLIC_SITE_URL` differs from production.
 */
export const REGISTRY_ATTRIBUTION = `${siteUrl()}/metodoloji`;

/**
 * The wire shape for one source in the registry. Every field is present on
 * every record — untagged data (no operator rationale, no hand-tagged
 * ownership/factuality call, no recorded trusteeship) is an explicit
 * `null`, never omitted, so a consumer can tell "no rationale" from "field
 * missing" without special-casing partial records.
 */
export interface RegistryRecord {
  slug: string;
  name: string;
  url: string;
  bias: BiasCategory;
  bias_label: string;
  zone: MediaDnaZone;
  zone_label: string;
  kind: SourceKind;
  owner_group: string | null;
  owner_group_label: string | null;
  factuality: "high" | "mixed" | "low" | null;
  /** Date this outlet's owner passed to a trustee (kayyum), ISO yyyy-mm-dd. */
  trustee_since: string | null;
  /** Dated public-source citation backing `trustee_since`. */
  trustee_note: string | null;
  /**
   * Operator-written rationale for this source's bias/zone label. `null`
   * means "not yet written" — never fabricated, inferred, or model-filled.
   */
  rationale: string | null;
  rationale_at: string | null;
  active: boolean;
}

/**
 * The subset of `sources` columns `toRegistryRecord` needs. Matches the
 * registry columns added by migration 055
 * (`supabase/migrations/055_source_zone_registry.sql`) plus the
 * pre-existing identity/bias columns.
 */
export interface RegistrySourceRow {
  slug: string;
  name: string;
  url: string;
  bias: BiasCategory;
  kind?: SourceKind | null;
  active: boolean;
  zone_rationale: string | null;
  zone_rationale_at: string | null;
  trustee_since: string | null;
  trustee_note: string | null;
}

/**
 * Maps a raw `sources` row to the public `RegistryRecord` wire shape.
 * `zone`/`zone_label` are derived from `bias` via `zoneOf` (the single
 * source of truth for the bias -> Medya DNA zone mapping);
 * `owner_group`/`owner_group_label`/`factuality` come from the hand-tagged
 * `SOURCE_METADATA` map (`@/lib/sources/factuality`) via the source's
 * slug, not from a DB column — most of the 118 sources have no entry
 * there, and that absence is exactly what the explicit `null`s below
 * communicate.
 */
export function toRegistryRecord(row: RegistrySourceRow): RegistryRecord {
  const zone = zoneOf(row.bias);
  const meta = getSourceMetadata(row.slug);
  const ownerGroup = meta?.ownerGroup ?? null;

  return {
    slug: row.slug,
    name: row.name,
    url: row.url,
    bias: row.bias,
    bias_label: BIAS_LABELS[row.bias] ?? row.bias,
    zone,
    zone_label: ZONE_META[zone].label,
    kind: (row.kind ?? "outlet") as SourceKind,
    owner_group: ownerGroup,
    owner_group_label: ownerGroup ? (OWNER_GROUPS[ownerGroup] ?? ownerGroup) : null,
    factuality: meta?.factuality ?? null,
    trustee_since: row.trustee_since ?? null,
    trustee_note: row.trustee_note ?? null,
    rationale: row.zone_rationale ?? null,
    rationale_at: row.zone_rationale_at ?? null,
    active: row.active,
  };
}

/**
 * Wraps registry payloads (the source list, or a single source + its
 * history) with the shared licence/attribution/methodology/generated_at
 * envelope. Both `/api/sources` routes call this instead of building the
 * top-level object inline so the envelope can never drift between them.
 *
 * `data` is spread FIRST and the envelope fields are set after, so the
 * envelope always wins a collision — the licence string is the entire
 * point of this pack, so a payload key named `licence` (etc.) silently
 * overwriting it at runtime would be the wrong default. The `never`-typed
 * envelope keys on `T` turn a colliding key into a compile error too.
 */
export function registryEnvelope<
  T extends Record<string, unknown> & {
    licence?: never;
    attribution?: never;
    methodology?: never;
    generated_at?: never;
  },
>(
  data: T,
): {
  licence: string;
  attribution: string;
  methodology: string;
  generated_at: string;
} & T {
  return {
    ...data,
    licence: REGISTRY_LICENCE,
    // Same origin as REGISTRY_ATTRIBUTION (both derived from `siteUrl()`)
    // so the two published fields can never disagree on a preview/dev
    // deploy.
    attribution: REGISTRY_ATTRIBUTION,
    methodology: REGISTRY_ATTRIBUTION,
    generated_at: new Date().toISOString(),
  };
}
