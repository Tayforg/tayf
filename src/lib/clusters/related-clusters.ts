import { entityHubPatterns, entityHubSpec, foldEntityText } from "@/lib/entities/entity-hub";
import { headlineLang, sourceLang } from "@/lib/sources/source-language";
import { RISING_ENTITIES, RISING_HUB_SPECS } from "@/lib/trends/rising-entities";
import {
  isContentlessTitle,
  repairEntityResidue,
} from "../../../supabase/functions/_shared/rss/entities";
import {
  STEM_LENGTH,
  contentWords,
  sharedStemsExcluding,
  titleAgreement,
  titleStemOverlap,
} from "./summary-agreement";
import {
  isTopicSlug,
  topicNounLowerTr,
  TOPIC_LABELS_TR,
  type TopicSlug,
} from "./topic-query";

// "İlgili haberler": the block at the end of an indexable cluster page that
// lists other recent multi-article clusters from the page's topic feed. Pure
// helpers only: no I/O and no clock. The page reads an existing cached feed and
// hands the bundles here; nothing in this file fetches.
//
// h34-reader-3: the block used to be "the 5 newest stories of the same topic",
// whatever they were about (the Korkuteli CHP-resignation page linked the
// Bavarian deputy premier's death and Netanyahu; one block held both
// Erdoğan-Korea clusters). Now each candidate is scored against the current
// title and the block says what it is:
//   * score = titleAgreement(current title, candidate title) (the share of the
//     current title's content stems the candidate carries, ./summary-agreement)
//     + RELATED_ENTITY_BONUS when both titles name one entity-hub key (the 62
//     curated entities of src/lib/trends/rising-entities.ts, matched with the
//     hub's own folded patterns and precision guards, so "AKP" and "AK Parti"
//     are one key and a Polish court is not the AYM);
//   * score >= RELATED_MIN_SCORE AND (two or more shared content stems, or a
//     shared entity key plus one shared stem, or RELATED_MIN_SHARED_KEYS (three)
//     different shared entity keys) is 'related' (isRelatedTitle):
//     one ordinary shared word is exactly 0.2 for a 5-stem title and says
//     nothing about the story (RELATED_MIN_SHARED_STEMS). A shared stem is one
//     that is NOT a word of a shared entity and NOT a generic word
//     (RELATED_GENERIC_WORDS: h37-clusters-1): "Erdoğan" in two Erdoğan
//     headlines is the entity key, not also "the one shared word", so Emine
//     Erdoğan's Korea post is not related to the Azerbaijan visit, and "İsrail"
//     alone does not relate three Israel stories. A lone number ("11 ilde ... 230
//     gözaltı" and "11 gözaltı daha") is not a shared stem either, and neither
//     are the currency, the country, the months and the job titles and reporting
//     verbs that RELATED_GENERIC_WORDS and RELATED_GENERIC_WHOLE_WORDS also list
//     ("dolar", "Türkiye", "Kasım", "Başbakan", "görüştü": h53-related-1); the
//     score still counts them, so the order of a block does not move. The
//     h53-related-1 words are matched as WHOLE words, not on their five-character
//     stem, so "hazırlık" is not "Haziran" and "Kasımpaşa" is not "Kasım". Three different shared keys
//     ("ABD", "Çin", "Trump" in two trade headlines) are evidence on their own
//     even when every word they share is an entity's. Near-duplicates are dropped
//     first (a title that agrees >= RELATED_DUPLICATE_AGREEMENT, in either
//     direction, with a newer kept one), so two clusters of one event take one
//     slot. Two or more 'related' stories left: mode 'related', best score
//     first, newer first on a tie;
//   * fewer than two: mode 'latest', the same pool's newest stories, still
//     deduped. The component then says "<Konu> gündeminde son haberler" instead
//     of promising relatedness it cannot show. The one related story there may
//     be leads that list (h38-related-1): the newest-first cut could leave out
//     the only story that belongs to the page, and it is from the same topic
//     pool, so the heading stays true.
// A candidate that shares at least half of its articles with the current
// cluster (a stale pre-merge copy in a cached feed) is never listed. In today's
// data an article belongs to one cluster, so that guard is a safety net.
//
// Imports are constants, types and pure helpers (topic-query's slug list and
// labels, the entity helpers the page already uses, the language helpers the
// cards use, the title-agreement scorer, the entity hub's pattern builder), so
// the unit tests need no mocks.

/** The most stories the block ever lists. */
export const RELATED_MAX = 5;

/**
 * Which existing feed a cluster's topic reads. A hub slug reads /konu/<slug>
 * page 1 (the same cache entry as the hub page and its RSS); 'politika' has no
 * hub and reads the home feed.
 */
export type RelatedFeed =
  | { kind: "topic"; slug: TopicSlug }
  | { kind: "politika" };

/**
 * The feed for a stored `clusters.topic7`, or null when there is none. Exact
 * match only: 'POLITIKA', '', a number, null and any unknown value give null
 * (no block), so a stale cache entry without the field degrades to nothing.
 *
 * There is deliberately NO fallback from the member articles' `category` when
 * topic7 is null: on cluster members that column is the politics-gate flag,
 * only 'politika' or 'son_dakika' (production, 7 days of multi-article
 * clusters: 8,556 and 633 rows, no other value), so it cannot name a topic and
 * would label Brent oil or climate stories "Politika". A real fallback needs a
 * signal that varies, such as the per-article topic7 votes behind migration 067.
 */
export function relatedFeedFor(topic7: unknown): RelatedFeed | null {
  if (typeof topic7 !== "string") return null;
  if (topic7 === "politika") return { kind: "politika" };
  if (isTopicSlug(topic7)) return { kind: "topic", slug: topic7 };
  return null;
}

/**
 * The hub link under the list. 'politika' links to '/': /konu/politika 308s
 * there, and the home feed already IS the politics feed.
 *
 * The topic follows "Tüm" mid-sentence, so it is lower-case, and a hub slug
 * takes its noun phrase from topic-query (topicNounLowerTr), which owns the
 * grammar: "Tüm dünya haberleri", "Tüm genel haberler" (h46-copy-1).
 */
export function relatedHubLink(feed: RelatedFeed): { href: string; label: string } {
  if (feed.kind === "politika") {
    return { href: "/", label: "Tüm politika haberleri" };
  }
  return {
    href: `/konu/${feed.slug}`,
    label: `Tüm ${topicNounLowerTr(feed.slug)}`,
  };
}

/** The Turkish topic name for the "<Konu> konusunda son haberler" line (genel's
 *  line reads "Genel gündemde son haberler"; see related-stories.tsx). */
export function relatedTopicLabel(feed: RelatedFeed): string {
  return feed.kind === "politika" ? "Politika" : TOPIC_LABELS_TR[feed.slug];
}

export interface RelatedCluster {
  id: string;
  title: string;
  sourceCount: number;
  /** 'en' only when the headline is an English outlet's own article title. */
  lang: "en" | undefined;
}

/**
 * What a candidate needs. Structural, so a `ClusterBundle` (the feeds' element
 * type) satisfies it as is; every extra field is optional because the feeds'
 * cluster rows carry neither `topic7`, `is_archived` nor `merged_into`.
 */
export interface RelatedCandidate {
  cluster: {
    id: string;
    title_tr: string;
    article_count: number;
    updated_at: string;
    is_archived?: boolean | null;
    merged_into?: string | null;
    topic7?: string | null;
  };
  effectiveArticleCount?: number;
  articles?: readonly { id?: string; title: string; source_id: string; source_name?: string }[];
  sources?: readonly { id: string; name: string; slug?: string | null }[];
}

/** Lower-cased (Turkish rules) with whitespace runs collapsed, for comparing titles. */
function foldTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLocaleLowerCase("tr-TR");
}

/**
 * The `lang` of a candidate's headline, by the rule ClusterCard uses: an
 * unneutralised cluster headline IS one member's title, so it is English only
 * when an English outlet's article carries exactly that title and no Turkish
 * outlet does. undefined when the articles or the sources are not available.
 */
function langOfCandidate(title: string, c: RelatedCandidate): "en" | undefined {
  const { articles, sources } = c;
  if (!articles || !sources) return undefined;
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  return headlineLang(
    title,
    articles.map((a) => {
      const src = sourceById.get(a.source_id);
      return {
        title: typeof a.title === "string" ? repairEntityResidue(a.title) : "",
        lang: sourceLang({ slug: src?.slug, name: a.source_name ?? src?.name }),
      };
    }),
  );
}

/** Which kind of block the page renders: 'related' stories, or the 'latest' of the topic. */
export type RelatedMode = "related" | "latest";

/** The block as a plain value: the mode and the stories under it. */
export interface RelatedBlock {
  mode: RelatedMode;
  items: RelatedCluster[];
}

/**
 * What {@link selectRelatedClusters} returns: the stories as an ordinary array
 * (so a call site that only reads `.length` and passes it on keeps working)
 * with the mode riding along as a non-enumerable `mode` property, which
 * RelatedStories reads. It does not survive a copy (`[...items]`, `.slice()`),
 * and {@link relatedModeOf} then gives the legacy 'related'.
 */
export type RelatedSelection = RelatedCluster[] & { readonly mode: RelatedMode };

/** The score at or above which a candidate counts as related (inclusive). */
export const RELATED_MIN_SCORE = 0.2;
/**
 * Added to the score when both titles name one entity-hub key. Below
 * RELATED_MIN_SCORE on purpose: a shared entity supports some wording overlap
 * (and bridges aliases the wording does not share) but never relates two
 * stories on its own, so "ABD" or "Erdoğan" in two headlines is not enough.
 * Nor are the entity's own words ever the shared stem that the entity is then
 * "backed by" (h37-clusters-1): see {@link RELATED_GENERIC_WORDS},
 * {@link RELATED_GENERIC_WHOLE_WORDS} and isRelatedTitle.
 */
export const RELATED_ENTITY_BONUS = 0.15;
/** Two titles agreeing at least this much, in either direction, are one story (inclusive). */
export const RELATED_DUPLICATE_AGREEMENT = 0.6;
/** Fewer related stories than this and the block falls back to mode 'latest'. */
export const RELATED_MIN_ITEMS = 2;
/**
 * Content stems two titles must share to be related, unless they also share an
 * entity-hub key (which then needs just one more). titleAgreement is the share
 * of the CURRENT title's stems, so a 5-stem title scores exactly
 * RELATED_MIN_SCORE on ONE shared word, and one ordinary word ("Cumhurbaşkanı",
 * "istifa", "edildi") says nothing about the story: it related a Rutte story to
 * an Erdoğan one, and a single such story kept a block under "İlgili haberler".
 * Only DISTINCT stems count: the words of a shared entity, the
 * RELATED_GENERIC_WORDS and the RELATED_GENERIC_WHOLE_WORDS are left out of the
 * count (h37-clusters-1, h53-related-1).
 */
export const RELATED_MIN_SHARED_STEMS = 2;
/**
 * Different entity-hub keys two titles must share to be related on the keys
 * alone, with no stem beyond the entities' own words (the score floor still
 * applies). Because every word of a shared entity is left out of the stem count,
 * two headlines about one affair that name only entities ("ABD Başkanı Trump
 * Çin ile ticaret anlaşması imzaladı" and "... Çin'e gümrük vergisi açıkladı":
 * abd, cin, trump) would otherwise share nothing countable.
 *
 * It is three, not two, because a person key and his country or party key
 * co-occur in one title phrase: "ABD Başkanı Trump", "CHP Genel Başkanı Özgür
 * Özel", "AK Parti ... Erdoğan". Two keys are then often ONE fact, and two
 * headlines that share only that phrase say nothing about each other (in
 * production, 19 of 59 Trump cluster titles of 3 days also carried "ABD").
 */
export const RELATED_MIN_SHARED_KEYS = 3;
/**
 * Words that say what kind of headline it is, not what it is about: a job title
 * or a reporting verb. They never count as a shared stem, entity or not
 * (h37-clusters-1: "ziyaret" and "Cumhurbaşkanı" were the second shared word of
 * Erdoğan's Azerbaijan visit and Emine Erdoğan's Korea post). A title word is
 * one of them when it has the same five-character stem as a listed word and, for
 * a listed word of more than seven characters, also shares all but its last two
 * characters with it. So "Başkan" also covers "Başkanı" and "Başkanlığı",
 * "ziyaret" covers "ziyareti", and "Cumhurbaşkanı" covers "Cumhurbaşkanlığı"
 * but NOT "Cumhuriyet" or "Cumhur" (same `cumhu`, a different word); "açıklama"
 * covers "açıklandı", "açıkladı" and "açıklaması" but not "açıklık"; "değerlendirme"
 * covers "değerlendirmeler" but not "değer" (value). The list is curated and
 * short on purpose: a topic word does not belong here. A listed word of seven
 * characters or fewer is matched on its stem alone, which suits a verb stem
 * ("etti", "geldi") but over-blocks a noun that shares it, so the h53-related-1
 * words live in {@link RELATED_GENERIC_WHOLE_WORDS} instead.
 */
export const RELATED_GENERIC_WORDS: readonly string[] = [
  "Cumhurbaşkanı",
  "Başkan",
  "Bakan",
  "açıklama",
  "açıkladı",
  "mesaj",
  "ziyaret",
  "paylaşım",
  "tepki",
  "yorum",
  "değerlendirme",
  "Son dakika",
  // h38: light verbs and magnitude words carry no topic. "istifa etti", "gündem
  // oldu / peş peşe geldi" (which also folds "öldü") and "milyar dolar/lira"
  // related unrelated stories and, under h38-related-1, led the 'latest' list.
  "etti",
  "edildi",
  "oldu",
  "geldi",
  "verdi",
  "milyon",
  "milyar",
  // h53-related-1: a job title ("Irak Başbakanı ... görüştü" vs "Malezya Başbakan
  // Yardımcısı ... görüştü"). Eight characters, so it keeps the stem-plus-prefix
  // rule above and covers "Başbakanı" and "Başbakanlığı". The other h53 words are
  // in RELATED_GENERIC_WHOLE_WORDS.
  "Başbakan",
];
/**
 * More words that say what KIND of headline it is, not what it is about, matched
 * as WHOLE words (h53-related-1, review fix correctness-related-stem-overblock):
 * a reporting verb ("görüştü"); the currency and the unit of an amount ("6,3
 * milyar dolarlık", "yüzde"); the country every Turkish desk writes from
 * ("Türkiye"); "yeni" and "ilk"; and the calendar months. Like
 * {@link RELATED_GENERIC_WORDS}, they never count as a shared stem, entity or not.
 *
 * Why a second list: a listed word of seven characters or fewer is matched on its
 * five-character stem alone, and these are short enough that the stem is a
 * different word's: `hazir` is "Haziran" and "hazırlık" (COP31 hazırlıkları),
 * `nisan` is "Nisan" and "Nişantaşı", `kasim` is "Kasım" and "Kasımpaşa", `gorus`
 * is "görüştü" and "görüşme". A title word is on this list when it IS a listed
 * word, or starts with one and is at most three characters longer (an inflection:
 * "dolarlık", "Kasımda", "Türkiyede"; an apostrophe suffix is cut before this runs,
 * so "Kasım'da" is just "Kasım"). "lira" does not cover "liralık" in the
 * stem-only rule and "avro" does not cover "avroluk", so both spellings are
 * listed. A lone number is skipped by isNonTopicalWord, not listed here.
 */
export const RELATED_GENERIC_WHOLE_WORDS: readonly string[] = [
  "görüştü",
  "dolar",
  "lira",
  "liralık",
  "avro",
  "avroluk",
  "euro",
  "yüzde",
  "Türkiye",
  "yeni",
  "ilk",
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];
/** A candidate sharing at least this share of its articles with a kept cluster is a copy (inclusive). */
export const RELATED_SHARED_MEMBERS = 0.5;
/** Candidates considered per call: the newest N after the exclusions. The feeds hold 30 or 31 rows. */
const POOL_CAP = 100;

/** Guards the ratio comparisons against floating point (3/5 is 0.6, 1/5 is 0.2). */
const EPSILON = 1e-9;
/** A title is scanned for entities up to this many characters (a headline is 60 to 150). */
const ENTITY_SCAN_CHARS = 400;

// ---------------------------------------------------------------------------
// Entity keys. The hub's own patterns (src/lib/entities/entity-hub.ts), which
// are PostgreSQL regexes: only the word anchors \m and \M differ from
// JavaScript, and \b stands for both (the same twin entity-hub.test.ts uses).
// Built once, on first use, from curated data only (never from a title).
// ---------------------------------------------------------------------------

interface EntityMatcher {
  key: string;
  patterns: readonly RegExp[];
}

let entityMatchers: readonly EntityMatcher[] | null = null;
let stemKeyMatchers: readonly EntityMatcher[] | null = null;

function toRegExps(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p.replace(/\\[mM]/g, "\\b")));
}

function matchers(): readonly EntityMatcher[] {
  if (entityMatchers === null) {
    entityMatchers = RISING_ENTITIES.map((entity) => ({
      key: entity.key,
      patterns: toRegExps(entityHubPatterns(entity)),
    }));
  }
  return entityMatchers;
}

/**
 * The same matchers without the hub's `requires` cue (the excludes and every
 * other guard stay). They decide only whose WORDS are excluded from the shared
 * stems, never whether a title carries the entity key.
 */
function stemMatchers(): readonly EntityMatcher[] {
  if (stemKeyMatchers === null) {
    stemKeyMatchers = RISING_ENTITIES.map((entity) => ({
      key: entity.key,
      patterns: toRegExps(entityHubPatterns(entity, { ...entityHubSpec(entity), requires: undefined })),
    }));
  }
  return stemKeyMatchers;
}

/**
 * The entity-hub keys a title names (sorted), by label and by alias, with the
 * hub's folding (Turkish letters, case) and precision guards. [] for a title
 * with none and for a non-string.
 */
export function entityKeysIn(title: string): string[] {
  if (typeof title !== "string" || title === "") return [];
  const folded = foldEntityText(title.slice(0, ENTITY_SCAN_CHARS));
  return matchers()
    .filter((m) => m.patterns.some((re) => re.test(folded)))
    .map((m) => m.key)
    .sort();
}

/**
 * The keys whose words a title carries, ignoring the hub's `requires` cue: a
 * superset of {@link entityKeysIn}. [] for an empty title and for a non-string.
 */
function stemKeysIn(title: string): string[] {
  if (typeof title !== "string" || title === "") return [];
  const folded = foldEntityText(title.slice(0, ENTITY_SCAN_CHARS));
  return stemMatchers()
    .filter((m) => m.patterns.some((re) => re.test(folded)))
    .map((m) => m.key);
}

// ---------------------------------------------------------------------------
// Stems that must not count as "the shared word" (h37-clusters-1). Built once,
// on first use, from curated data only (never from a title), through the same
// folding every title goes through (summary-agreement's contentWords).
// ---------------------------------------------------------------------------

let entityStems: ReadonlyMap<string, ReadonlySet<string>> | null = null;
let genericWordTest: ((foldedWord: string) => boolean) | null = null;

/**
 * The stems of every spelling an entity key goes by: its label, its folded
 * tokens, and the hub's aliases and inflections (RISING_HUB_SPECS). So "AK
 * Parti" and "AKP" are one key and both spellings are the entity, and
 * "Merkez Bankası" and "TCMB" likewise.
 *
 * A word that isNonTopicalWord flags ("Cumhurbaşkanı", "dolar", "yeniden")
 * contributes no stem: the verdict skips that word anyway, and its five-character
 * stem belongs to other words too (`cumhu` is "Cumhuriyet" and "Cumhur"), which
 * must still be able to back a shared entity. Names ("Recep", "Tayyip") are not
 * flagged and keep their stems.
 */
function stemsOfEntity(key: string): ReadonlySet<string> {
  if (entityStems === null) {
    const built = new Map<string, ReadonlySet<string>>();
    for (const entity of RISING_ENTITIES) {
      const spec = RISING_HUB_SPECS[entity.key];
      const stems = new Set<string>();
      for (const text of [
        entity.label,
        ...entity.tokens,
        ...(spec?.aliases ?? []),
        ...(spec?.inflections ?? []),
      ]) {
        for (const word of contentWords(text)) {
          if (isNonTopicalWord(word)) continue;
          stems.add(word.slice(0, STEM_LENGTH));
        }
      }
      built.set(entity.key, stems);
    }
    entityStems = built;
  }
  return entityStems.get(key) ?? new Set<string>();
}

/** How many leading characters two strings share. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a.charCodeAt(n) === b.charCodeAt(n)) n++;
  return n;
}

/** A listed word this short is matched on its stem alone (the five-character stem is nearly all of it). */
const GENERIC_STEM_ONLY_MAX = 7;
/** A longer listed word is matched when the title word shares all but this many trailing characters. */
const GENERIC_SUFFIX_ALLOWANCE = 2;
/** A RELATED_GENERIC_WHOLE_WORDS entry also matches a title word that starts with it and is at most this many characters longer. */
const GENERIC_WHOLE_WORD_SUFFIX_ALLOWANCE = 3;

/**
 * Whether a folded title word (as summary-agreement's contentWords returns it)
 * is generic. Either it is one of RELATED_GENERIC_WORDS: the same five-character
 * stem as a listed word and, for a listed word of more than GENERIC_STEM_ONLY_MAX
 * characters, the same leading characters up to GENERIC_SUFFIX_ALLOWANCE short of
 * its length. Or it is one of RELATED_GENERIC_WHOLE_WORDS: that word, or that word
 * plus at most GENERIC_WHOLE_WORD_SUFFIX_ALLOWANCE characters. Words with one stem
 * and different meanings stay apart: "Cumhuriyet" and "Cumhurbaşkanı" are both
 * `cumhu`, "Haziran" and "hazırlık" are both `hazir`. Built once, on first use,
 * from curated data only (never from a title).
 */
function genericWord(): (foldedWord: string) => boolean {
  if (genericWordTest === null) {
    const byStem = new Map<string, string[]>();
    for (const listed of RELATED_GENERIC_WORDS) {
      for (const token of contentWords(listed)) {
        const stem = token.slice(0, STEM_LENGTH);
        const tokens = byStem.get(stem);
        if (tokens) tokens.push(token);
        else byStem.set(stem, [token]);
      }
    }
    const wholeTokens: string[] = [];
    for (const listed of RELATED_GENERIC_WHOLE_WORDS) wholeTokens.push(...contentWords(listed));
    genericWordTest = (word) => {
      if (
        wholeTokens.some(
          (token) =>
            word === token ||
            (word.startsWith(token) && word.length - token.length <= GENERIC_WHOLE_WORD_SUFFIX_ALLOWANCE),
        )
      ) {
        return true;
      }
      const tokens = byStem.get(word.slice(0, STEM_LENGTH));
      if (!tokens) return false;
      return tokens.some(
        (token) =>
          token.length <= GENERIC_STEM_ONLY_MAX ||
          commonPrefixLength(word, token) >= token.length - GENERIC_SUFFIX_ALLOWANCE,
      );
    };
  }
  return genericWordTest;
}

/** A folded word made of digits only: "11", "2030", and the halves of "62,3" and "1.250". */
const DIGITS_ONLY = /^\p{N}+$/u;

/**
 * Whether a folded title word can never be "the shared stem" that relates two
 * stories (h53-related-1): a number on its own, or one of
 * RELATED_GENERIC_WORDS or RELATED_GENERIC_WHOLE_WORDS. summary-agreement keeps
 * a lone digit as a content word (a score and the near-duplicate test do use
 * it), so the verdict, and only the verdict, skips it here. A word that merely holds digits ("G20", "F16", "S400")
 * is a name and still counts.
 */
function isNonTopicalWord(foldedWord: string): boolean {
  return DIGITS_ONLY.test(foldedWord) || genericWord()(foldedWord);
}

const NO_STEMS: ReadonlySet<string> = new Set<string>();

/** The stems of the shared entity keys: they do not count as shared between two titles that both name `sharedKeys`. */
function excludedStems(sharedKeys: readonly string[]): ReadonlySet<string> {
  if (sharedKeys.length === 0) return NO_STEMS;
  const excluded = new Set<string>();
  for (const key of sharedKeys) for (const stem of stemsOfEntity(key)) excluded.add(stem);
  return excluded;
}

/** The score of one candidate title against already-computed keys of the current one. */
function scoreAgainst(currentTitle: string, currentKeys: readonly string[], title: string): number {
  return evidenceAgainst(currentTitle, currentKeys, title).score;
}

/**
 * The score of one candidate title against the current one, and whether it
 * counts as related: score >= RELATED_MIN_SCORE and either RELATED_MIN_SHARED_STEMS
 * distinct shared stems, or a shared entity key plus at least one, or
 * RELATED_MIN_SHARED_KEYS different shared keys.
 *
 * The score counts every shared stem, so ordering is what it always was. The
 * verdict does not: a stem that belongs to a SHARED entity key (the words of
 * its label, tokens, aliases and inflections), a word of RELATED_GENERIC_WORDS
 * or RELATED_GENERIC_WHOLE_WORDS, or a number on its own, is not a shared stem.
 * The entity is already counted once, as the key (and the bonus); counting its own word again as "the one
 * shared stem" made any two Erdoğan, ABD or İsrail headlines related
 * (h37-clusters-1). Several different shared keys, though, are several
 * different facts in common, so a third one relates two titles whose shared
 * words are all entity words.
 */
function evidenceAgainst(
  currentTitle: string,
  currentKeys: readonly string[],
  title: string,
): { score: number; related: boolean } {
  const overlap = titleStemOverlap(currentTitle, title);
  const agreement = overlap === null ? 0 : overlap.shared / overlap.total;
  const candidateKeys = entityKeysIn(title);
  const sharedKeys = currentKeys.filter((key) => candidateKeys.includes(key));
  const entity = sharedKeys.length > 0;
  const score = entity ? agreement + RELATED_ENTITY_BONUS : agreement;
  if (score < RELATED_MIN_SCORE - EPSILON) return { score, related: false };
  // The entity's own words never count as the shared stem, even when the hub's
  // `requires` cue is absent from a title and so withholds the key (h37-clusters-1
  // vs the h61 tcmb requires: "Paraguay Merkez Bankası" carries no tcmb key, yet
  // "merkez" and "banka" are still the bank's words, not a second shared fact).
  const candidateStemKeys = stemKeysIn(title);
  const stemKeys = new Set(sharedKeys);
  for (const key of stemKeysIn(currentTitle)) if (candidateStemKeys.includes(key)) stemKeys.add(key);
  const distinct = sharedStemsExcluding(currentTitle, title, excludedStems([...stemKeys]), isNonTopicalWord);
  const related =
    distinct >= RELATED_MIN_SHARED_STEMS ||
    (entity && distinct >= 1) ||
    sharedKeys.length >= RELATED_MIN_SHARED_KEYS;
  return { score, related };
}

/**
 * How related `candidateTitle` is to `currentTitle`: titleAgreement (0 when the
 * current title has too few content tokens to say anything) plus
 * RELATED_ENTITY_BONUS once when both name an entity-hub key.
 */
export function relatedScore(currentTitle: string, candidateTitle: string): number {
  if (typeof currentTitle !== "string" || typeof candidateTitle !== "string") return 0;
  return scoreAgainst(currentTitle, entityKeysIn(currentTitle), candidateTitle);
}

/**
 * Whether `candidateTitle` counts as related to `currentTitle`: its
 * {@link relatedScore} is at least RELATED_MIN_SCORE (inclusive) and the two
 * share RELATED_MIN_SHARED_STEMS content stems, or an entity-hub key together
 * with at least one stem, or RELATED_MIN_SHARED_KEYS different entity-hub keys.
 * The words of a shared entity, the RELATED_GENERIC_WORDS and the
 * RELATED_GENERIC_WHOLE_WORDS are not shared stems: two titles that only share "Erdoğan" (or "Cumhurbaşkanı ... ziyaret")
 * are not related, and neither are two that share a person and his country or
 * party only (two keys). False for a non-string.
 */
export function isRelatedTitle(currentTitle: string, candidateTitle: string): boolean {
  if (typeof currentTitle !== "string" || typeof candidateTitle !== "string") return false;
  return evidenceAgainst(currentTitle, entityKeysIn(currentTitle), candidateTitle).related;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

interface Kept {
  key: string;
  ms: number;
  title: string;
  folded: string;
  members: ReadonlySet<string> | null;
  candidate: RelatedCandidate;
  effective: number;
}

/** The distinct, non-empty article ids of a candidate, or null when it carries none. */
function memberIds(c: RelatedCandidate): ReadonlySet<string> | null {
  const ids = new Set<string>();
  for (const a of c.articles ?? []) {
    if (typeof a?.id === "string" && a.id !== "") ids.add(a.id);
  }
  return ids.size > 0 ? ids : null;
}

/** True when at least RELATED_SHARED_MEMBERS of the smaller member list sits in both. */
function sharesHalfTheMembers(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean {
  if (a === null || b === null) return false;
  let shared = 0;
  for (const id of a) if (b.has(id)) shared++;
  return shared / Math.min(a.size, b.size) >= RELATED_SHARED_MEMBERS - EPSILON;
}

/** Same words (folded titles equal) or agreement >= RELATED_DUPLICATE_AGREEMENT in either direction. */
function nearDuplicate(a: Kept, b: Kept): boolean {
  if (a.folded === b.folded) return true;
  const best = Math.max(titleAgreement(a.title, b.title) ?? 0, titleAgreement(b.title, a.title) ?? 0);
  return best >= RELATED_DUPLICATE_AGREEMENT - EPSILON;
}

/** Newest first (an unparseable date last), equal dates by id descending: the order fetchTopicClusters uses. */
function byRecency(a: Kept, b: Kept): number {
  const aBad = Number.isNaN(a.ms);
  const bBad = Number.isNaN(b.ms);
  if (aBad !== bBad) return aBad ? 1 : -1;
  if (!aBad && a.ms !== b.ms) return b.ms - a.ms;
  if (a.key === b.key) return 0;
  return a.key < b.key ? 1 : -1;
}

/**
 * `list` (already in recency order) without the stories that repeat a newer one
 * kept before them: near-duplicate titles, or half the articles in common. The
 * newer story of a duplicate pair is the one that stays. Stops once `stopAt`
 * are kept.
 */
function dedupe(list: readonly Kept[], stopAt = Infinity): Kept[] {
  const kept: Kept[] = [];
  for (const c of list) {
    if (kept.length >= stopAt) break;
    if (kept.some((k) => nearDuplicate(k, c) || sharesHalfTheMembers(k.members, c.members))) continue;
    kept.push(c);
  }
  return kept;
}

/**
 * The block for a cluster page, as a plain `{ mode, items }`. Up to `max`
 * (never more than RELATED_MAX) other stories from a feed.
 *
 * Drops, in this order: the page's own cluster, anything under two articles,
 * archived and merged clusters, a different `topic7`, a contentless title, a
 * title equal to the current one (a duplicate-looking story), a repeated id
 * (the first occurrence wins) and a story that shares at least half of its
 * articles with the current cluster (when the current cluster is in the pool).
 * Then, on the newest POOL_CAP of what is left, in recency order (`updated_at`
 * descending, an unparseable date last, equal dates by id descending): scores
 * each against the current title and keeps the ones at or above
 * RELATED_MIN_SCORE and share two distinct stems, an entity key plus one, or three
 * entity keys (isRelatedTitle), removes near-duplicates (the newer of a pair stays), and
 *   * with RELATED_MIN_ITEMS or more left returns them as mode 'related', best
 *     score first, newer first on a tie;
 *   * with fewer returns the newest stories of the same pool, deduped the same
 *     way, as mode 'latest'. The one related story, if there is one, is the
 *     first of them (h38-related-1) and the others follow newest first; a
 *     near-duplicate of it stays out, and the limit still holds.
 * Never mutates its input.
 */
export function buildRelatedBlock(args: {
  currentId: string;
  currentTitle: string;
  topic: string;
  bundles: readonly RelatedCandidate[];
  max?: number;
}): RelatedBlock {
  const requested =
    typeof args.max === "number" && !Number.isNaN(args.max)
      ? Math.trunc(args.max)
      : RELATED_MAX;
  const limit = Math.max(0, Math.min(requested, RELATED_MAX));
  if (limit === 0) return { mode: "latest", items: [] };

  const currentKey = String(args.currentId).toLowerCase();
  const currentTitle = repairEntityResidue(String(args.currentTitle));
  const currentFolded = foldTitle(currentTitle);

  const seen = new Set<string>();
  let currentMembers: ReadonlySet<string> | null = null;
  const kept: Kept[] = [];
  for (const c of args.bundles) {
    const cluster = c?.cluster;
    if (!cluster || typeof cluster.id !== "string" || typeof cluster.title_tr !== "string") {
      continue;
    }
    const key = cluster.id.toLowerCase();
    if (key === currentKey) {
      currentMembers ??= memberIds(c);
      continue;
    }
    // `!(n >= 2)` also drops a missing or NaN count.
    if (!(cluster.article_count >= 2)) continue;
    if (cluster.is_archived === true || cluster.merged_into) continue;
    if (typeof cluster.topic7 === "string" && cluster.topic7 !== args.topic) continue;

    const title = repairEntityResidue(cluster.title_tr).trim();
    if (isContentlessTitle(title)) continue;
    const folded = foldTitle(title);
    if (folded === currentFolded) continue;

    if (seen.has(key)) continue;
    seen.add(key);

    const effective = c.effectiveArticleCount;
    kept.push({
      key,
      ms: Date.parse(cluster.updated_at),
      title,
      folded,
      members: memberIds(c),
      candidate: c,
      effective:
        typeof effective === "number" && Number.isFinite(effective)
          ? effective
          : cluster.article_count,
    });
  }

  const pool = kept
    .sort(byRecency)
    .slice(0, POOL_CAP)
    .filter((k) => !sharesHalfTheMembers(currentMembers, k.members));

  const currentKeys = entityKeysIn(currentTitle);
  const scored = pool.map((k) => ({ k, ...evidenceAgainst(currentTitle, currentKeys, k.title) }));
  const related = dedupe(scored.filter((s) => s.related).map((s) => s.k));

  const toItem = (k: Kept): RelatedCluster => ({
    id: k.candidate.cluster.id,
    title: k.title,
    sourceCount: k.effective,
    lang: langOfCandidate(k.title, k.candidate),
  });

  if (related.length >= RELATED_MIN_ITEMS) {
    const scoreOf = new Map(scored.map((s) => [s.k, s.score]));
    const best = [...related].sort(
      (a, b) => (scoreOf.get(b) ?? 0) - (scoreOf.get(a) ?? 0) || byRecency(a, b),
    );
    return { mode: "related", items: best.slice(0, limit).map(toItem) };
  }
  // Fewer than RELATED_MIN_ITEMS related stories (none or a lone one): the pool's newest, deduped. A related
  // story leads the list, so a lone one that is older than the newest `limit` is not left out; dedupe keeps
  // the first of a near-duplicate pair, so a newer twin of it stays out and it is listed once.
  const lead = new Set(related);
  const rest = lead.size === 0 ? pool : pool.filter((k) => !lead.has(k));
  return { mode: "latest", items: dedupe([...related, ...rest], limit).map(toItem) };
}

/**
 * {@link buildRelatedBlock}'s stories as an array that also carries the mode
 * (see {@link RelatedSelection}). The cluster page calls this one.
 */
export function selectRelatedClusters(args: {
  currentId: string;
  currentTitle: string;
  topic: string;
  bundles: readonly RelatedCandidate[];
  max?: number;
}): RelatedSelection {
  const { mode, items } = buildRelatedBlock(args);
  return Object.defineProperty(items, "mode", {
    value: mode,
    enumerable: false,
  }) as RelatedSelection;
}

/**
 * The mode a list of stories carries: 'latest' only when it was marked so by
 * {@link selectRelatedClusters}; a plain array, a copy or anything else is the
 * legacy 'related'.
 */
export function relatedModeOf(items: unknown): RelatedMode {
  return (items as { mode?: unknown } | null | undefined)?.mode === "latest" ? "latest" : "related";
}
