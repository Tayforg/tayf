import { tallyZones, zoneOf } from "@/lib/bias/config";
import { zoneCountsOf, zonePercents } from "@/lib/bias/zone-summary";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";

// Lowercase Turkish zone labels for share text. `ZONE_META` labels
// ("İktidar", "Bağımsız", "Muhalefet" in src/lib/bias/config.ts) are
// capitalized for UI chips; hardcoding the lowercase forms here avoids
// depending on `toLocaleLowerCase("tr")` (dotted/dotless İ/I handling)
// for what is only a 3-entry table.
const ZONE_LABEL_LOWER: Record<MediaDnaZone, string> = {
  iktidar: "iktidar",
  bagimsiz: "bağımsız",
  muhalefet: "muhalefet",
};

/**
 * Builds the text handed to `navigator.share` / the clipboard fallback
 * (see `ShareButton`) so a shared cluster link argues the bias story
 * before the click. Turkish percent formatting puts the sign first
 * ("%70"), so this is plain string interpolation, not
 * `Intl.NumberFormat`.
 *
 * e.g. "12 kaynak · %70 iktidar · %20 bağımsız · %10 muhalefet", plus
 * " · Kör nokta: sadece iktidar yazdı" when the cluster is a blindspot.
 */
export function buildShareText(input: {
  articleCount: number;
  distribution: BiasDistribution;
  isBlindspot: boolean;
  blindspotSide: BiasCategory | null;
  wire?: { isWireRedistribution: boolean; memberCount: number };
}): string {
  const { articleCount, distribution, isBlindspot, blindspotSide, wire } = input;
  const counts = zoneCountsOf(distribution);
  const percents = zonePercents(counts);

  let text = [
    `${articleCount} kaynak`,
    `%${percents.iktidar} iktidar`,
    `%${percents.bagimsiz} bağımsız`,
    `%${percents.muhalefet} muhalefet`,
  ].join(" · ");

  if (isBlindspot) {
    // Same "no reported side → fall back to the tallied dominant zone"
    // rule as the OG card's ribbon (opengraph-image.tsx). The DB flag now
    // fires at >= BLINDSPOT.dominantShare (80%), so "sadece {zone} yazdı"
    // only holds at an exact 100% share.
    const tally = tallyZones(distribution);
    const zone = blindspotSide ? zoneOf(blindspotSide) : (tally.dominantZone ?? "iktidar");
    const share = Math.round(tally.dominantShare * 100);
    text +=
      share === 100
        ? ` · Kör nokta: sadece ${ZONE_LABEL_LOWER[zone]} yazdı`
        : ` · Kör nokta: ${ZONE_LABEL_LOWER[zone]} ağırlıklı`;
  }

  if (wire?.isWireRedistribution) {
    text += ` · tek kaynaktan ${wire.memberCount} kopya`;
  }

  return text;
}

// ---------------------------------------------------------------------------
// Per-channel share links (seo-share). Pure — no window/navigator access —
// so `ShareButton` ('use client') can compute every href during render
// (including on the server: reader-data's cluster-page.test SSRs this
// component) instead of only inside a click handler.
// ---------------------------------------------------------------------------

export type ShareChannel = "whatsapp" | "telegram" | "x" | "bluesky" | "copy" | "native";

/** The 4 channels that render as a share-chip link (as opposed to the
 *  existing native-share / clipboard button). */
export const SHARE_LINK_CHANNELS = ["whatsapp", "telegram", "x", "bluesky"] as const;

/**
 * Builds the UTM-tagged cluster URL for one channel.
 *
 * `origin` is caller-supplied rather than read from `window`/`siteUrl()`
 * here so this stays a pure function: the native-share/clipboard path in
 * `ShareButton` passes `window.location.origin` (click-time only), and the
 * 4 channel chips pass `siteUrl()` (safe at render time, server or client).
 */
export function buildShareUrl(
  origin: string,
  clusterId: string,
  channel: ShareChannel,
): string {
  const base = origin.replace(/\/$/, "");
  return (
    `${base}/cluster/${encodeURIComponent(clusterId)}` +
    `?utm_source=${channel}&utm_medium=share&utm_campaign=cluster`
  );
}

const CHANNEL_TEXT_LIMIT = 240;

/** Appends "…" once `body` exceeds `max` characters — X and Bluesky both
 *  have a hard character cap on the composed post. */
function truncate(body: string, max: number): string {
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

/**
 * Builds the prefilled share-intent href for one of the 4 link channels.
 * `url` should already be a `buildShareUrl(...)` result (UTM-tagged);
 * `body` is `buildShareText`'s bias line (or the headline, see
 * `ShareButton`).
 */
export function buildChannelShareHref(
  channel: (typeof SHARE_LINK_CHANNELS)[number],
  url: string,
  body: string,
): string {
  const enc = encodeURIComponent;

  switch (channel) {
    case "whatsapp":
      return `https://wa.me/?text=${enc(`${body}\n${url}`)}`;
    case "telegram":
      return `https://t.me/share/url?url=${enc(url)}&text=${enc(body)}`;
    case "x":
      return `https://twitter.com/intent/tweet?text=${enc(
        truncate(body, CHANNEL_TEXT_LIMIT),
      )}&url=${enc(url)}`;
    case "bluesky":
      return `https://bsky.app/intent/compose?text=${enc(
        `${truncate(body, CHANNEL_TEXT_LIMIT)} ${url}`,
      )}`;
  }
}
