// Language of the text a source publishes (WCAG 3.1.2 Language of Parts, AA).
//
// The document is <html lang="tr">, but five registered outlets publish in
// English. Their headlines and excerpts must carry lang="en" so a screen
// reader switches voice instead of pronouncing English with Turkish phonetics
// (~1,300 articles a week; h17-a11y-2).
//
// This is a CODE CONSTANT, not data: `public.sources` has no language column
// and this change adds no migration and writes nothing. Adding a sixth English
// outlet means adding its slug here (and its display name below).
//
// Two call shapes exist because two kinds of caller exist:
//   - /source/[slug] has the full source row, so it matches on the slug.
//   - Story cards project `sources ( id, name, bias, logo_url )` WITHOUT a
//     slug, so they match on the display name.
//
// Follow-up surfaces NOT wired in this wave (a cluster-page branch is in
// flight and owns these files): the per-article rows in
// src/components/story/story-timeline.tsx and
// src/components/story/framing-comparison.tsx, and the hero image alt in
// src/app/cluster/[id]/page.tsx (better served by the Turkish cluster headline
// than by an English article title). Each should call sourceLang() once that
// branch lands.

/** Slugs of the registered English-language outlets (exactly five). */
export const ENGLISH_SOURCE_SLUGS: ReadonlySet<string> = new Set([
  "a-news",
  "daily-sabah",
  "hurriyet-daily-news",
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
