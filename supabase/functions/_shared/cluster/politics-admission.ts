// The politics-admission contract (migration 089, "ADMIT"): pure policy for
// deciding which non-politika/son_dakika articles Jev may admit into the
// clusterer, and how an admit-tagged pgmq message should route once it
// reaches cluster-consumer. Ships with JEV_POLITICS_ADMISSION off, so none
// of this changes reader-facing behaviour in this PR.
//
// Consumers:
//   * Deno: cluster-consumer/index.ts imports this file directly (relative
//     .ts import, same discipline as blindspot.ts / source-kind.ts).
//   * Next: src/lib/bias/config.ts re-exports isPoliticsMember /
//     POLITICS_CATEGORIES / JEV_ADMISSION_POLICY / AdmissionPin.
//
// Keep this module dependency-free — it has to compile under tsc (Next,
// vitest) and deno with no import map, and NEVER via a `./x.ts`-extension
// relative import under `moduleResolution: bundler` (TS5097).

export const POLITICS_CATEGORIES = ["politika", "son_dakika"] as const;

/** A pinned (politics, topic7) question-fingerprint pair, per JEV-A's
 * per-task fingerprints (jev_answer.question_hash). */
export interface AdmissionPin {
  politics: string;
  topic7: string;
}

// Values verified 2026-09-28 against main at 5d56dbc, question set
// 2026-09-24.1. shadowPins holds the pair until >=48h shadow + >=50
// stratified reviews promote it into livePins (a later, separate PR).
export const JEV_ADMISSION_POLICY = {
  envFlag: "JEV_POLITICS_ADMISSION",
  minPoliticsProb: 0.9,
  topic7Choice: "politika",
  excludedCategories: ["politika", "son_dakika", "dunya"],
  maxAgeHours: 6,
  lookbackMinutes: 90,
  maxClaimsPerDrain: 20,
  livePins: [] as AdmissionPin[],
  shadowPins: [
    { politics: "fnv1a64:b28f24b28b0aa1e2", topic7: "fnv1a64:a5be77748d03273a" },
  ] as AdmissionPin[],
};

export type AdmissionMode = "off" | "shadow" | "live";

/** Strict parse: only the exact strings "shadow" and "live" enable
 * anything. undefined, '', '1', 'on', 'LIVE', ' live' all mean off. */
export function admissionMode(flag?: string | null): AdmissionMode {
  if (flag === "shadow") return "shadow";
  if (flag === "live") return "live";
  return "off";
}

/** The `admit` field of a claimed pgmq message. Only the exact strings
 * "shadow" and "live" are recognised; anything else (including undefined,
 * '', or a stray extra field) parses to null -- "not an admission claim". */
export function parseAdmitTag(value: unknown): "shadow" | "live" | null {
  if (value === "shadow" || value === "live") return value;
  return null;
}

/** A read-path member counts as "politics" if its own category is
 * politika/son_dakika, OR it carries a non-null politics_admitted_at stamp
 * (a live admission). Inert today (the flag is off, so nothing is ever
 * stamped) but mandatory: otherwise a cluster whose members are >=40%
 * admitted would silently drop out once live mode arrives. */
export function isPoliticsMember(article: {
  category: string | null | undefined;
  politics_admitted_at?: string | null;
} | null | undefined): boolean {
  if (!article) return false;
  if (article.category != null && (POLITICS_CATEGORIES as readonly string[]).includes(article.category)) {
    return true;
  }
  return article.politics_admitted_at != null;
}

/** The claim RPC's positional args for a given mode, straight from the
 * policy above -- the single source of truth cluster-consumer calls with. */
export function claimArgs(mode: AdmissionMode): {
  p_mode: "shadow" | "live";
  p_live_pins: AdmissionPin[];
  p_shadow_pins: AdmissionPin[];
  p_min_politics: number;
  p_topic7: string;
  p_excluded_categories: string[];
  p_max_age: string;
  p_lookback: string;
  p_limit: number;
} {
  return {
    p_mode: mode === "live" ? "live" : "shadow",
    p_live_pins: JEV_ADMISSION_POLICY.livePins,
    p_shadow_pins: JEV_ADMISSION_POLICY.shadowPins,
    p_min_politics: JEV_ADMISSION_POLICY.minPoliticsProb,
    p_topic7: JEV_ADMISSION_POLICY.topic7Choice,
    p_excluded_categories: JEV_ADMISSION_POLICY.excludedCategories,
    p_max_age: `${JEV_ADMISSION_POLICY.maxAgeHours} hours`,
    p_lookback: `${JEV_ADMISSION_POLICY.lookbackMinutes} minutes`,
    p_limit: JEV_ADMISSION_POLICY.maxClaimsPerDrain,
  };
}

export type AdmitRoute = "cluster" | "dry-run" | "not-politics" | "disabled" | "rejected";

/** Routes a (fetched) article + an admit-tagged message's `admit` field
 * under the current mode. Order matters -- see the numbered rules below. */
export function routeMessage(
  article: { category: string | null | undefined; politics_admitted_at?: string | null },
  admit: "shadow" | "live" | null,
  mode: AdmissionMode,
): AdmitRoute {
  // 1. category politika/son_dakika -> "cluster" (the trigger path is untouched).
  if (article.category != null && (POLITICS_CATEGORIES as readonly string[]).includes(article.category)) {
    return "cluster";
  }
  // 2. otherwise admit null -> "not-politics".
  if (admit === null) return "not-politics";
  // 3. mode off -> "disabled".
  if (mode === "off") return "disabled";
  // 4. admit shadow -> "dry-run" (in both shadow and live mode).
  if (admit === "shadow") return "dry-run";
  // admit === "live" from here on.
  // 7. admit live in shadow mode -> "disabled".
  if (mode === "shadow") return "disabled";
  // mode === "live" from here on.
  // 5. admit live in live mode with a non-null stamp -> "cluster".
  if (article.politics_admitted_at != null) return "cluster";
  // 6. admit live in live mode without a stamp -> "rejected".
  return "rejected";
}
