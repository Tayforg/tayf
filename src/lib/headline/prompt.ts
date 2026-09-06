// Neutral-headline rewrite prompt — moved verbatim from
// `src/app/api/cron/headline/route.ts` (the cron route imports
// `buildHeadlinePrompt` back from here) so `/metodoloji` can display the
// exact prompt template without duplicating it.

// Minimum member-article count before a cluster is eligible for the
// neutral-headline rewrite (mirrors the cron route's own gate — see
// `idx_clusters_needs_rewrite` / the `.gte("article_count", ...)` query in
// `src/app/api/cron/headline/route.ts`). Exported so /metodoloji can state
// the threshold without hardcoding a literal that could drift from the
// route's actual gate.
export const HEADLINE_MIN_ARTICLE_COUNT = 3;

export const HEADLINE_PROMPT_TEMPLATE = `Aşağıda 8 farklı Türk haber kaynağının aynı haber için yazdığı başlıklar var. Bu haberleri toplu bir tarafsız başlığa indirgemen gerekiyor.

KURALLAR:
- En fazla 80 karakter
- Tarafsız, olgusal, sıfat içermeyen
- Hiçbir kaynağın tonunu kopyalama
- Açık şekilde olayı anlat
- "Şok!", "Son dakika!", "Kahreden..." gibi clickbait yasak
- Türkçe olmalı
- Sadece başlığı yaz, başka açıklama yok

KAYNAK BAŞLIKLARI:
{titles}

TARAFSIZ TOPLU BAŞLIK:`;

/**
 * Build the neutral-headline rewrite prompt for a batch of source titles.
 * Mirrors the cron route's original inline template exactly (same rules,
 * same 8-title cap, same numbered-list formatting).
 */
export function buildHeadlinePrompt(titles: string[]): string {
  const memberTitles = titles
    .slice(0, 8)
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");

  // Function replacer, NOT a plain string: String.prototype.replace treats
  // a string replacement as a pattern (`$&`, `$'`, `` $` ``, `$$`, `$n` all
  // have special meaning), so a title containing e.g. "40$'ı aştı" would
  // splice template text into the title list. A function replacer inserts
  // its return value literally.
  return HEADLINE_PROMPT_TEMPLATE.replace("{titles}", () => memberTitles);
}
