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
//     is Turkish), and the summary <p> by the seed outlet's display name. The
//     hero image alt is the cluster headline (never a member's own title), so
//     ClusterCardImage gets the <h1>'s lang: 'en' for an all-English cluster
//     whose headline is extractive, nothing for a mixed cluster, the LLM
//     rewrite or the "Haber" fallback.
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
//
// NOT wired: the /timeline rows (src/app/timeline/page.tsx). Its ClusterRow
// (src/lib/clusters/timeline-query.ts) carries no member sources, so
// clusterTextLang has nothing to look at; wiring it needs a timeline-query
// join from clusters to their members' sources. Until then those headlines
// keep the inherited lang="tr".

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
