// Language of the text a source publishes (WCAG 3.1.2 Language of Parts, AA).
//
// The document is <html lang="tr">, but six registered outlets publish in
// English. Their headlines and excerpts must carry lang="en" so a screen
// reader switches voice instead of pronouncing English with Turkish phonetics
// (~1,300 articles a week; h17-a11y-2).
//
// h17-a11y-2 named five: a-news, daily-sabah, hurriyet-daily-news, trt-world
// and turkiye-today. h43-sources-2 added the sixth, mfa-turkey (MFA Turkey /
// MFA Türkiye, kind niche): all of its items have English titles and several
// are cluster members, so they reach cluster pages as well as /source/mfa-turkey.
//
// This is a CODE CONSTANT, not data: `public.sources` has no language column
// and this change adds no migration and writes nothing. Adding a seventh
// English outlet means adding its slug here (and its display name below).
//
// Two call shapes exist because two kinds of caller exist:
//   - /source/[slug] has the full source row, so it matches on the slug.
//   - Story cards project `sources ( id, name, bias, logo_url )` WITHOUT a
//     slug, so they match on the display name.
//
// Wired call sites (WCAG 3.1.2, h17-a11y-2 and h23-a11y-1):
//   - /source/[slug]: title and excerpt, by slug.
//   - Home story cards: by display name (no slug in their projection). The
//     card's <h2> headline is the cluster headline, so it takes headlineLang:
//     'en' only when an English member's title IS the headline (an
//     unneutralised extractive one) and no Turkish member carries it too.
//   - Cluster page (src/app/cluster/[id]/page.tsx): the <h1> and the "Özgün
//     başlık" disclosure when EVERY member is English (clusterTextLang; the
//     <h1> is skipped when title_method is 'llm', because that neutral rewrite
//     is Turkish), and the summary <p> by the seed outlet's display name. A
//     mixed cluster's <h1> takes headlineLang, the home card's rule (h59-english-2).
//     The disclosure is the seed member's own title, so it takes the same member
//     rule as the <h1>: clusterTextLang, else headlineLang over the members
//     (react-h59-1).
//     The hero image alt is the cluster headline (never a member's own title),
//     so ClusterCardImage gets the <h1>'s lang: 'en' for an all-English cluster
//     whose headline is extractive or a mixed cluster whose headline is an
//     English member's own title, nothing for the LLM rewrite, a Turkish
//     headline or the "Haber" fallback.
//   - src/components/story/framing-comparison.tsx: each entry's source name and
//     headline, by slug. The name span is CSS-uppercased, and under lang=tr that
//     turns 'Daily Sabah' into 'DAİLY SABAH'; lang="en" fixes the glyphs too.
//   - src/components/story/story-timeline.tsx: the 'Tüm sıra' rows' source name
//     and title, by display name (timeline points carry no slug).
//   - src/components/story/read-across-spectrum.tsx: the picked outlet's name.
//   - src/components/story/source-profile-link.tsx (the cluster page's "Kaynak
//     künyesi"): the name is CSS-uppercased too, so it carries lang="en" for an
//     English outlet (by slug, name as the fallback) on the link and on the
//     plain-text fallback (h25-visual-1).
//   - The cluster page's "Toplayıcı / niş kaynaklar" list (the uppercase name
//     span of each non-voting member), by slug.
//   - h59-english-1: isLanguageIsolatedCluster (every member English) switches
//     the zone-absence wording of the cluster page, the story timeline, the
//     read-across slot, the framing block and the Manşet Kartı to the
//     "not compared with Turkish sources" copy below, sets the NewsArticle
//     inLanguage to 'en', and keeps the cluster off the home feed
//     (politics-query.ts, by display name: the embed has no slug).
//   - h118-shares-1: the outbound surfaces take the same predicate. The OG /
//     Twitter card prints ENGLISH_ONLY_SPECTRUM_LINE where its tiles were
//     (og-spectrum.ts), the share text and the rozet carry ENGLISH_ONLY_SHARE_CLAUSE
//     (share.ts, badge-svg.ts), and the embed does both plus a lang="en" <h1> by
//     the cluster page's own rule (embed-html.ts).
//   - h118-english-1: the list readers that select no member sources take one
//     bounded member read, fetchLanguageIsolatedIds
//     (src/lib/clusters/language-isolation-read.ts; clusters of 2..12 members,
//     count-guarded). /timeline (timeline-query.ts getRecentClusters) puts
//     lang="en" on the headline link of a cluster whose every member is English,
//     except for an LLM-rewritten title, which is Turkish. /api/takip gives an
//     item lang "en" by headlineLang over its members (follow-feed.tsx puts it on
//     the title span) and prints ENGLISH_ONLY_ZONE_LINE instead of the zone tally
//     when isLanguageIsolatedCluster. The news sitemap (src/lib/seo/sitemaps.ts
//     readNewsSitemapXml) leaves isolated clusters out because every entry
//     declares <news:language>tr</news:language>; clusters-YYYY-MM.xml keeps them.
//   - h151-home-1: ClusterCard (src/components/story/cluster-card.tsx), so every
//     page that lists a card carries the rule: the home archive search (/?q=),
//     /konu/<slug>, /gundem/<key> and /blindspots. Those pages hand it the
//     bundle's own articles and deduped member sources (names only, no slug), and
//     the card judges ALL its articles by display name (an unresolvable member is
//     unknown, not English). For an all-English cluster it prints
//     ENGLISH_ONLY_SPECTRUM_LINE under the zone bar (the bar itself stays) and
//     draws neither the Denge chip nor the "Kör nokta" badge. The home feed
//     itself never lists such a cluster (politics-query.ts).
//   - /ekonomi feed, /ekonomi/[ticker] news list and intraday chart caption
//     (h101-a11yrecent-2): each row's headline link and source-name span, by
//     {slug, name} (both queries carry the slug). The chart's marker captions
//     take it through ChartMarker.lang ('en' for an English article's headline;
//     the Turkish "KAP: ..." markers carry none).

/** Slugs of the registered English-language outlets (exactly six). */
export const ENGLISH_SOURCE_SLUGS: ReadonlySet<string> = new Set([
  "a-news",
  "daily-sabah",
  "hurriyet-daily-news",
  "mfa-turkey",
  "trt-world",
  "turkiye-today",
]);

/**
 * Slugs of the outlets whose headlines are machine-cased: names lose their capitals ('Bakan Bayraktar'dan libya ve
 * venezuela mesajı', 'Bakan kurum: ...', 'çöp31' for COP31). The headline cron sets `caseUnreliable` on a member whose
 * source slug is in this set, exactly as it sets `english` from ENGLISH_SOURCE_SLUGS (h164-titles-2), and the extractive
 * picker recases such a title from its siblings instead of copying it into the H1. Only İşçi Haber so far: 7 of the 52
 * served titles that are İşçi Haber's own text (13%) carry lost capitals, in the 1,500-cluster sample of 2-12 November
 * 2026. A code constant, like the English set: `public.sources` has no column for it and nothing is written.
 */
export const LOWERCASE_PRONE_SOURCE_SLUGS: ReadonlySet<string> = new Set(["isci-haber"]);

/**
 * Display names of the same outlets, already folded (see `foldName`): the
 * names production returns for those slugs plus their ASCII spellings.
 */
export const ENGLISH_SOURCE_NAMES: ReadonlySet<string> = new Set([
  "a news",
  "daily sabah",
  "hürriyet daily news",
  "hurriyet daily news",
  "mfa turkey",
  "mfa türkiye",
  "trt world",
  "türkiye today",
  "turkiye today",
]);

/**
 * Case-folds a display name for lookup: NFC, whitespace collapsed and trimmed,
 * then lower-cased under BOTH the default and the tr-TR rules.
 *
 * Two rule sets are needed because Turkish case mapping is lossy in each
 * direction. 'HÜRRİYET DAILY NEWS' lower-cases to 'hürri̇yet daily news'
 * (i + combining dot) by default, and to 'hürriyet daıly news' under tr-TR
 * (the I of DAILY becomes dotless). Neither is the stored spelling, so the
 * combining dot is dropped and the dotless ı is mapped back to i on each
 * variant before comparing.
 */
function foldName(name: string): string[] {
  const base = name.normalize("NFC").replace(/\s+/g, " ").trim();
  return [base.toLowerCase(), base.toLocaleLowerCase("tr-TR")].map((s) =>
    s.replace(/̇/g, "").replace(/ı/g, "i"),
  );
}

/**
 * `'en'` when the source publishes in English, otherwise `undefined` (React
 * renders no `lang` attribute for `undefined`, so Turkish text keeps the
 * inherited `tr`).
 *
 * A non-empty slug decides on its own: a card for `{slug: 'sozcu', name:
 * 'Daily Sabah'}` is not English. Only a missing or blank slug falls back to
 * the display name. Never throws, whatever it is handed.
 */
export function sourceLang(
  src: { slug?: string | null; name?: string | null } | null | undefined,
): "en" | undefined {
  if (!src) return undefined;

  const slug = typeof src.slug === "string" ? src.slug.trim() : "";
  if (slug !== "") return ENGLISH_SOURCE_SLUGS.has(slug) ? "en" : undefined;

  const name = typeof src.name === "string" ? src.name : "";
  if (name.trim() === "") return undefined;
  return foldName(name).some((n) => ENGLISH_SOURCE_NAMES.has(n))
    ? "en"
    : undefined;
}

/**
 * `'en'` only when the list is non-empty and EVERY entry is an English outlet
 * (`sourceLang(entry) === 'en'`), otherwise `undefined`.
 *
 * It answers "is the text a cluster shows in the document's language an
 * English article title?". The extractive cluster headline is one member's own
 * title, and any Turkish member can be the one that supplied it, so a single
 * Turkish (or unknown, or null) entry means the headline cannot be claimed as
 * English. An empty list says nothing and gives `undefined`. Never throws.
 */
export function clusterTextLang(
  sources: ReadonlyArray<
    { slug?: string | null; name?: string | null } | null | undefined
  >,
): "en" | undefined {
  if (!Array.isArray(sources) || sources.length === 0) return undefined;
  for (const src of sources) {
    if (sourceLang(src) !== "en") return undefined;
  }
  return "en";
}

/**
 * h59-english-1: true when EVERY member source of a cluster (voting or not) is
 * an English-language outlet, i.e. `clusterTextLang(sources) === 'en'`. A mixed
 * or Turkish cluster, an empty list and any null/unknown entry are not
 * isolated. Never throws.
 *
 * Such a cluster formed among English articles only: the entity-text floor keeps
 * English and Turkish articles about one event apart, so it carries no Bağımsız
 * or Muhalefet outlet because none could have matched it, not because none
 * covered the event (Turkish clusters on the same event carry both). The pages
 * therefore must not print a zone-absence claim for it (cluster page, timeline,
 * read-across, framing block, Manşet Kartı), and the home feed leaves it out.
 * Callers hand it whatever source shape they hold: the cluster page has slugs,
 * the PostgREST embed in politics-query.ts only has names (the name fallback of
 * `sourceLang`).
 */
export function isLanguageIsolatedCluster(
  sources: ReadonlyArray<
    { slug?: string | null; name?: string | null } | null | undefined
  >,
): boolean {
  return clusterTextLang(sources) === "en";
}

/**
 * The one note an English-only cluster page prints where it would otherwise
 * claim a zone has no coverage (the read-across slot; the framing columns print
 * ENGLISH_ONLY_EMPTY_COLUMN).
 */
export const ENGLISH_ONLY_NOTE =
  "Bu hikâyeyi yalnızca İngilizce yayın yapan kaynaklar yazdı. Türkçe haberlerle eşleşmediği için bölge karşılaştırması yapılamıyor.";

/** An empty framing column of an English-only cluster. */
export const ENGLISH_ONLY_EMPTY_COLUMN = "— Türkçe kaynaklarla karşılaştırılmadı —";

/** An empty zone row of an English-only cluster's Manşet Kartı. */
export const ENGLISH_ONLY_KART_EMPTY_ZONE =
  "— karşılaştırma yok (yalnızca İngilizce kaynaklar)";

// h118-shares-1: the same "not compared with Turkish sources" qualifier on the
// outbound surfaces, which printed the zone-absence claim ("İktidar %100 ·
// Bağımsız %0 · Muhalefet %0") for an all-English cluster while its own page and
// Manşet Kartı did not. One wording per slot; no surface keeps a literal of its own.

/**
 * The line an all-English cluster's OG / Twitter card prints where the three zone
 * tiles would be (src/lib/seo/og-spectrum.ts).
 */
export const ENGLISH_ONLY_SPECTRUM_LINE =
  "Yalnızca İngilizce yayın yapan kaynaklar yazdı — Türkçe haberlerle karşılaştırılmadı";

/**
 * The short tag the rozet's 10 px caption can hold ("N kaynak · yalnızca
 * İngilizce"); the head of ENGLISH_ONLY_SHARE_CLAUSE, so the two cannot drift.
 */
export const ENGLISH_ONLY_BADGE_TAG = "yalnızca İngilizce";

/**
 * The clause an all-English cluster's outbound text carries in place of its zone
 * percents: the share text ("3 kaynak · <clause>"), the embed legend (first letter
 * capitalised, tr-TR) and the rozet's title / aria-label.
 */
export const ENGLISH_ONLY_SHARE_CLAUSE = `${ENGLISH_ONLY_BADGE_TAG} kaynaklar, Türkçe haberlerle karşılaştırılmadı`;

/**
 * The /api/takip follow-feed zone line, shown where the zone tally would be: no
 * Bağımsız or Muhalefet outlet could have matched a story that formed among
 * English articles only, so "Bağımsız 0 · Muhalefet 0" would claim a silence that
 * was never measured (h59-english-1, the cluster page's own wording). The head is
 * the rozet tag, first letter capitalised under tr-TR (as the embed legend does).
 */
export const ENGLISH_ONLY_ZONE_LINE = `${ENGLISH_ONLY_BADGE_TAG.charAt(0).toLocaleUpperCase("tr-TR")}${ENGLISH_ONLY_BADGE_TAG.slice(1)} kaynaklar · Türkçe haberlerle karşılaştırılmadı`;

/** Trims and collapses whitespace runs; anything that is not a string is "". */
function normaliseTitle(title: unknown): string {
  return typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
}

/**
 * `'en'` when a story card's headline can be traced to an English outlet's own
 * article title, otherwise `undefined` (React renders no `lang` attribute for
 * `undefined`, so the Turkish card chrome keeps the inherited `tr`).
 *
 * An extractive cluster headline IS one member's title; an LLM-neutralised one
 * is Turkish and matches none. So the headline is English only if at least one
 * English-language member (`lang: 'en'`) has the same title once both sides are
 * trimmed and whitespace-collapsed, AND no Turkish member (`lang: undefined`)
 * has that same title: a title both a Turkish and an English outlet published
 * verbatim cannot be claimed as English. Matching is exact otherwise (case
 * included); a headline whose source article is not among `members` stays
 * `undefined`, the same as before. An empty headline or an empty list says
 * nothing and gives `undefined`. Never throws, whatever it is handed.
 */
export function headlineLang(
  headline: string,
  members: readonly { title: string; lang: "en" | undefined }[],
): "en" | undefined {
  const target = normaliseTitle(headline);
  if (target === "" || !Array.isArray(members) || members.length === 0) {
    return undefined;
  }
  let english = false;
  for (const member of members) {
    if (!member || normaliseTitle(member.title) !== target) continue;
    // A Turkish member with the same title vetoes the claim outright.
    if (member.lang !== "en") return undefined;
    english = true;
  }
  return english ? "en" : undefined;
}
