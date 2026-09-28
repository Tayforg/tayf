// scripts/lib/jev-gold-opus-seed.mjs
//
// Pure helpers for the "gold-seed" pack (migration 076): turn the 360 Opus
// (`labels_0.json` + `labels_1.json`) provisional labels + the Jev
// reference answers (`accuracy_t1.json`) into the deterministic SQL seed
// file `scripts/sql/jev-gold-opus-seed.sql`, which calls
// public.jev_gold_import_provisional() exactly once. No network, no DB, no
// LLM calls — every function here is synchronous and side-effect free so
// the CLI (scripts/jev-gold-opus-seed.mjs) and the test file
// (scripts/lib/jev-gold-opus-seed.test.mjs) can exercise it with inline
// fixtures.
//
// Kept a single-line array literal, mirroring src/lib/admin/jev-gold.ts's
// JEV_GOLD_TOPICS (JEV-A19-style pin): scripts/lib/jev-gold-opus-seed.test.mjs
// asserts the two arrays deep-equal.
export const JEV_GOLD_TOPICS = ["politika", "dunya", "ekonomi", "spor", "yasam", "teknoloji", "genel"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX_LENGTH = 300;

/**
 * Parses one labels_N.json payload's `headlines[]` into provisional-label
 * rows: { article_id, is_politics, topic, note }. Throws with the offending
 * index (1-based, matching the array position a human would count) on the
 * first invalid entry: a non-uuid id, a non-boolean is_politics, or a topic
 * outside JEV_GOLD_TOPICS. `gold_note` maps to `note`, truncated to 300
 * characters; an absent/empty note maps to null.
 */
export function parseLabelFile(json) {
  if (json === null || typeof json !== "object" || !Array.isArray(json.headlines)) {
    throw new Error("parseLabelFile: expected an object with a headlines[] array");
  }

  return json.headlines.map((entry, i) => {
    const idx = i + 1;
    if (entry === null || typeof entry !== "object") {
      throw new Error(`parseLabelFile: headlines[${idx}] is not an object`);
    }
    const { id, is_politics: isPolitics, topic, gold_note: goldNote } = entry;

    if (typeof id !== "string" || !UUID_RE.test(id)) {
      throw new Error(`parseLabelFile: headlines[${idx}] has a bad id (${JSON.stringify(id)})`);
    }
    if (typeof isPolitics !== "boolean") {
      throw new Error(`parseLabelFile: headlines[${idx}] (${id}) has a non-boolean is_politics`);
    }
    if (typeof topic !== "string" || !JEV_GOLD_TOPICS.includes(topic)) {
      throw new Error(`parseLabelFile: headlines[${idx}] (${id}) has a bad topic (${JSON.stringify(topic)})`);
    }

    const note =
      typeof goldNote === "string" && goldNote.trim().length > 0 ? goldNote.slice(0, NOTE_MAX_LENGTH) : null;

    return {
      article_id: id.toLowerCase(),
      is_politics: isPolitics,
      topic,
      note,
    };
  });
}

/**
 * Dedupes rows across one or more parseLabelFile() outputs by article_id.
 * The two label files are disjoint by construction (180 + 180 = 360
 * distinct ids), so any repeated id is an authoring error: throws unless
 * every field of the duplicate matches exactly.
 */
export function mergeLabels(lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const row of list) {
      const prior = byId.get(row.article_id);
      if (prior === undefined) {
        byId.set(row.article_id, row);
        continue;
      }
      const same =
        prior.is_politics === row.is_politics && prior.topic === row.topic && prior.note === row.note;
      if (!same) {
        throw new Error(`mergeLabels: conflicting duplicate for ${row.article_id}`);
      }
      // Identical duplicate: keep the first, no-op.
    }
  }
  return [...byId.values()];
}

/**
 * Attaches the Jev reference answer to each row: ref_jev_prob from
 * accuracyJson[lang][article_id].probability when it is a finite number in
 * [0, 1], else null (missing id, missing lang, non-numeric or out-of-range
 * probability all fall through to null — never throw, a rig gap is not a
 * seed-time error). ref_jev_source is a fixed provenance string whenever a
 * probability is attached, and null otherwise.
 */
export function attachRefJev(rows, accuracyJson, lang = "en") {
  const table = accuracyJson && typeof accuracyJson === "object" ? accuracyJson[lang] : undefined;

  return rows.map((row) => {
    const entry = table && typeof table === "object" ? table[row.article_id] : undefined;
    const prob = entry && typeof entry === "object" ? entry.probability : undefined;
    const valid = typeof prob === "number" && Number.isFinite(prob) && prob >= 0 && prob <= 1;

    return {
      ...row,
      ref_jev_prob: valid ? prob : null,
      ref_jev_source: valid ? "limits-rig-2026-09-20/t1-en/title-only" : null,
    };
  });
}

/**
 * Counts rows where the provisional label and the Jev reference answer
 * disagree at the given threshold (ref_jev_prob >= threshold) <> is_politics.
 * Rows with no ref_jev_prob never count (nothing to disagree with).
 */
export function countDisagreements(rows, threshold = 0.5) {
  return rows.filter((row) => row.ref_jev_prob !== null && (row.ref_jev_prob >= threshold) !== row.is_politics)
    .length;
}

const SEED_QUOTE = "$seed$";

/**
 * Renders the full, deterministic SQL seed file: one
 * jev_gold_import_provisional() call wrapping every row as one JSON object
 * per line inside a $seed$ dollar-quoted jsonb array literal. No
 * timestamps, no random ordering (rows sorted by article_id) — the output
 * is byte-identical across runs given the same input rows.
 */
export function renderSeedSql(rows, { labelSource = "opus-2026-09-20", stratum = "opus_seed" } = {}) {
  const sorted = [...rows].sort((a, b) => (a.article_id < b.article_id ? -1 : a.article_id > b.article_id ? 1 : 0));

  const lines = sorted.map((row) => {
    const payload = {
      article_id: row.article_id,
      is_politics: row.is_politics,
      topic: row.topic,
      note: row.note ?? null,
      ref_jev_prob: row.ref_jev_prob ?? null,
      ref_jev_source: row.ref_jev_source ?? null,
    };
    const json = JSON.stringify(payload);
    if (json.includes(SEED_QUOTE)) {
      throw new Error(`renderSeedSql: payload for ${row.article_id} contains the $seed$ dollar-quote delimiter`);
    }
    return json;
  });

  const disagreements = countDisagreements(sorted, 0.5);

  return `-- scripts/sql/jev-gold-opus-seed.sql
-- GENERATED by scripts/jev-gold-opus-seed.mjs from labels_0.json + labels_1.json
-- (360 model-labelled headlines, paid Opus labels, provenance
-- label_source='${labelSource}') and accuracy_t1.json (the 2026-09-20
-- limits rig's title-only Jev reference answers, en, t1).
--
-- Apply ONCE, after migration 076, as postgres:
--   psql "$DATABASE_URL" -f scripts/sql/jev-gold-opus-seed.sql
-- Idempotent (jev_gold_import_provisional's two ON CONFLICT DO NOTHING
-- clauses): safe to re-run. Never run by CI or by \`supabase db reset\`
-- (this file lives outside supabase/, so config.toml's seed.sql-only
-- reset never touches it).
--
-- Row count: ${sorted.length}. Disagreements at 0.5 against the Jev
-- reference: ${disagreements}.
begin;

select * from public.jev_gold_import_provisional(
  ${SEED_QUOTE}[
${lines.map((line) => `  ${line}`).join(",\n")}
]${SEED_QUOTE}::jsonb,
  '${labelSource}',
  '${stratum}'
);

commit;
`;
}
