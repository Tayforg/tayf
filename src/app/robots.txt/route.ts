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
// carried in the leading comment block, not enforced by robots.txt itself
// (robots.txt has no mechanism to enforce terms — it is a crawling
// directive, not a contract).
//
// No `License:` directive: Lighthouse's robots-txt audit flags `License:`
// as an unrecognised directive (it is RSL's robots.txt integration, not
// part of RFC 9309), so the pointer to the machine-readable terms lives in
// a `#`-prefixed comment below and in llms.txt itself, never as a bare
// directive line a strict parser could choke on.

// Bots that get the ALLOW-WITH-TERMS + /api/sources carve-out (plus the
// /api/v1/openapi.json and /api/oembed ones, see group()). The /api/sources carve-out exists
// because pack B (M-04) publishes the machine-readable source registry at
// /api/sources and /api/sources/{slug}; the whole point is that answer
// engines can fetch and cite it. Until pack B merges, requests to that path
// 404 — harmless, and worth a Disallow-free crawl slot regardless.
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
//
// `Allow: /api/v1/openapi.json` is the same kind of carve-out for the one
// keyless, static, public /api/v1 file: /llms.txt links crawlers to it, so
// it must not sit under `Disallow: /api/`. It is an exact file path, so the
// keyed endpoints (/api/v1/clusters, ...) and the rest of /api/ stay
// disallowed. tests/api/llms-txt.test.ts checks every llms.txt link against
// these rules.
//
// `Allow: /api/oembed` is the same kind of carve-out for the public oEmbed
// provider: every cluster page advertises it through
// <link rel="alternate" type="application/json+oembed"> (and Tayf serves that
// tag to WordPress, Iframely and Embedly on purpose, see
// src/lib/seo/html-limited-bots.ts), so a crawler that follows the tag must
// not be told by `Disallow: /api/` that the URL is off limits. The response is
// small and CDN-cached (s-maxage=3600, stale-while-revalidate=86400). Only the
// JSON endpoint is opened: the iframe it points at, /embed/, stays disallowed
// below (browsers load it, and the route already answers X-Robots-Tag:
// noindex), as does the rest of /api/. tests/api/robots.test.ts derives the
// path from oembedDiscoveryHref so renaming the endpoint breaks that guard.
// Keeping this in the shared group() means the carve-out cannot drift between
// groups.
function group(userAgent: string): string {
  return [
    `User-agent: ${userAgent}`,
    "Allow: /",
    "Allow: /api/sources",
    "Allow: /api/v1/openapi.json",
    "Allow: /api/oembed",
    "Disallow: /admin",
    "Disallow: /api/",
    // The script-less iframe widget (src/app/embed): a frame target for other
    // sites, not a page to index. It also answers X-Robots-Tag: noindex.
    "Disallow: /embed/",
    // Crawl hygiene (h31-bots-1). RFC 9309 wildcards: `*` matches any run of
    // characters, rules match from the start of path+query.
    //  - `/*?cluster=` and `/*?source=`: every cluster and source page links a
    //    per-entity /metodoloji?cluster=<uuid>#duzeltme or ?source=<slug>
    //    #duzeltme correction deep link. That is ~31.7k URLs for ONE static
    //    page (the correction form reads the params client-side, so a crawler
    //    sees identical HTML), and bots matched by htmlLimitedBots get an
    //    uncached function render of each. The links also carry rel="nofollow"
    //    (tests/guards/metodoloji-deep-links.test.ts); this keeps the variants
    //    that are already discovered out of the crawl queue. /metodoloji
    //    itself stays crawlable.
    //  - `/cluster/*/kart`: the shareable story card, a Satori PNG render per
    //    cluster (an uncached function render on a cache miss) that is a
    //    download for people, not a page; the cluster page itself, its
    //    opengraph-image and twitter-image are NOT matched and stay allowed.
    // Still allow-with-terms: no bare `Disallow: /` (see the file header).
    "Disallow: /*?cluster=",
    "Disallow: /*?source=",
    "Disallow: /cluster/*/kart",
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
# integration normally uses a License: line; Lighthouse flags that as an
# unknown directive, so the pointer to the machine-readable terms lives in
# this comment instead. The licence it declares (CC BY-SA 4.0) applies to
# Tayf's own output only (cluster groupings, neutral titles, Turkish
# summaries, zone labels, source-registry metadata) — outlet headlines,
# excerpts, photographs and full text remain the property of the
# publishing outlet and are NOT licensed by Tayf.
# License / Lisans (RSL): ${baseUrl}/llms.txt

${group("*")}

# --- AI / answer-engine bots: allow-with-terms, never block. -------------
# Allow: /api/sources is a carve-out for the M-04 source registry (pack B).
# It may 404 until that pack ships; that is expected and harmless.
# The OpenAPI file under /api/v1 is carved out too: it is the keyless contract
# that /llms.txt links to; the keyed /api/v1 endpoints themselves stay disallowed.
# So is /api/oembed, the public oEmbed provider that every cluster page
# advertises through <link rel="alternate" type="application/json+oembed">;
# the /embed/ iframe it points at stays disallowed.
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
