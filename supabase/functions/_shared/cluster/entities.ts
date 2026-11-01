// supabase/functions/_shared/cluster/entities.ts
//
// Lightweight entity extractor for Turkish news titles+descriptions.
// Ported from `scripts/lib/cluster/entities.mjs`.
//
// Emits single-token canonical forms from a curated whitelist, 4-digit
// years, and percentages. Includes an EN→TR bilingual bridge for a-news /
// daily-sabah / hurriyet-daily-news / trt-world.

import { ENTITY_AMBIGUOUS, ENTITY_PROPER_NOUNS } from "./constants.ts";

// ---------------------------------------------------------------------------
// POLITICAL_ENTITIES — curated single-token whitelist (TR-folded lowercase).
// ---------------------------------------------------------------------------

export const POLITICAL_ENTITIES: Set<string> = new Set([
  // Parties
  "akp", "chp", "mhp", "iyi", "deva", "gelecek", "saadet", "tip", "dem",
  "hdp", "ysp", "yrp", "bbp", "vatan",
  // Institutions
  "tbmm", "meclis", "cumhurbaskanligi", "basbakanlik", "disisleri", "icisleri",
  "adalet", "meb", "saglik", "tcmb", "bddk", "spk", "tuik", "tusiad", "afad",
  "tsk", "emniyet", "jandarma", "myk", "ysk", "danistay", "anayasamahkemesi",
  "yargitay", "sayistay",
  // Cities (largest only)
  "istanbul", "ankara", "izmir", "bursa", "adana", "gaziantep", "konya",
  "antalya", "diyarbakir", "sanliurfa", "kayseri", "mersin", "samsun", "trabzon",
  // Countries / blocs frequent in TR news
  "abd", "rusya", "ukrayna", "suriye", "iran", "israil", "filistin",
  "yunanistan", "almanya", "fransa", "ingiltere", "cin", "avrupa", "nato",
  "bm", "ab", "ohal",
  // Known people (canonical diacritic-folded single tokens)
  "erdogan", "kilicdaroglu", "ozel", "imamoglu", "yavas", "bahceli",
  "davutoglu", "babacan", "karamollaoglu", "akgun", "simsek", "sonmez",
  "fidan", "yilmaz", "ala", "guler",
  // Sports → political bridges
  "galatasaray", "fenerbahce", "besiktas", "trabzonspor", "tff", "spor", "futbol",
  // Religion → political bridges
  "diyanet", "imam", "cami", "cuma", "namaz", "ramazan", "oruc", "kuran",
  // Finance → political bridges
  "bist", "borsa", "dolar", "euro", "enflasyon", "faiz", "kur", "altin",
  // Armenian / minority bridges
  "ermeni", "rum", "gregoryen", "patrik", "hrant", "dink",
  // English-language bridges for a-news
  "turkey", "turkish", "parliament", "minister", "president", "election",
  "trump", "putin", "biden",
  // EN→TR bridge targets
  "turkiye", "bakan", "cumhurbaskan", "secim", "ekonomi", "muhalefet",
]);

// ---------------------------------------------------------------------------
// Stopwords — small list of high-frequency Turkish tokens that the 3-char
// length filter would otherwise miss.
// ---------------------------------------------------------------------------

const STOPWORDS: Set<string> = new Set([
  "ile", "icin", "gibi", "kadar", "daha", "cok", "her", "hem", "bir", "iki",
  "uc", "bin", "son", "dun", "bugun", "yarin", "simdi", "sonra", "once",
  "var", "yok", "oldu", "dedi", "diye", "ama", "fakat", "ancak", "veya",
  "den", "dan", "nin", "nun", "haber", "canli", "flas", "acil",
]);

// ---------------------------------------------------------------------------
// Turkish folding map.
// ---------------------------------------------------------------------------

function foldTurkish(s: string): string {
  const map: Record<string, string> = {
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

export function normalizeToken(raw: unknown): string | null {
  if (raw == null) return null;
  const folded = foldTurkish(String(raw));
  const stripped = folded.replace(/[^a-z0-9]/g, "");
  if (stripped.length < 3) return null;
  if (STOPWORDS.has(stripped)) return null;
  return stripped;
}

// Words are the runs between whitespace + common Turkish punctuation (see
// WORD_RE below).

// ---------------------------------------------------------------------------
// EN_TO_TR_BRIDGE — emit Turkish equivalents from English-titled wires so
// `a-news` etc. share entity tokens with mainstream Turkish coverage.
// ---------------------------------------------------------------------------

export const EN_TO_TR_BRIDGE: Record<string, string> = {
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

const EN_BRIDGE_PATTERNS: Array<{ re: RegExp; tr: string }> = Object.entries(
  EN_TO_TR_BRIDGE,
).map(([en, tr]) => {
  const escaped = en
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return {
    re: new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i"),
    tr,
  };
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
const AMBIGUOUS: Set<string> = new Set(ENTITY_AMBIGUOUS);
const PROPER: Set<string> = new Set(ENTITY_PROPER_NOUNS);

// A word is a run of non-separator characters (whitespace, common Turkish
// punctuation, quotes and apostrophes separate); runs without a letter or digit (emoji, symbols) are not
// words, so they neither start a sentence nor count as a neighbour.
const WORD_RE = /[^\s.,;:!?()[\]{}"'`’‘“”«»\-–—/\\|…]+/g;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const LETTER_RE = /\p{L}/u;
const SENTENCE_BREAK_RE = /[.!?:…\n]/;
// Stops an "(a)/(d)" neighbour from being read across a clause break.
const CLAUSE_BREAK_RE = /[.!?:;,…\n]/;

interface Word {
  raw: string;
  start: number;
  end: number;
}

function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    if (!WORD_CHAR_RE.test(m[0])) continue;
    out.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

function foldWord(raw: string): string {
  return foldTurkish(raw).replace(/[^a-z0-9]/g, "");
}

function isAllCaps(raw: string): boolean {
  let letters = 0;
  for (const ch of raw) if (LETTER_RE.test(ch)) letters++;
  return letters >= 2 && raw === raw.toLocaleUpperCase("tr") &&
    raw !== raw.toLocaleLowerCase("tr");
}

function isCapitalised(raw: string): boolean {
  const first = [...raw][0] ?? "";
  return LETTER_RE.test(first) && first !== first.toLocaleLowerCase("tr");
}

function isDisambiguated(
  text: string,
  words: Word[],
  i: number,
  norm: string,
): boolean {
  const w = words[i]!;
  const prev = i > 0 ? words[i - 1]! : null;
  const next = i + 1 < words.length ? words[i + 1]! : null;
  const nextAdjacent = next !== null &&
    !CLAUSE_BREAK_RE.test(text.slice(w.end, next.start));
  const prevAdjacent = prev !== null &&
    !CLAUSE_BREAK_RE.test(text.slice(prev.end, w.start));

  // (a) "<token> Parti..."
  if (nextAdjacent && foldWord(next!.raw).startsWith("parti")) return true;

  // (b) capitals, unless the whole neighbourhood is capitals too.
  if (isAllCaps(w.raw)) {
    let capsNeighbours = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(words.length - 1, i + 2); j++) {
      if (j !== i && isAllCaps(words[j]!.raw)) capsNeighbours++;
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
  if (norm === "ozel" && prevAdjacent && foldWord(prev!.raw) === "ozgur") return true;
  if (norm === "adalet" && nextAdjacent && foldWord(next!.raw).startsWith("bakan")) {
    return true;
  }
  return false;
}

export function extractEntities(text: string | null | undefined): string[] {
  if (!text || typeof text !== "string") return [];

  const found = new Set<string>();

  // 1–2. Whitelist matches over normalized single tokens. The eleven
  // homograph tokens (ENTITY_AMBIGUOUS) are ordinary Turkish words as well as
  // party names, so they additionally need a disambiguator (see below);
  // every other token keeps the plain whitelist lookup.
  const words = wordsOf(text);
  for (let i = 0; i < words.length; i++) {
    const norm = normalizeToken(words[i]!.raw);
    if (!norm) continue;
    if (!POLITICAL_ENTITIES.has(norm)) continue;
    if (AMBIGUOUS.has(norm) && !isDisambiguated(text, words, i, norm)) continue;
    found.add(norm);
  }

  // 3. 4-digit years (1950-2099).
  const yearRe = /\b(19[5-9]\d|20\d{2})\b/g;
  let ym: RegExpExecArray | null;
  while ((ym = yearRe.exec(text)) !== null) {
    found.add(ym[1]);
  }

  // 4. Percentages: "47%" / "47 %" / "yüzde 47".
  const pctRe = /(?:\b(\d{1,3})\s*%|(?:yüzde|yuzde)\s*(\d{1,3})\b)/gi;
  let pm: RegExpExecArray | null;
  while ((pm = pctRe.exec(text)) !== null) {
    const num = pm[1] || pm[2];
    if (num) found.add(`pct${num}`);
  }

  // 5. Bilingual bridge.
  for (const { re, tr } of EN_BRIDGE_PATTERNS) {
    if (re.test(text)) {
      found.add(tr);
    }
  }

  return [...found];
}
