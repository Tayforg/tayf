import { escapeXml } from "@/lib/feeds/rss-builder";
import { sourceCountHead } from "@/lib/feeds/zone-line";
import { zonePercents } from "@/lib/bias/zone-summary";
import { ENGLISH_ONLY_BADGE_TAG, ENGLISH_ONLY_SHARE_CLAUSE } from "@/lib/sources/source-language";
import type { MediaDnaZone } from "@/types";

// "Yelpaze rozeti": a 320x48 SVG showing the iktidar/bagimsiz/muhalefet
// split of a cluster. Pure and deterministic; it only ever contains numbers
// and fixed strings (never a cluster title or outlet name), and every text
// node and attribute still goes through escapeXml.

const WIDTH = 320;
const HEIGHT = 48;
const BAR_X = 64;
const BAR_W = 176;
const BAR_H = 10;
const BAR_Y = 12;

const ZONE_COLOR: Record<MediaDnaZone, string> = {
  iktidar: "#ef4444",
  bagimsiz: "#a1a1aa",
  muhalefet: "#10b981",
};
const ZONE_ORDER: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];
const FONT = "system-ui, -apple-system, Segoe UI, sans-serif";

function safeInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * `languageIsolated` (h118-shares-1) is `isLanguageIsolatedCluster(...)`: every
 * member is an English-language outlet. The percents would then read as a
 * zone-absence claim the cluster page does not make, so the aria-label, the
 * <title> and the small text carry the qualifier instead ("Tayf yelpazesi:
 * yalnızca İngilizce kaynaklar, Türkçe haberlerle karşılaştırılmadı · N kaynak",
 * "N kaynak · yalnızca İngilizce"). The bar is the cluster's own and is drawn as
 * before. Omitted or false leaves the badge byte for byte as it was.
 */
export function renderSpectrumBadgeSvg(input: {
  zones: Record<MediaDnaZone, number>;
  sourceCount: number;
  languageIsolated?: boolean;
}): string {
  const n = safeInt(input.sourceCount);
  const total = ZONE_ORDER.reduce((a, z) => a + safeInt(input.zones[z]), 0);
  const empty = total <= 0;
  const counts: Record<MediaDnaZone, number> = {
    iktidar: safeInt(input.zones.iktidar),
    bagimsiz: safeInt(input.zones.bagimsiz),
    muhalefet: safeInt(input.zones.muhalefet),
  };
  const pct = zonePercents(counts);
  // The percents are over the classified (voting) sources only, while `n` is
  // wire.effectiveArticleCount: the deduped member count for a normal cluster,
  // the distinct-text count for a wire redistribution. sourceCountHead adds
  // '(M sınıflandırılmış)' only when the voting count M is smaller than N:
  // 'N kaynak (M sınıflandırılmış)' when M < N, plain 'N kaynak' otherwise. For
  // a wire cluster whose votes exceed N the head stays plain, a known gap
  // against buildShareText's 'M sınıflandırılmış haber' left for a follow-up.
  const head = sourceCountHead(n, counts);

  const label = input.languageIsolated
    ? `Tayf yelpazesi: ${ENGLISH_ONLY_SHARE_CLAUSE} · ${n} kaynak`
    : empty
      ? "Tayf yelpazesi: sınıflandırılmış kaynak yok"
      : `Tayf yelpazesi: İktidar %${pct.iktidar}, Bağımsız %${pct.bagimsiz}, Muhalefet %${pct.muhalefet} · ${head}`;
  const caption = input.languageIsolated
    ? `${n} kaynak · ${ENGLISH_ONLY_BADGE_TAG}`
    : empty
      ? `${n} kaynak`
      : `${head} · %${pct.iktidar}/%${pct.bagimsiz}/%${pct.muhalefet}`;

  let bar: string;
  if (empty) {
    bar = `<rect data-seg="none" x="${BAR_X}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="3" fill="#3f3f46"/>`;
  } else {
    const parts: string[] = [];
    let x = BAR_X;
    let used = 0;
    ZONE_ORDER.forEach((zone, i) => {
      const w = i === ZONE_ORDER.length - 1 ? BAR_W - used : Math.round((pct[zone] / 100) * BAR_W);
      used += w;
      parts.push(
        `<rect data-seg="${zone}" x="${x}" y="${BAR_Y}" width="${w}" height="${BAR_H}" fill="${ZONE_COLOR[zone]}"/>`,
      );
      x += w;
    });
    bar = `<g clip-path="url(#tayf-bar)">${parts.join("")}</g>`;
  }

  const esc = escapeXml(label);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${esc}">`,
    `<title>${esc}</title>`,
    `<defs><clipPath id="tayf-bar"><rect x="${BAR_X}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="3"/></clipPath></defs>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" rx="8" fill="#0a0a0a"/>`,
    `<text x="12" y="30" font-family="${escapeXml(FONT)}" font-size="18" font-weight="700" fill="#fafafa">${escapeXml("Tayf")}</text>`,
    bar,
    `<text x="${BAR_X}" y="40" font-family="${escapeXml(FONT)}" font-size="10" fill="#a1a1aa">${escapeXml(caption)}</text>`,
    `</svg>`,
  ].join("");
}
