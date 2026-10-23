import { tallyZones, zoneOf } from "@/lib/bias/config";
import { zoneCountsOf, zonePercents } from "@/lib/bias/zone-summary";
import type { ClusterDetail } from "@/lib/clusters/cluster-detail-query";
import { isGameEligibleTitle } from "@/lib/game/pii-filter";
import type { MediaDnaZone } from "@/types";

import { escapeHtml } from "./embed-snippet";

// Renderer for the framed /embed/cluster/[id] document. A plain string
// builder, not React: the route handler returns a complete HTML document with
// ZERO JavaScript (app/layout.tsx always renders Header/Footer/Analytics, so a
// page.tsx cannot be chrome-less). Every interpolation goes through
// escapeHtml, and nothing here emits a <script>, <link>, <img>, font or any
// other external resource -- the /embed/ CSP (src/lib/security/headers.ts)
// allows none either.

export const EMBED_TITLE_MAX = 140;
/** Heading used when the cluster title fails the private-individual filter. */
export const EMBED_GENERIC_TITLE = "Bu haberin medya yelpazesi";

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

const ZONE_LABEL: Record<MediaDnaZone, string> = {
  iktidar: "İktidar",
  bagimsiz: "Bağımsız",
  muhalefet: "Muhalefet",
};

// Lowercase forms for the ribbon (same table as buildShareText in
// src/lib/clusters/share.ts); hardcoded rather than toLocaleLowerCase("tr").
const ZONE_LABEL_LOWER: Record<MediaDnaZone, string> = {
  iktidar: "iktidar",
  bagimsiz: "bağımsız",
  muhalefet: "muhalefet",
};

const ZONE_CLASS: Record<MediaDnaZone, string> = {
  iktidar: "zi",
  bagimsiz: "zb",
  muhalefet: "zm",
};

export interface EmbedModel {
  /** Already PII-checked and truncated; still escaped on render. */
  title: string;
  counts: Record<MediaDnaZone, number>;
  percents: Record<MediaDnaZone, number>;
  /** Sum of the three zone counts. 0 means nothing is classified yet. */
  total: number;
  /** wire.effectiveArticleCount: the honest "N kaynak". */
  sourceCount: number;
  ribbon: string | null;
  /** UTM-tagged cluster URL (raw; escaped on render). */
  href: string;
}

/**
 * A cluster title that is safe to show on a third-party page.
 *
 * The neutral cluster title may pass a member headline through verbatim, so
 * the same KVKK private-individual rule the kart route applies is applied
 * here (the rozet badge shows no titles at all). A rejected or empty title
 * becomes `fallback`; an accepted one is trimmed and cut BY CODE POINT (never
 * through a surrogate pair) to EMBED_TITLE_MAX characters including the
 * ellipsis.
 */
export function safeEmbedTitle(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || !isGameEligibleTitle(trimmed)) return fallback;
  const points = Array.from(trimmed);
  if (points.length <= EMBED_TITLE_MAX) return trimmed;
  return `${points.slice(0, EMBED_TITLE_MAX - 1).join("").trimEnd()}…`;
}

function ribbonOf(cluster: ClusterDetail["cluster"]): string | null {
  if (!cluster.is_blindspot) return null;
  // Same rule as buildShareText / the OG card: no recorded side falls back to
  // the tallied dominant zone, and "sadece" only holds at an exact 100% share
  // (the DB flag fires from 80%).
  const tally = tallyZones(cluster.bias_distribution);
  const zone: MediaDnaZone = cluster.blindspot_side
    ? zoneOf(cluster.blindspot_side)
    : (tally.dominantZone ?? "iktidar");
  const share = Math.round(tally.dominantShare * 100);
  return share === 100
    ? `Kör nokta: sadece ${ZONE_LABEL_LOWER[zone]} yazdı`
    : `Kör nokta: ${ZONE_LABEL_LOWER[zone]} ağırlıklı`;
}

export function buildEmbedModel(detail: ClusterDetail, origin: string): EmbedModel {
  const { cluster, wire } = detail;
  const counts = zoneCountsOf(cluster.bias_distribution);
  const base = origin.replace(/\/+$/, "");
  return {
    title: safeEmbedTitle(cluster.title_tr, EMBED_GENERIC_TITLE),
    counts,
    percents: zonePercents(counts),
    total: counts.iktidar + counts.bagimsiz + counts.muhalefet,
    sourceCount: wire.effectiveArticleCount,
    ribbon: ribbonOf(cluster),
    href: `${base}/cluster/${cluster.id}?utm_source=embed&utm_medium=iframe&utm_campaign=cluster`,
  };
}

// Layout budget (worst case, 320x200 with ribbon and a two-line legend):
// 2 border + 24 padding + 13.5 brand + 17 ribbon + 42.5 title (2 lines) +
// 10 bar + 32.4 legend (2 lines) + 16.2 link + 5x6 gaps = ~188px < 200.
// Frames shorter than 160px (oEmbed allows down to 120) drop the decorative
// brand line and tighten the padding so the ribbon, a one-line title, the bar,
// the legend and the link still fit. html/body never scroll; anything that
// still overflows is clipped rather than scrolled.
const STYLE = [
  ":root{--fg:#18181b;--mu:#52525b;--bg:#ffffff;--bd:#e4e4e7;--rb:#fef3c7;--rf:#92400e}",
  "@media (prefers-color-scheme: dark){:root{--fg:#fafafa;--mu:#a1a1aa;--bg:#0a0a0a;--bd:#27272a;--rb:#422006;--rf:#fcd34d}}",
  "*{box-sizing:border-box}",
  "html,body{margin:0;height:100%;overflow:hidden}",
  'body{background:var(--bg);color:var(--fg);font:14px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}',
  ".c{height:100%;display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid var(--bd);border-radius:8px;overflow:hidden}",
  ".b{flex:none;font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--mu)}",
  ".r{flex:none;align-self:flex-start;max-width:100%;padding:1px 8px;border-radius:999px;background:var(--rb);color:var(--rf);font-size:11px;font-weight:600}",
  "h1{flex:0 1 auto;min-height:21px;margin:0;font-size:17px;line-height:1.25;font-weight:700;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2}",
  ".bar{flex:none;display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--bd)}",
  ".bar span{display:block;height:100%}",
  ".zi{background:#ef4444}.zb{background:#a1a1aa}.zm{background:#10b981}",
  ".l{flex:none;margin:0;font-size:12px;color:var(--mu)}",
  ".a{flex:none;margin-top:auto;font-size:12px;font-weight:600;color:var(--fg);text-decoration:underline}",
  "@media (max-height:160px){.b{display:none}.c{padding:8px 12px;gap:4px}}",
].join("");

const HEAD_META =
  '<meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta name="color-scheme" content="light dark">' +
  '<meta name="robots" content="noindex,nofollow">';

function legendOf(model: EmbedModel): string {
  const sources = `${model.sourceCount} kaynak`;
  if (model.total === 0) return `Bu haberde henüz sınıflandırılmış kaynak yok · ${sources}`;
  const zones = ZONES.map((z) => `${ZONE_LABEL[z]} %${model.percents[z]}`).join(" · ");
  return `${zones} · ${sources}`;
}

function ariaLabelOf(model: EmbedModel): string {
  return ZONES.map((z) => `${ZONE_LABEL[z]} %${model.percents[z]}`).join(", ");
}

/** A complete, script-less HTML document for one cluster. */
export function renderEmbedHtml(model: EmbedModel): string {
  const e = escapeHtml;
  const bar = ZONES.map(
    (z) => `<span class="${ZONE_CLASS[z]}" style="width:${e(String(model.percents[z]))}%"></span>`,
  ).join("");
  const ribbon = model.ribbon ? `<div class="r">${e(model.ribbon)}</div>` : "";
  return (
    '<!doctype html><html lang="tr"><head>' +
    HEAD_META +
    `<title>${e(model.title)} · Tayf</title>` +
    `<style>${STYLE}</style></head><body><div class="c">` +
    '<div class="b">TAYF · Aynı haber, farklı dünyalar</div>' +
    ribbon +
    `<h1>${e(model.title)}</h1>` +
    `<div class="bar" role="img" aria-label="${e(ariaLabelOf(model))}">${bar}</div>` +
    `<p class="l">${e(legendOf(model))}</p>` +
    `<a class="a" href="${e(model.href)}" target="_blank" rel="noopener">tayfhaber.com'da oku →</a>` +
    "</div></body></html>"
  );
}

/**
 * Tiny status document (404 / 503) in the same minimal shell: noindex, no
 * script, no external resource. `message` is escaped.
 */
export function renderEmbedMessageHtml(message: string): string {
  const e = escapeHtml;
  return (
    '<!doctype html><html lang="tr"><head>' +
    HEAD_META +
    `<title>${e(message)} · Tayf</title>` +
    `<style>${STYLE}</style></head><body><div class="c">` +
    '<div class="b">TAYF · Aynı haber, farklı dünyalar</div>' +
    `<p class="l">${e(message)}</p>` +
    "</div></body></html>"
  );
}
