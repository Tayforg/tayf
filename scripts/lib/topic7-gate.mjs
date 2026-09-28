// scripts/lib/topic7-gate.mjs
//
// Pure helpers for the topic7 v2 held-out gate (T7a groundwork, migration
// 090). No network, no filesystem, no LLM calls -- every function here is
// synchronous and side-effect free so scripts/topic7-blind-label.mjs,
// scripts/topic7-v2-gate.mjs and scripts/lib/topic7-gate.test.mjs can
// exercise it with inline fixtures. Founder decision #5: the labelling
// itself (blind answers) and any Jev call are run by the operator, after
// approval, never by this library or by the CLIs that import it.

export const JEV_TOPIC7_CHOICES_ORDER = [
  "politika",
  "dunya",
  "ekonomi",
  "spor",
  "yasam",
  "teknoloji",
  "genel",
];

const GOLD_STRING_RE = /\b(Fidan|Damascus|UN|MİT|Netanyahu|Kozinoğlu)\b/;
const LABEL_SOURCE_RE = /^blind-v2guide-A-\d{4}-\d{2}-\d{2}$/;
const RULE_MARKERS = ["1) ", "2) ", "3) ", "4) "];
const FORBIDDEN_ARTICLE_KEYS = ["url", "category", "source", "source_slug", "jev"];

/**
 * Held-out selection (090, pitfall #1): excludes every `opus_seed`-stratum
 * gold row AND any article that already has a provisional label -- because
 * jev_gold_import_provisional() is ON CONFLICT DO NOTHING per article, so
 * the 4 original-gold articles with an existing Opus label can never take a
 * blind label. Asserts (throws) if the resulting set still overlaps
 * provisionalIds, as a self-check against a caller bug.
 *
 * @param {Array<{article_id: string, stratum: string}>} goldRows
 * @param {Iterable<string>} provisionalIds
 */
export function selectHeldout(goldRows, provisionalIds) {
  const provisional = new Set(provisionalIds);
  const heldout = goldRows.filter((r) => r.stratum !== "opus_seed" && !provisional.has(r.article_id));
  for (const row of heldout) {
    if (provisional.has(row.article_id)) {
      throw new Error(`selectHeldout: ${row.article_id} still has a provisional label`);
    }
  }
  return heldout;
}

/**
 * Builds the blind-label prompt for one article: the guide text plus the
 * title/description, with an explicit JSON answer shape. Throws if the
 * article object carries any field that could deanonymize the source
 * (url/category/source/source_slug/jev*) -- the whole point of the blind
 * pass is that the labeller (human or model) never sees the regex/Jev
 * answer before adjudicating.
 *
 * @param {string} guideText
 * @param {{title: string, description: string|null, [k: string]: unknown}} article
 */
export function buildBlindPrompt(guideText, article) {
  if (article === null || typeof article !== "object") {
    throw new Error("buildBlindPrompt: article must be an object");
  }
  for (const key of Object.keys(article)) {
    if (FORBIDDEN_ARTICLE_KEYS.includes(key) || key.startsWith("jev")) {
      throw new Error(`buildBlindPrompt: article must not carry '${key}'`);
    }
  }
  const { title, description } = article;
  if (typeof title !== "string") {
    throw new Error("buildBlindPrompt: article.title must be a string");
  }
  const prompt = [
    guideText,
    "",
    `Başlık: ${title}`,
    `Özet: ${description ?? "(yok)"}`,
    "",
    'JSON olarak yanıt ver: {"is_politics": boolean, "topic": "politika"|"dunya"|"ekonomi"|"spor"|"yasam"|"teknoloji"|"genel"}',
  ].join("\n");
  return { title, description: description ?? null, prompt };
}

/**
 * Parses one blind-label answer. Throws on a non-boolean is_politics or a
 * topic outside the 7-label vocabulary. Accepts either a JSON string or an
 * already-parsed object.
 */
export function parseBlindAnswer(raw) {
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (obj === null || typeof obj !== "object") {
    throw new Error("parseBlindAnswer: expected an object");
  }
  const { is_politics: isPolitics, topic } = obj;
  if (typeof isPolitics !== "boolean") {
    throw new Error("parseBlindAnswer: is_politics must be a boolean");
  }
  if (!JEV_TOPIC7_CHOICES_ORDER.includes(topic)) {
    throw new Error(`parseBlindAnswer: topic '${topic}' is not one of the 7 labels`);
  }
  return { is_politics: isPolitics, topic };
}

/**
 * Renders the SQL that imports a batch of adjudicated blind labels via
 * jev_gold_import_provisional(), wrapped in begin/commit. Deterministic:
 * rows are sorted by article_id before the payload is built, so the same
 * input always produces byte-identical SQL. Throws if labelSource doesn't
 * match the required pattern, or if the JSON payload would contain the
 * `$blind$` dollar-quote delimiter (which would break the emitted SQL).
 *
 * @param {Array<{article_id: string, is_politics: boolean, topic: string}>} rows
 * @param {{labelSource: string}} opts
 */
export function renderBlindImportSql(rows, { labelSource }) {
  if (!LABEL_SOURCE_RE.test(labelSource)) {
    throw new Error(`renderBlindImportSql: labelSource '${labelSource}' does not match ${LABEL_SOURCE_RE}`);
  }
  const sorted = [...rows].sort((a, b) => (a.article_id < b.article_id ? -1 : a.article_id > b.article_id ? 1 : 0));
  const payload = JSON.stringify(
    sorted.map((r) => ({ article_id: r.article_id, is_politics: r.is_politics, topic: r.topic })),
  );
  if (payload.includes("$blind$")) {
    throw new Error("renderBlindImportSql: payload contains the $blind$ delimiter");
  }
  const escapedLabelSource = labelSource.replace(/'/g, "''");
  return [
    "begin;",
    `select * from public.jev_gold_import_provisional($blind$${payload}$blind$::jsonb, '${escapedLabelSource}', 'heldout');`,
    "commit;",
    "",
  ].join("\n");
}

/**
 * Validates a candidate v2 topic7 question (instructions + criteria) before
 * it can ever be sent to the gate run: criteria keys must equal the 7-label
 * vocabulary in order, the combined text must fit the 2,800-char budget,
 * the four numbered rule markers must appear in order in instructions, and
 * no gold-item name may leak into the prompt (which would let the model
 * memorize the answer instead of applying the rule).
 *
 * @param {{instructions: string, criteria: Record<string,string>}} q
 * @param {readonly string[]} choices
 */
export function validateV2Question(q, choices) {
  const errors = [];
  if (q === null || typeof q !== "object") {
    return { ok: false, errors: ["question must be an object"] };
  }
  const { instructions, criteria } = q;
  if (typeof instructions !== "string") errors.push("instructions must be a string");
  if (criteria === null || typeof criteria !== "object") errors.push("criteria must be an object");

  if (criteria && typeof criteria === "object") {
    const keys = Object.keys(criteria);
    if (JSON.stringify(keys) !== JSON.stringify([...choices])) {
      errors.push(`criteria keys ${JSON.stringify(keys)} must equal ${JSON.stringify(choices)} in order`);
    }
  }

  if (typeof instructions === "string" && criteria && typeof criteria === "object") {
    const totalChars = instructions.length + JSON.stringify(criteria).length;
    if (totalChars > 2800) {
      errors.push(`instructions + JSON(criteria) is ${totalChars} chars, over the 2,800 budget`);
    }

    let cursor = -1;
    for (const marker of RULE_MARKERS) {
      const idx = instructions.indexOf(marker, cursor + 1);
      if (idx === -1 || idx <= cursor) {
        errors.push(`rule marker '${marker.trim()}' missing or out of order`);
        break;
      }
      cursor = idx;
    }

    const haystacks = [instructions, ...Object.values(criteria)];
    for (const text of haystacks) {
      if (typeof text === "string" && GOLD_STRING_RE.test(text)) {
        errors.push(`gold string leaked into the prompt: ${text.match(GOLD_STRING_RE)?.[0]}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Wilson score interval (95%, z = 1.959963984540054) for k successes in n trials. */
export function wilson(k, n) {
  if (n <= 0) return { lower: 0, center: 0, upper: 0 };
  const z = 1.959963984540054;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, center - margin), center, upper: Math.min(1, center + margin) };
}

function binomCoeff(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/**
 * Exact two-sided McNemar test (binomial form) on the two off-diagonal
 * discordant-pair counts b, c. p = 2 * P(X <= min(b,c)) under X ~
 * Binomial(b + c, 0.5), capped at 1.
 */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let cdf = 0;
  for (let i = 0; i <= k; i++) {
    cdf += binomCoeff(n, i) * Math.pow(0.5, n);
  }
  return Math.min(1, 2 * cdf);
}

/**
 * Reweights a per-category accuracy map by a target category mix (e.g. the
 * live 7-day feed-category shares), so the held-out gate's 38-per-category
 * stratified sample doesn't over- or under-represent a category relative
 * to production traffic.
 *
 * @param {Record<string, {correct: number, n: number} | number>} perCategoryAcc
 * @param {Record<string, number>} mix
 */
export function reweight(perCategoryAcc, mix) {
  let num = 0;
  let den = 0;
  for (const [category, weight] of Object.entries(mix)) {
    const acc = perCategoryAcc[category];
    if (acc === undefined || acc === null) continue;
    const rate = typeof acc === "number" ? acc : acc.n > 0 ? acc.correct / acc.n : 0;
    num += weight * rate;
    den += weight;
  }
  return den > 0 ? num / den : null;
}

/**
 * Evaluates the lead's 7 held-out gate conditions. Returns
 * { pass, checks: [{ id, ok, value, bar }] } -- one entry per numbered
 * condition, in order, so a caller can print exactly which bar failed.
 * Never throws on well-formed input; a missing/malformed section simply
 * fails that check (value = null) rather than crashing scoring.
 */
export function evaluateGate(input) {
  const checks = [];

  // 1. held-out v2 - v1 >= +3.0pt after reweight, AND McNemar p < 0.05
  {
    const heldout = input?.heldout ?? {};
    const v1Reweighted =
      heldout.v1PerCategory && heldout.mix ? reweight(heldout.v1PerCategory, heldout.mix) : null;
    const v2Reweighted =
      heldout.v2PerCategory && heldout.mix ? reweight(heldout.v2PerCategory, heldout.mix) : null;
    const gainPt = v1Reweighted !== null && v2Reweighted !== null ? (v2Reweighted - v1Reweighted) * 100 : null;
    const p = typeof heldout.b === "number" && typeof heldout.c === "number" ? mcnemarExact(heldout.b, heldout.c) : null;
    const ok = gainPt !== null && p !== null && gainPt >= 3.0 && p < 0.05;
    checks.push({ id: "1", ok, value: { gainPt, p }, bar: "gain >= +3.0pt (reweighted) and mcnemar p < 0.05" });
  }

  // 2. dev v2 >= v1 against the Opus labels
  {
    const dev = input?.dev ?? {};
    const ok = typeof dev.v1Acc === "number" && typeof dev.v2Acc === "number" && dev.v2Acc >= dev.v1Acc;
    checks.push({ id: "2", ok, value: { v1Acc: dev.v1Acc ?? null, v2Acc: dev.v2Acc ?? null }, bar: "dev v2 >= v1" });
  }

  // 3. held-out politika |share(v2) - gold| <= 5pt, AND precision(v2) >= precision(v1) - 3pt
  {
    const politika = input?.politika ?? {};
    const shareDiffPt =
      typeof politika.heldoutShareV2 === "number" && typeof politika.goldShare === "number"
        ? Math.abs(politika.heldoutShareV2 - politika.goldShare) * 100
        : null;
    const precisionOk =
      typeof politika.precisionV2 === "number" && typeof politika.precisionV1 === "number"
        ? politika.precisionV2 * 100 >= politika.precisionV1 * 100 - 3
        : false;
    const ok = shareDiffPt !== null && shareDiffPt <= 5 && precisionOk;
    checks.push({
      id: "3",
      ok,
      value: { shareDiffPt, precisionV1: politika.precisionV1 ?? null, precisionV2: politika.precisionV2 ?? null },
      bar: "politika |share(v2)-gold| <= 5pt and precision(v2) >= precision(v1) - 3pt",
    });
  }

  // 4. dunya recall(v2) >= recall(v1) - 5pt, AND |genel share(v2) - gold| <= 5pt
  {
    const dunya = input?.dunya ?? {};
    const genel = input?.genel ?? {};
    const recallOk =
      typeof dunya.recallV1 === "number" && typeof dunya.recallV2 === "number"
        ? dunya.recallV2 * 100 >= dunya.recallV1 * 100 - 5
        : false;
    const genelDiffPt =
      typeof genel.shareV2 === "number" && typeof genel.goldShare === "number"
        ? Math.abs(genel.shareV2 - genel.goldShare) * 100
        : null;
    const ok = recallOk && genelDiffPt !== null && genelDiffPt <= 5;
    checks.push({
      id: "4",
      ok,
      value: { recallV1: dunya.recallV1 ?? null, recallV2: dunya.recallV2 ?? null, genelDiffPt },
      bar: "dunya recall(v2) >= recall(v1) - 5pt and |genel share(v2)-gold| <= 5pt",
    });
  }

  // 5. held-out p>=0.8 slice: accuracy >= 90% with coverage >= 65%
  {
    const p080 = input?.p080 ?? {};
    const ok =
      typeof p080.accuracy === "number" &&
      typeof p080.coverage === "number" &&
      p080.accuracy >= 0.9 &&
      p080.coverage >= 0.65;
    checks.push({
      id: "5",
      ok,
      value: { accuracy: p080.accuracy ?? null, coverage: p080.coverage ?? null },
      bar: "p>=0.8 slice accuracy >= 90% with coverage >= 65%",
    });
  }

  // 6. pack stability: politics@0.5, topic, clickbait and framing each flip <= 3%
  {
    const stability = input?.packStability ?? {};
    const keys = ["politics50Flip", "topicFlip", "clickbaitFlip", "framingFlip"];
    const values = keys.map((k) => stability[k]);
    const ok = values.every((v) => typeof v === "number" && v <= 0.03);
    checks.push({
      id: "6",
      ok,
      value: Object.fromEntries(keys.map((k, i) => [k, values[i] ?? null])),
      bar: "each pack flip rate <= 3%",
    });
  }

  // 7. mean input tokens v2 - v1 <= +700
  {
    const tokens = input?.tokens ?? {};
    const diff =
      typeof tokens.meanV1 === "number" && typeof tokens.meanV2 === "number" ? tokens.meanV2 - tokens.meanV1 : null;
    const ok = diff !== null && diff <= 700;
    checks.push({ id: "7", ok, value: { diff }, bar: "mean input tokens v2 - v1 <= +700" });
  }

  return { pass: checks.every((c) => c.ok), checks };
}
