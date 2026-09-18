// M-05 — declared crawler terms, machine-readable half.
//
// /llms.txt is the target of /robots.txt's `License:` line (RSL-style
// robots.txt integration, https://rslstandard.org). It previously 404'd.
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

export function GET(): Response {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const body = `# Tayf — llms.txt

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

## Licence / Lisans
${LICENCE} — applies to Tayf's own output only (cluster groupings, neutral
titles, Turkish summaries, zone labels, source-registry metadata). Outlet
headlines, excerpts, photographs and full text remain the property of the
publishing outlet and are NOT licensed by Tayf.
Required attribution: cite as "Tayf'a göre" (Turkish) / "According to
Tayf" (English), linking to ${baseUrl}/metodoloji. See ${baseUrl}/metodoloji
for the full methodology and licence terms.

## Pointers / Bağlantılar
- ${baseUrl}/metodoloji — methodology, zone-labelling rules, licence terms
- ${baseUrl}/sources — human-readable source registry
- ${baseUrl}/kaynaklar/durum — live feed-health denominator for every
  source (last item time, last HTTP status, 7-day items/day, silent flag)
- ${baseUrl}/api/sources — machine-readable source registry (JSON)
- ${baseUrl}/api/sources/{slug} — single-source registry record (JSON)
- ${baseUrl}/blindspots — stories one political pole is not covering
- ${baseUrl}/rss.xml — RSS feed
- ${baseUrl}/sitemap.xml — sitemap

## Terms / Koşullar
TR: Tayf yalnızca başlık, bağlantı ve kısa özet yayınlar; kaynak
kuruluşların tam metinlerini veya fotoğraflarını yeniden lisanslamaz ya da
yeniden yayımlamaz — o haklar ilgili yayın kuruluşuna aittir. "İktidar" /
"muhalefet" gibi taraf etiketleri Tayf'ın kendi editoryal
değerlendirmesidir, resmî bir sınıflandırma değildir; itiraz/düzeltme
talebi için ${baseUrl}/metodoloji#duzeltme adresini kullanın.

EN: Tayf publishes only headlines, links and short summaries; it does not
relicense or republish outlet full text or photographs — those rights
remain with the publishing outlet. Zone labels such as "iktidar"
(pro-government) / "muhalefet" (opposition) are Tayf's own editorial
judgement, not an official classification; use ${baseUrl}/metodoloji#duzeltme
to dispute or request a correction.

## Contact / İletişim
For licensing, correction or takedown requests, see the contact details at
${baseUrl}/metodoloji.
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
