// M-05 — declared crawler terms, machine-readable half.
//
// /llms.txt is the target of /robots.txt's comment-form `License:` pointer
// (Lighthouse flags a bare `License:` robots.txt directive as unknown, so
// robots.txt carries it only in a `#` comment — see src/app/robots.txt/
// route.ts). It previously 404'd.
//
// Structured per llmstxt.org: `# Tayf`, a one-line `> ` summary, then h2
// sections. Every pointer is a markdown link `[Name](url): note` rather
// than a bare URL — bare URLs are unclickable in most llms.txt-aware
// readers and this format makes every reference machine-parseable.
//
// The licence string below MUST stay byte-identical to pack B's
// REGISTRY_LICENCE constant (the /api/sources registry licence field) so
// the two surfaces can never drift apart. If pack B's constant changes,
// update LICENCE here in the same change.
const LICENCE = "CC BY-SA 4.0 — Tayf'a göre";

// INTEGRATION TASK (tracked, not yet done): once pack B (M-04) lands its
// /api/sources registry and REGISTRY_LICENCE constant, replace the
// hardcoded LICENCE literal above with an import of that single shared
// constant so the two surfaces provably cannot drift on whitespace or the
// em-dash. Do not mark the "byte-identical to pack B's REGISTRY_LICENCE"
// acceptance criterion satisfied until that import exists.

// Loose but real e-mail shape check — deliberately does not try to be
// RFC 5322-complete, just enough to reject an obviously-malformed value
// (e.g. "x y") before it reaches a `mailto:` link. Read only the env var
// NAME here; its VALUE is never logged.
const EMAIL_RE = /^[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[^\s@<>()[\]]+$/;

function validContactEmail(): string | null {
  const value = process.env.NEXT_PUBLIC_CONTACT_EMAIL;
  if (!value) return null;
  return EMAIL_RE.test(value) ? value : null;
}

export function GET(): Response {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const contactEmail = validContactEmail();

  const contactLines = [
    contactEmail
      ? `- [E-posta](mailto:${contactEmail}): lisans, düzeltme ve kaldırma talepleri / licensing, correction and takedown requests`
      : null,
    `- [Düzeltme ve itiraz formu](${baseUrl}/metodoloji#duzeltme): düzeltme ve etiket itirazları / corrections and label disputes`,
    contactEmail
      ? null
      : "Tayf şu anda ayrı bir e-posta adresi yayımlamıyor; talepler için formu kullanın. / Tayf does not currently publish a separate e-mail address; please use the form.",
  ].filter((line): line is string => line !== null);

  const body = `# Tayf

> Türkiye haber kaynaklarını otomatik olarak kümeleyip aynı olayın farklı
> siyasi taraflarca nasıl anlatıldığını karşılaştıran bir haber analizi
> sitesi. / A Turkish news-analysis site that clusters coverage and
> compares how the same event is framed across the political spectrum.

## TR: Tayf nedir
Tayf, Türkiye haber kaynaklarını otomatik olarak kümeleyip aynı olayın
farklı siyasi taraflarca nasıl anlatıldığını karşılaştıran bir haber
analizi sitesidir. Yayınladığımız şey başlıklar, bağlantılar ve kısa
özetlerdir; kaynak metinlerin tam kopyası değildir.

## EN: What Tayf is
Tayf is a Turkish news-analysis site that automatically clusters news
coverage and compares how the same event is framed across the political
spectrum. What we publish is headlines, links and short summaries — not
full copies of source text.

## Lisans / Licence
${LICENCE} — applies to Tayf's own output only (cluster groupings, neutral
titles, Turkish summaries, zone labels, source-registry metadata) — see
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Outlet
headlines, excerpts, photographs and full text remain the property of the
publishing outlet and are NOT licensed by Tayf.
Required attribution: cite as "Tayf'a göre" (Turkish) / "According to
Tayf" (English), linking to [Metodoloji](${baseUrl}/metodoloji), which
also carries the full methodology and licence terms.

## Bağlantılar / Pointers
- [Metodoloji](${baseUrl}/metodoloji): methodology, zone-labelling rules, licence terms
- [Kaynaklar](${baseUrl}/sources): human-readable source registry
- [Kaynak durumu](${baseUrl}/kaynaklar/durum): live feed-health denominator for every source (last item time, last HTTP status, 7-day items/day, silent flag)
- [API: Kaynak kaydı](${baseUrl}/api/sources): machine-readable source registry (JSON)
- [API: Tekil kaynak kaydı](${baseUrl}/api/sources/{slug}): single-source registry record (JSON)
- [Geliştirici](${baseUrl}/gelistirici): developer docs for the keyed /api/v1 (TR, English code samples)
- [OpenAPI](${baseUrl}/api/v1/openapi.json): OpenAPI 3.1 description of /api/v1
- [Kör noktalar](${baseUrl}/blindspots): stories one political pole is not covering
- [RSS](${baseUrl}/rss.xml): RSS feed
- [Site haritası](${baseUrl}/sitemap.xml): sitemap

## Koşullar / Terms
TR: Tayf yalnızca başlık, bağlantı ve kısa özet yayınlar; kaynak
kuruluşların tam metinlerini veya fotoğraflarını yeniden lisanslamaz ya da
yeniden yayımlamaz — o haklar ilgili yayın kuruluşuna aittir. "İktidar" /
"muhalefet" gibi taraf etiketleri Tayf'ın kendi editoryal
değerlendirmesidir, resmî bir sınıflandırma değildir; itiraz/düzeltme
talebi için [Düzeltme ve itiraz](${baseUrl}/metodoloji#duzeltme) sayfasını kullanın.

EN: Tayf publishes only headlines, links and short summaries; it does not
relicense or republish outlet full text or photographs — those rights
remain with the publishing outlet. Zone labels such as "iktidar"
(pro-government) / "muhalefet" (opposition) are Tayf's own editorial
judgement, not an official classification; use
[Correction and dispute form](${baseUrl}/metodoloji#duzeltme) to dispute
or request a correction.

## İletişim / Contact
${contactLines.join("\n")}
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
