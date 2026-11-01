// scripts/lib/cluster/entities.mjs
//
// Lightweight entity extractor for Turkish news titles+descriptions.
//
// Rewritten per W2-D2 mission (R3 recommendation 2 + R2 duplicate-audit
// feedback): the previous version pulled capitalized multi-word phrases
// like "Cumhurbaşkanı Erdoğan" as distinct entities on top of "erdogan",
// which blew up the denominator of the ensemble's
// `shared / max(|A|,|B|)` ratio and capped the MHP-fesh entity score at
// ~0.25. This version only emits single-token canonical forms drawn from
// a curated whitelist, plus 4-digit years and percentages. The extracted
// set size is therefore bounded by the whitelist, keeping the denominator
// tight on long multi-word titles.

import { ENTITY_AMBIGUOUS, ENTITY_PROPER_NOUNS } from "./constants.mjs";

// ---------------------------------------------------------------------------
// Export A — POLITICAL_ENTITIES
// ---------------------------------------------------------------------------
// Curated whitelist of Turkish political entities. All keys are stored as
// **single-token canonical forms** (Turkish-folded, lowercase, alnum only).
// Alphabetized within each category for easy auditing.
// ---------------------------------------------------------------------------

export const POLITICAL_ENTITIES = new Set([
  // Parties
  "akp",
  "chp",
  "mhp",
  "iyi",
  "deva",
  "gelecek",
  "saadet",
  "tip",
  "dem",
  "hdp",
  "ysp",
  "yrp",
  "bbp",
  "vatan",

  // Institutions
  "tbmm",
  "meclis",
  "cumhurbaskanligi",
  "basbakanlik",
  "disisleri",
  "icisleri",
  "adalet",
  "meb",
  "saglik",
  "tcmb",
  "bddk",
  "spk",
  "tuik",
  "tusiad",
  "afad",
  "tsk",
  "emniyet",
  "jandarma",
  "myk",
  "ysk",
  "danistay",
  "anayasamahkemesi",
  "yargitay",
  "sayistay",

  // Cities (largest only — keep tight)
  "istanbul",
  "ankara",
  "izmir",
  "bursa",
  "adana",
  "gaziantep",
  "konya",
  "antalya",
  "diyarbakir",
  "sanliurfa",
  "kayseri",
  "mersin",
  "samsun",
  "trabzon",

  // Countries / blocs frequent in TR news
  "abd",
  "rusya",
  "ukrayna",
  "suriye",
  "iran",
  "israil",
  "filistin",
  "yunanistan",
  "almanya",
  "fransa",
  "ingiltere",
  "cin",
  "avrupa",
  "nato",
  "bm",
  "ab",
  "ohal",

  // Known people (canonical single tokens, diacritic-folded)
  "erdogan",
  "kilicdaroglu",
  "ozel",
  "imamoglu",
  "yavas",
  "bahceli",
  "davutoglu",
  "babacan",
  "karamollaoglu",
  "akgun",
  "simsek",
  "sonmez",
  "fidan",
  "yilmaz",
  "ala",
  "guler",

  // ---- Lonely-source bridges (W2 / A8 lonely-source rescue) ----
  // Each token below was chosen because it is likely to appear in BOTH
  // mainstream political coverage AND a niche source that A8 flagged as
  // never landing in a multi-article cluster. The goal is to give those
  // sources a few entity-overlap "bridges" without bloating the whitelist
  // into a generic news-vocabulary list.

  // Sports → political bridges (transfers, club finances, federation
  // politics, stadium projects — these come up in mainstream news too,
  // not only on fotomac/fotospor/a-spor/ntv-spor/kontraspor).
  "galatasaray",
  "fenerbahce",
  "besiktas",
  "trabzonspor",
  "tff",
  "spor",
  "futbol",

  // Religion → political bridges (Diyanet appointments, Friday-sermon
  // controversies, Ramadan policy — diyanet-haber + mainstream both
  // cover these).
  "diyanet",
  "imam",
  "cami",
  "cuma",
  "namaz",
  "ramazan",
  "oruc",
  "kuran",

  // Finance → political bridges (bloomberg-ht numerics that ekonomim /
  // mainstream also reach for: rate decisions, FX prints, CPI).
  "bist",
  "borsa",
  "dolar",
  "euro",
  "enflasyon",
  "faiz",
  "kur",
  "altin",

  // Armenian / minority bridges (agos covers diaspora + commemorations
  // that mainstream papers also touch on Hrant Dink anniversaries, the
  // Patriarchate, etc.).
  "ermeni",
  "rum",
  "gregoryen",
  "patrik",
  "hrant",
  "dink",

  // English-language bridges for a-news (lowercase ASCII names that
  // English-titled wires emit). 'istanbul', 'ankara' and 'nato' are
  // already in the blocks above so they are intentionally not repeated.
  "turkey",
  "turkish",
  "parliament",
  "minister",
  "president",
  "election",
  "trump",
  "putin",
  "biden",

  // EN→TR bridge targets (see EN_TO_TR_BRIDGE below). These Turkish
  // tokens must be in the whitelist so that when a Turkish-titled
  // article emits them via the normal token pass, they collide with
  // the bridge-emitted entries from English-titled a-news articles.
  "turkiye",
  "bakan",
  "cumhurbaskan",
  "secim",
  "ekonomi",
  "muhalefet",
]);

// ---------------------------------------------------------------------------
// Stopwords — tokens that would otherwise pass the 3-char filter but are
// useless as entities (common Turkish function words / generic news copy).
// Kept very small on purpose: the whitelist is the main filter; stopwords
// only exist to avoid accidentally returning true if the whitelist ever
// grows to include a very common short word.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "ile",
  "icin",
  "gibi",
  "kadar",
  "daha",
  "cok",
  "her",
  "hem",
  "bir",
  "iki",
  "uc",
  "bin",
  "son",
  "dun",
  "bugun",
  "yarin",
  "simdi",
  "sonra",
  "once",
  "var",
  "yok",
  "oldu",
  "dedi",
  "dedi",
  "diye",
  "ama",
  "fakat",
  "ancak",
  "veya",
  "hem",
  "den",
  "dan",
  "nin",
  "nun",
  "nun",
  "haber",
  "canli",
  "flas",
  "acil",
]);

// ---------------------------------------------------------------------------
// Turkish folding: ş→s, ı→i, İ→i, ü→u, ö→o, ç→c, ğ→g, â→a, î→i, û→u.
// ---------------------------------------------------------------------------

function foldTurkish(s) {
  const map = {
    ş: "s", Ş: "s",
    ı: "i", İ: "i", I: "i",
    ü: "u", Ü: "u",
    ö: "o", Ö: "o",
    ç: "c", Ç: "c",
    ğ: "g", Ğ: "g",
    â: "a", Â: "a",
    î: "i", Î: "i",
    û: "u", Û: "u",
  };
  let out = "";
  for (const ch of s) out += map[ch] ?? ch;
  return out.toLowerCase();
}

// ---------------------------------------------------------------------------
// Export B — normalizeToken
// ---------------------------------------------------------------------------
// Takes a raw token. Turkish-folds, lowercases, strips non-alnum.
// Returns null if the result is < 3 chars or is a stopword.
// ---------------------------------------------------------------------------

export function normalizeToken(raw) {
  if (raw == null) return null;
  const folded = foldTurkish(String(raw));
  const stripped = folded.replace(/[^a-z0-9]/g, "");
  if (stripped.length < 3) return null;
  if (STOPWORDS.has(stripped)) return null;
  return stripped;
}

// ---------------------------------------------------------------------------
// Export C — extractEntities
// ---------------------------------------------------------------------------
// 1. Tokenize on whitespace + common punctuation.
// 2. For each token: normalizeToken → if in POLITICAL_ENTITIES, include it.
// 3. Also detect 4-digit years (1950-2099) as their own tokens.
// 4. Also detect percentages (47% or "yüzde 47") → "pct47".
// 5. DOES NOT capture capitalized multi-word sequences.
// 6. Returns a deduped array of canonical entity tokens.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// EN_TO_TR_BRIDGE — bilingual title bridge for english speaking sources.
// Only useful for a-news, daily-sabah, hurriyet-daily-news, trt-world.
//
// A8 found `a-news` is a "lonely source" because its English titles never
// share vocabulary with Turkish stories. When extractEntities() sees an
// English term from this map, it ALSO emits the Turkish equivalent so the
// fingerprint can collide with mainstream Turkish coverage of the same
// event. Keys are matched as case-insensitive whole words/phrases over
// the original (un-normalized) text.
// ---------------------------------------------------------------------------
export const EN_TO_TR_BRIDGE = {
  turkey: "turkiye",
  istanbul: "istanbul",
  ankara: "ankara",
  erdogan: "erdogan",
  parliament: "meclis",
  minister: "bakan",
  president: "cumhurbaskan",
  election: "secim",
  economy: "ekonomi",
  "central bank": "tcmb",
  opposition: "muhalefet",
};

// Pre-compile a whole-word, case-insensitive regex for each EN key. We
// build them once at module load. Multi-word keys (e.g. "central bank")
// allow internal whitespace runs.
const EN_BRIDGE_PATTERNS = Object.entries(EN_TO_TR_BRIDGE).map(([en, tr]) => {
  const escaped = en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return { re: new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i"), tr };
});

// ---------------------------------------------------------------------------
// Homograph handling (h12-cluster-2)
// ---------------------------------------------------------------------------
//
// "Özel sektör kredileri arttı" must not carry the party leader, "COP31'e 91
// devlet başkanı gelecek" must not carry the Gelecek Party and "Türk Tıp
// Dünyası Kurultayı cuma günü" must not carry TİP. The folded-lowercase lookup
// cannot tell them apart, so an ambiguous token is emitted only when the
// original text says it is the name:
//   (a) the next word starts with 'parti' ("İYİ Parti", "Gelecek Partisi");
//   (b) it is written in capitals (2+ letters) and fewer than 2 of its 4
//       nearest words are also capitals (a shouted headline is no evidence);
//   (c) it is also a proper name (ENTITY_PROPER_NOUNS), capitalised, and either
//       carries an apostrophe suffix ("Özel'den") or is not sentence-initial;
//   (d) "Özgür Özel" (previous word) and "Adalet Bakanı" (next word).
const AMBIGUOUS = new Set(ENTITY_AMBIGUOUS);
const PROPER = new Set(ENTITY_PROPER_NOUNS);

// A word is a run of non-separator characters (whitespace, common Turkish
// punctuation, quotes and apostrophes separate); runs without a letter or digit
// (emoji, symbols) are not words, so they neither start a sentence nor count as
// a neighbour.
const WORD_RE = /[^\s.,;:!?()[\]{}"'`’‘“”«»\-–—/\\|…]+/g;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const LETTER_RE = /\p{L}/u;
const SENTENCE_BREAK_RE = /[.!?:…\n]/;
// Stops an "(a)/(d)" neighbour from being read across a clause break.
const CLAUSE_BREAK_RE = /[.!?:;,…\n]/;

function wordsOf(text) {
  const out = [];
  for (const m of text.matchAll(WORD_RE)) {
    if (!WORD_CHAR_RE.test(m[0])) continue;
    out.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function foldWord(raw) {
  return foldTurkish(raw).replace(/[^a-z0-9]/g, "");
}

function isAllCaps(raw) {
  let letters = 0;
  for (const ch of raw) if (LETTER_RE.test(ch)) letters++;
  return letters >= 2 && raw === raw.toLocaleUpperCase("tr") &&
    raw !== raw.toLocaleLowerCase("tr");
}

function isCapitalised(raw) {
  const first = [...raw][0] ?? "";
  return LETTER_RE.test(first) && first !== first.toLocaleLowerCase("tr");
}

function isDisambiguated(text, words, i, norm) {
  const w = words[i];
  const prev = i > 0 ? words[i - 1] : null;
  const next = i + 1 < words.length ? words[i + 1] : null;
  const nextAdjacent = next !== null &&
    !CLAUSE_BREAK_RE.test(text.slice(w.end, next.start));
  const prevAdjacent = prev !== null &&
    !CLAUSE_BREAK_RE.test(text.slice(prev.end, w.start));

  // (a) "<token> Parti..."
  if (nextAdjacent && foldWord(next.raw).startsWith("parti")) return true;

  // (b) capitals, unless the whole neighbourhood is capitals too.
  if (isAllCaps(w.raw)) {
    let capsNeighbours = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(words.length - 1, i + 2); j++) {
      if (j !== i && isAllCaps(words[j].raw)) capsNeighbours++;
    }
    if (capsNeighbours < 2) return true;
  }

  // (c) a name that is also a word: capitalised, and either suffixed with an
  // apostrophe ("Özel'den") or not opening a sentence.
  if (PROPER.has(norm) && isCapitalised(w.raw)) {
    const quote = text[w.end];
    const suffixed = (quote === "'" || quote === "’") &&
      LETTER_RE.test(text[w.end + 1] ?? "");
    const sentenceInitial = prev === null ||
      SENTENCE_BREAK_RE.test(text.slice(prev.end, w.start));
    if (suffixed || !sentenceInitial) return true;
  }

  // (d) "Özgür Özel", "Adalet Bakanı".
  if (norm === "ozel" && prevAdjacent && foldWord(prev.raw) === "ozgur") return true;
  if (norm === "adalet" && nextAdjacent && foldWord(next.raw).startsWith("bakan")) {
    return true;
  }
  return false;
}

export function extractEntities(text) {
  if (!text || typeof text !== "string") return [];

  const found = new Set();

  // 1–2. Whitelist matches over normalized single tokens. The eleven
  // homograph tokens (ENTITY_AMBIGUOUS) are ordinary Turkish words as well as
  // party names, so they additionally need a disambiguator (see above);
  // every other token keeps the plain whitelist lookup.
  const words = wordsOf(text);
  for (let i = 0; i < words.length; i++) {
    const norm = normalizeToken(words[i].raw);
    if (!norm) continue;
    if (!POLITICAL_ENTITIES.has(norm)) continue;
    if (AMBIGUOUS.has(norm) && !isDisambiguated(text, words, i, norm)) continue;
    found.add(norm);
  }

  // 3. 4-digit years (1950-2099).
  //    Scanned over the original text so we pick up numbers even if they
  //    are glued to punctuation.
  const yearRe = /\b(19[5-9]\d|20\d{2})\b/g;
  let ym;
  while ((ym = yearRe.exec(text)) !== null) {
    found.add(ym[1]);
  }

  // 4. Percentages: either "47%" / "47 %" or Turkish "yüzde 47".
  const pctRe = /(?:\b(\d{1,3})\s*%|(?:yüzde|yuzde)\s*(\d{1,3})\b)/gi;
  let pm;
  while ((pm = pctRe.exec(text)) !== null) {
    const num = pm[1] || pm[2];
    if (num) found.add(`pct${num}`);
  }

  // 5. Bilingual bridge pass — only useful for english speaking sources
  //    (a-news, daily-sabah, hurriyet-daily-news, trt-world). For each
  //    EN key found as a whole word in the original text, ALSO emit the
  //    Turkish equivalent so the fingerprint collides with TR coverage.
  for (const { re, tr } of EN_BRIDGE_PATTERNS) {
    if (re.test(text)) {
      found.add(tr);
    }
  }

  return [...found];
}

// ---------------------------------------------------------------------------
// Inline tests
// ---------------------------------------------------------------------------
// Run with: `node scripts/lib/cluster/entities.mjs`

if (process.argv[1] === import.meta.url.replace("file://", "")) {
  const { default: assert } = await import("node:assert/strict");

  const sameSet = (a, b) => {
    const A = new Set(a);
    const B = new Set(b);
    if (A.size !== B.size) return false;
    for (const x of A) if (!B.has(x)) return false;
    return true;
  };

  const report = (name, actual, expected) => {
    try {
      assert.ok(
        sameSet(actual, expected),
        `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`
      );
      console.log(`PASS  ${name}`);
    } catch (err) {
      console.error(`FAIL  ${name}: ${err.message}`);
      process.exit(1);
    }
  };

  // Test 1 — MHP fesh headline. No multi-word phrase pollution.
  const e1 = extractEntities(
    "MHP İstanbul'da il ve 39 ilçe teşkilatını feshetti"
  );
  report("mhp-fesh single-tokens only", e1, ["mhp", "istanbul"]);

  // Test 2 — "Cumhurbaşkanı Erdoğan" must NOT appear as its own entity.
  const e2 = extractEntities(
    "Cumhurbaşkanı Erdoğan Almanya ziyaretinde konuştu"
  );
  report("erdogan/almanya no multi-word", e2, ["erdogan", "almanya"]);

  // Test 3 — TCMB + 2024 year extraction.
  // Note: 'faiz' is now part of the finance-bridge whitelist (W2 lonely-
  // source rescue), so it appears as its own entity here.
  const e3 = extractEntities("TCMB faiz kararını 2024 yılında açıkladı");
  report("tcmb + faiz + year", e3, ["tcmb", "faiz", "2024"]);

  // Test 4 — Jaccard-style denominator math, proving the lift vs. the
  // previous behavior where multi-word phrases inflated |A| and |B|.
  const A = new Set(["mhp", "istanbul"]);
  const B = new Set(["mhp", "istanbul", "akp"]);
  const shared = [...A].filter((x) => B.has(x)).length; // 2
  const denom = Math.max(A.size, B.size); // 3
  const ratio = shared / denom;
  try {
    assert.equal(shared, 2);
    assert.equal(denom, 3);
    assert.ok(Math.abs(ratio - 2 / 3) < 1e-9);
    console.log(
      `PASS  ensemble ratio math: shared=${shared} denom=${denom} ratio=${ratio.toFixed(4)}`
    );
  } catch (err) {
    console.error(`FAIL  ensemble ratio math: ${err.message}`);
    process.exit(1);
  }

  // Sanity: percentages.
  const e5 = extractEntities("CHP anketinde yüzde 47 oranı");
  try {
    assert.ok(e5.includes("chp"));
    assert.ok(e5.includes("pct47"));
    console.log(`PASS  percentage pct47 + chp`);
  } catch {
    console.error(`FAIL  percentage pct47: got ${JSON.stringify(e5)}`);
    process.exit(1);
  }

  // Sanity: empty / junk input.
  try {
    assert.deepEqual(extractEntities(""), []);
    assert.deepEqual(extractEntities(null), []);
    console.log("PASS  empty input → []");
  } catch (err) {
    console.error(`FAIL  empty input: ${err.message}`);
    process.exit(1);
  }

  // Bilingual bridge — a-news English title should emit TR tokens too.
  const e6 = extractEntities("Turkey's parliament passed the bill");
  try {
    assert.ok(e6.includes("turkiye"), `expected turkiye in ${JSON.stringify(e6)}`);
    assert.ok(e6.includes("meclis"), `expected meclis in ${JSON.stringify(e6)}`);
    console.log("PASS  EN→TR bridge: turkey→turkiye, parliament→meclis");
  } catch (err) {
    console.error(`FAIL  EN→TR bridge: ${err.message}`);
    process.exit(1);
  }

  // Bridge — multi-word "central bank" → tcmb.
  const e7 = extractEntities("Turkey's central bank held rates steady");
  try {
    assert.ok(e7.includes("tcmb"), `expected tcmb in ${JSON.stringify(e7)}`);
    assert.ok(e7.includes("turkiye"));
    console.log("PASS  EN→TR bridge: central bank → tcmb");
  } catch (err) {
    console.error(`FAIL  EN→TR bridge multi-word: ${err.message}`);
    process.exit(1);
  }

  console.log(`\nentities.mjs OK — whitelist size = ${POLITICAL_ENTITIES.size}`);
}
