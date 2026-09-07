#!/usr/bin/env node
// scripts/gen-audit-fixture.mjs
//
// Writes tests/fixtures/clusters-sample.json — a deterministic synthetic
// corpus that scripts/lib/audit/report.test.mjs pins golden summary numbers
// against. Regenerate with `node scripts/gen-audit-fixture.mjs` (the file is
// committed; regenerating and re-running the tests should be a no-op unless
// this generator changes).
//
// Seeded PRNG (mulberry32): the same seed always produces the same corpus,
// byte for byte, so the golden numbers never drift across machines/runs.
//
// ~300 articles over ~80 clusters from 40 sources, built from Turkish
// political headline templates. On top of the otherwise-clean corpus, a
// handful of DELIBERATE quality issues are injected so every probe
// computeReport() runs has something real to find:
//   - a few multi-member clusters get one topically-mismatched article
//     glued in (precision probe: over-merging / entity-glue)
//   - a few near-duplicate stories are kept as separate clusters
//     (recall probe: under-merging / fragmentation)
//   - two >=5-member clusters get an is_blindspot flag that deliberately
//     disagrees with detectBlindspot(bias_distribution) (blindspot probe)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { fingerprint } from "./lib/cluster/fingerprint.mjs";
import { extractEntities } from "./lib/cluster/entities.mjs";
import { detectBlindspot } from "./lib/cluster/blindspot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "..", "tests", "fixtures", "clusters-sample.json");

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

const SEED = 20260908;
function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t |= 0;
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));

// ---------------------------------------------------------------------------
// Sources — 40 total, weighted across the bias-zone contract's 10 categories.
// ---------------------------------------------------------------------------

const BIAS_WEIGHTS = [
  ["pro_government", 6], ["gov_leaning", 4], ["state_media", 2],
  ["center", 5], ["opposition_leaning", 5], ["opposition", 6],
  ["nationalist", 3], ["islamist_conservative", 3], ["pro_kurdish", 3],
  ["international", 3],
]; // sums to 40

const sources = [];
{
  let n = 1;
  for (const [bias, count] of BIAS_WEIGHTS) {
    for (let i = 0; i < count; i++) {
      const slug = `${bias.replace(/_/g, "-")}-${i + 1}`;
      sources.push({ id: `src-${String(n).padStart(2, "0")}`, slug, name: slug, bias, active: true });
      n++;
    }
  }
}

const START = Date.parse("2026-09-06T06:00:00.000Z");
const tsAt = (hoursOffset) => new Date(START + hoursOffset * 3_600_000).toISOString();

// ---------------------------------------------------------------------------
// Story templates — each is a small family of Turkish headline variants that
// share a fixed entity core, so intra-cluster entity/TF-IDF overlap is high
// by construction, plus a `{detail}` slot for per-article wording variety.
// ---------------------------------------------------------------------------

const TEMPLATES = [
  { entities: ["erdogan", "akp", "ankara"], variants: (d) => [
    `Cumhurbaşkanı Erdoğan Ankara'da ${d} açıklamalarda bulundu`,
    `Erdoğan, AKP grup toplantısında ${d} konuştu`,
    `AKP lideri Erdoğan Ankara'da ${d} mesajı verdi`,
  ] },
  { entities: ["kilicdaroglu", "chp", "istanbul"], variants: (d) => [
    `CHP lideri Kılıçdaroğlu İstanbul'da ${d} açıklama yaptı`,
    `Kılıçdaroğlu, CHP il binasında ${d} konuştu`,
    `CHP'den İstanbul'da ${d} çıkışı geldi`,
  ] },
  { entities: ["tcmb", "faiz", "enflasyon"], variants: (d) => [
    `TCMB faiz kararını açıkladı: ${d} adım`,
    `Merkez Bankası enflasyon raporunda ${d} uyarısı yaptı`,
    `TCMB'den faiz ve enflasyon konusunda ${d} açıklama`,
  ] },
  { entities: ["mhp", "bahceli", "meclis"], variants: (d) => [
    `MHP lideri Bahçeli Meclis'te ${d} konuştu`,
    `Bahçeli'den Meclis kürsüsünde ${d} sözler`,
    `MHP grubunda ${d} bir tartışma yaşandı`,
  ] },
  { entities: ["imamoglu", "istanbul", "chp"], variants: (d) => [
    `İBB Başkanı İmamoğlu ${d} bir projeyi açıkladı`,
    `İmamoğlu, İstanbul'da ${d} bir konuda konuştu`,
    `CHP'li İmamoğlu'ndan ${d} açıklama geldi`,
  ] },
  { entities: ["disisleri", "abd", "rusya"], variants: (d) => [
    `Dışişleri Bakanlığı'ndan ${d} açıklama`,
    `Türkiye'den ABD ve Rusya'ya ${d} mesaj`,
    `Dışişleri'nden ${d} bir konuda flaş açıklama`,
  ] },
  { entities: ["dem", "hdp", "diyarbakir"], variants: (d) => [
    `DEM Parti Diyarbakır'da ${d} açıklaması yaptı`,
    `DEM'den Diyarbakır'da ${d} bir çıkış geldi`,
    `Diyarbakır'da DEM Parti ${d} bir açıklama yaptı`,
  ] },
  { entities: ["ysk", "secim", "izmir"], variants: (d) => [
    `YSK İzmir'deki seçimle ilgili ${d} kararını açıkladı`,
    `Seçim Kurulu'ndan İzmir için ${d} karar geldi`,
    `İzmir'de YSK ${d} bir açıklama yaptı`,
  ] },
  { entities: ["tsk", "suriye", "sanliurfa"], variants: (d) => [
    `TSK Şanlıurfa sınırında ${d} bir operasyon düzenledi`,
    `Türk Silahlı Kuvvetleri'nden Suriye sınırında ${d} hareket`,
    `Şanlıurfa'da TSK ${d} bir açıklama yaptı`,
  ] },
  { entities: ["ozel", "chp", "bursa"], variants: (d) => [
    `CHP Genel Başkanı Özel Bursa'da ${d} konuştu`,
    `Özgür Özel'den Bursa'da ${d} çıkış geldi`,
    `CHP'li Özel Bursa mitinginde ${d} bir açıklama yaptı`,
  ] },
  { entities: ["danistay", "adalet", "yargitay"], variants: (d) => [
    `Danıştay'dan ${d} bir karar çıktı`,
    `Yargıtay ${d} davasında karar verdi`,
    `Adalet Bakanlığı'ndan ${d} bir açıklama geldi`,
  ] },
  { entities: ["afad", "deprem", "kayseri"], variants: (d) => [
    `AFAD Kayseri'de ${d} bir tatbikat düzenledi`,
    `Kayseri'de AFAD'dan ${d} açıklama geldi`,
    `AFAD'dan deprem bölgesinde ${d} bir uyarı`,
  ] },
  { entities: ["diyanet", "ramazan", "cami"], variants: (d) => [
    `Diyanet İşleri Başkanlığı'ndan ${d} açıklama`,
    `Diyanet'ten Ramazan öncesi ${d} bir duyuru`,
    `Camilerde ${d} bir uygulama başladı`,
  ] },
  { entities: ["bist", "borsa", "dolar"], variants: (d) => [
    `Borsa İstanbul'da ${d} bir hareketlilik yaşandı`,
    `BIST100'de dolar ve ${d} etkisi görüldü`,
    `Borsa'da ${d} sonrası sert hareket`,
  ] },
];

const DETAILS = [
  "önemli", "flaş", "kritik", "sürpriz", "beklenen", "yeni", "sert",
  "dikkat çeken", "tartışmalı", "gündem yaratan",
];

// ---------------------------------------------------------------------------
// Article builder
// ---------------------------------------------------------------------------

let articleSeq = 1;
function makeArticle({ title, description, entities, hoursOffset, source }) {
  const id = `art-${String(articleSeq).padStart(4, "0")}`;
  articleSeq++;
  const fp = fingerprint(title, description);
  const ents = entities?.length ? entities.slice() : extractEntities(`${title} ${description}`) || [];
  return {
    id,
    source_id: source.id,
    title,
    description,
    published_at: tsAt(hoursOffset),
    fingerprint: fp.strict,
    entities: ents,
    category: rand() < 0.5 ? "politika" : "son_dakika",
  };
}

// ---------------------------------------------------------------------------
// 1. Main corpus — 80 clean-by-construction clusters.
// ---------------------------------------------------------------------------

const TARGET_CLUSTERS = 80;
const UNASSIGNED_COUNT = 40;
// Cluster-size distribution (weights sum to 1.0). Skewed small, a long tail
// of bigger clusters — matches the shape audit-clusters.mjs's size histogram
// is built to describe.
const SIZE_WEIGHTS = [
  [1, 0.30], [2, 0.25], [3, 0.15], [4, 0.10], [5, 0.08], [7, 0.05], [8, 0.04], [12, 0.03],
];
function sampleClusterSize() {
  let r = rand();
  for (const [size, w] of SIZE_WEIGHTS) {
    if (r < w) return size;
    r -= w;
  }
  return SIZE_WEIGHTS[SIZE_WEIGHTS.length - 1][0];
}

const articles = [];
const links = [];
const clustersMeta = []; // { id, memberIds, template } — generation-time bookkeeping

for (let c = 0; c < TARGET_CLUSTERS; c++) {
  const clusterId = `cl-${String(c + 1).padStart(3, "0")}`;
  const template = TEMPLATES[c % TEMPLATES.length];
  const size = sampleClusterSize();
  const baseHour = int(0, 44); // leaves room for the cluster's member spread inside the 48h window

  const memberIds = [];
  for (let m = 0; m < size; m++) {
    const detail = pick(DETAILS);
    const variants = template.variants(detail);
    const title = pick(variants);
    const description = `${title} Detaylar haberimizde.`;
    const source = pick(sources);
    const hoursOffset = baseHour + m * 0.5 + rand() * 0.5;
    const a = makeArticle({ title, description, entities: template.entities, hoursOffset, source });
    articles.push(a);
    memberIds.push(a.id);
    links.push({ cluster_id: clusterId, article_id: a.id });
  }
  clustersMeta.push({ id: clusterId, memberIds, template });
}

// ---------------------------------------------------------------------------
// 2. Unassigned articles — genuinely un-clustered noise (no link row).
// ---------------------------------------------------------------------------

for (let u = 0; u < UNASSIGNED_COUNT; u++) {
  const template = pick(TEMPLATES);
  const detail = pick(DETAILS);
  const title = pick(template.variants(detail));
  const description = `${title} Detaylar haberimizde.`;
  const source = pick(sources);
  const hoursOffset = int(0, 47);
  articles.push(makeArticle({ title, description, entities: template.entities, hoursOffset, source }));
}

const articlesById = new Map(articles.map((a) => [a.id, a]));

// ---------------------------------------------------------------------------
// 3. Precision-probe fodder: glue one topically-mismatched article into a
//    handful of multi-member clusters (over-merging / entity-glue example).
// ---------------------------------------------------------------------------

const MISMATCH_COUNT = 4;
const mismatchTargets = clustersMeta.filter((c) => c.memberIds.length >= 3).slice(0, MISMATCH_COUNT);
for (const c of mismatchTargets) {
  const targetId = c.memberIds[c.memberIds.length - 1];
  const target = articlesById.get(targetId);
  const otherTemplate = TEMPLATES[(TEMPLATES.indexOf(c.template) + 5) % TEMPLATES.length];
  const title = pick(otherTemplate.variants(pick(DETAILS)));
  const description = `${title} Detaylar haberimizde.`;
  const fp = fingerprint(title, description);
  // Mutate in place — same id/source/cluster link, unrelated content. The
  // published_at is left untouched so the low score comes from topical
  // mismatch, not from time decay.
  target.title = title;
  target.description = description;
  target.entities = otherTemplate.entities.slice();
  target.fingerprint = fp.strict;
}

// ---------------------------------------------------------------------------
// 4. Recall-probe fodder: clone a donor cluster's story into a receiver
//    cluster under a different cluster_id (fragmentation example).
// ---------------------------------------------------------------------------

const NEAR_DUP_PAIRS = 3;
const donors = clustersMeta.slice(10, 10 + NEAR_DUP_PAIRS);
const receivers = clustersMeta.slice(30, 30 + NEAR_DUP_PAIRS);
for (let i = 0; i < NEAR_DUP_PAIRS; i++) {
  const donor = donors[i];
  const receiver = receivers[i];
  const donorArticle = articlesById.get(donor.memberIds[0]);
  const title = pick(donor.template.variants(pick(DETAILS)));
  const description = `${title} Detaylar haberimizde.`;
  const source = pick(sources);
  const hoursOffset = (Date.parse(donorArticle.published_at) - START) / 3_600_000 + (rand() - 0.5);
  const clone = makeArticle({ title, description, entities: donor.template.entities, hoursOffset, source });
  articles.push(clone);
  articlesById.set(clone.id, clone);
  links.push({ cluster_id: receiver.id, article_id: clone.id });
}

// ---------------------------------------------------------------------------
// 5. Blindspot fields — tally each cluster's real member bias distribution,
//    then deliberately flip is_blindspot on two eligible (>=5 member)
//    clusters so blindspot_flip_rate has something real to catch.
// ---------------------------------------------------------------------------

const bySourceId = new Map(sources.map((s) => [s.id, s]));
const memberIdsByClusterFinal = new Map();
for (const link of links) {
  const list = memberIdsByClusterFinal.get(link.cluster_id) || [];
  list.push(link.article_id);
  memberIdsByClusterFinal.set(link.cluster_id, list);
}

const clusterBlindspotFields = new Map(); // cluster_id -> { is_blindspot, bias_distribution }
const flipEligible = [];
for (const [clusterId, memberIds] of memberIdsByClusterFinal.entries()) {
  const dist = {};
  for (const id of memberIds) {
    const src = bySourceId.get(articlesById.get(id).source_id);
    if (!src) continue;
    dist[src.bias] = (dist[src.bias] || 0) + 1;
  }
  const predicted = detectBlindspot(dist).is_blindspot;
  clusterBlindspotFields.set(clusterId, { is_blindspot: predicted, bias_distribution: dist });
  if (memberIds.length >= 5) flipEligible.push(clusterId);
}

const FLIP_COUNT = Math.min(2, flipEligible.length);
for (let i = 0; i < FLIP_COUNT; i++) {
  const fields = clusterBlindspotFields.get(flipEligible[i]);
  fields.is_blindspot = !fields.is_blindspot;
}

for (const link of links) {
  const fields = clusterBlindspotFields.get(link.cluster_id);
  link.is_blindspot = fields.is_blindspot;
  link.bias_distribution = fields.bias_distribution;
}

// ---------------------------------------------------------------------------
// 6. Write the fixture.
// ---------------------------------------------------------------------------

const fixture = {
  seed: SEED,
  note: "Deterministic synthetic corpus — regenerate with `node scripts/gen-audit-fixture.mjs`.",
  sources,
  articles,
  links,
};

writeFileSync(OUT_PATH, `${JSON.stringify(fixture, null, 2)}\n`);

console.log(`wrote ${OUT_PATH}`);
console.log(`  sources:    ${sources.length}`);
console.log(`  articles:   ${articles.length}`);
console.log(`  clusters:   ${memberIdsByClusterFinal.size}`);
console.log(`  unassigned: ${articles.length - links.length}`);
console.log(`  flipped blindspot clusters: ${FLIP_COUNT}`);
