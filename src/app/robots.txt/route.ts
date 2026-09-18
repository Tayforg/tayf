// M-05 — declared crawler terms.
//
// This used to be `src/app/robots.ts` (Next's typed MetadataRoute.Robots
// export). That API can only emit userAgent/allow/disallow/crawlDelay/
// sitemap — it cannot emit comments and it cannot emit an RSL `License:`
// line, and RSL's robots.txt integration IS a `License:` line, not a
// comment (https://rslstandard.org). So this is a raw route handler
// instead. Next maps app/robots.txt/route.ts to /robots.txt exactly the
// way the metadata file did; the old file was deleted so the two can't
// both resolve to the same path at build time.
//
// Every AI-bot group below is ALLOW-WITH-TERMS, never Disallow: blocking a
// crawler removes Tayf from the retrieval set it wants citations from,
// which is the exact failure mode M-05 exists to avoid. The terms are
// carried in the leading comment block and in License:, not enforced by
// robots.txt itself (robots.txt has no mechanism to enforce terms — it is
// a crawling directive, not a contract).

// Bots that get the ALLOW-WITH-TERMS + /api/sources carve-out. The
// carve-out exists because pack B (M-04) publishes the machine-readable
// source registry at /api/sources and /api/sources/{slug}; the whole
// point is that answer engines can fetch and cite it. Until pack B merges,
// requests to that path 404 — harmless, and worth a Disallow-free crawl
// slot regardless.
//
// The same carve-out is extended to Googlebot, Bingbot and the default
// `User-agent: *` group below (via the shared `group()` helper) — without
// it, robots.txt's exclusive group-matching would leave the single most
// important AI-answer crawler (Googlebot, which governs AI Overviews/SGE
// inclusion) locked out of the registry this file exists to expose.
//
// NOTE: Google-Extended is a training-data opt-out signal only. It has no
// effect on Google AI Overviews / SGE inclusion, which is governed by
// Googlebot. Do not present it later as an AI-Overviews control.
const AI_BOT_USER_AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "CCBot",
  "Bytespider",
  "Applebot-Extended",
  "Amazonbot",
  "meta-externalagent",
  "cohere-ai",
  "Diffbot",
  "Timpibot",
];

// Shared by every group in this file (AI bots, Googlebot, Bingbot, the
// default `*` group) so the /api/sources carve-out — and any future
// group-wide rule — can't drift between them. Under RFC 9309
// longest-match-wins, the 12-character `Allow: /api/sources` correctly
// beats the 5-character `Disallow: /api/` for that path.
function group(userAgent: string): string {
  return [
    `User-agent: ${userAgent}`,
    "Allow: /",
    "Allow: /api/sources",
    "Disallow: /admin",
    "Disallow: /api/",
  ].join("\n");
}

export function GET(): Response {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const body = `# Tayf (tayfhaber.com) — crawler terms / tarama koşulları
#
# TR: Bu sitenin taranmasına ve içeriğin özetlenip alıntılanmasına izin
# verilir; atıf zorunludur ("Tayf'a göre" / tayfhaber.com). Bu izin,
# başlıkların ve bağlantıların tam metin olarak yeniden yayımlanmasını
# kapsamaz. Tayf, bağlantı verdiği kaynak sitelerin alıntıları üzerinde
# hak sahibi değildir; o haklar ilgili yayın kuruluşuna aittir.
#
# EN: Crawling and summarising/quoting this site's content is allowed;
# attribution is required ("Tayf'a göre" / tayfhaber.com). This does not
# grant full-text republication of headlines or linked articles. Tayf does
# not hold rights over the outlet excerpts it links to — those rights
# remain with the publishing outlet.
#
# RSL (Really Simple Licensing, https://rslstandard.org) robots.txt
# integration: the License: line below points at the machine-readable
# terms. The licence it declares (CC BY-SA 4.0) applies to Tayf's own
# output only (cluster groupings, neutral titles, Turkish summaries, zone
# labels, source-registry metadata) — outlet headlines, excerpts,
# photographs and full text remain the property of the publishing outlet
# and are NOT licensed by Tayf. See llms.txt for the machine-readable form
# of this scoping statement.
License: ${baseUrl}/llms.txt

${group("*")}

# --- AI / answer-engine bots: allow-with-terms, never block. -------------
# Allow: /api/sources is a carve-out for the M-04 source registry (pack B).
# It may 404 until that pack ships; that is expected and harmless.
${AI_BOT_USER_AGENTS.map(group).join("\n\n")}

${group("Googlebot")}

${group("Bingbot")}

Sitemap: ${baseUrl}/sitemap.xml
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
