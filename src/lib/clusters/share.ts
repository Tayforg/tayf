import { tallyZones, zoneOf } from "@/lib/bias/config";
import {
  nonVotingOutsideZone,
  onlyZoneClaim,
  zoneCountsOf,
  zonePercents,
} from "@/lib/bias/zone-summary";
import { wireBadgeShort } from "@/lib/clusters/wire";
import { cutAtWord } from "@/lib/seo/og-title";
import type { BiasCategory, BiasDistribution, MediaDnaZone, SourceKind } from "@/types";

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
 * e.g. "10 kaynak · %70 iktidar · %20 bağımsız · %10 muhalefet", plus
 * " · Kör nokta: sadece iktidar yazdı" when the cluster is a blindspot.
 *
 * "Sadece X yazdı" is decided on the voting tally. When `sources` (the cluster's
 * members de-duplicated per source) holds a toplayıcı / niş source from another
 * zone, "yazdı" would be false, so the suffix says what the spectrum shows:
 * " · Kör nokta: spektrumda sadece iktidar" (h57-outbound-1, the wording
 * /blindspots and the cluster timeline already use). Without `sources`, or with
 * no such outsider, the text is exactly what it always was.
 *
 * The percents are over the CLASSIFIED (voting) sources, while `articleCount`
 * also counts aggregator / niche members. When fewer sources voted than
 * `articleCount`, the head names the voting total so the text never sets one
 * denominator next to percents of another:
 * "14 kaynak · 11 sınıflandırılmış: %55 iktidar · %9 bağımsız · %36 muhalefet".
 * With nobody classified there is no percent to print:
 * "2 kaynak · sınıflandırılmış kaynak yok". When the votes outnumber
 * `articleCount` -- the wire case, where the page passes the distinct-text
 * count -- the head names the voting total in news items:
 * "2 kaynak · 5 sınıflandırılmış haber: %80 iktidar · %0 bağımsız · %20 muhalefet".
 * Only when the two counts are equal does the head stay plain.
 *
 * `recallMatchedZones` (h108-sharesurfaces-1) is `ClusterDetail.recallMatchedZones`:
 * the silent zones in which Jev's recall stage matched a voting source with this
 * story's event, a similar story sitting in another cluster. "Sadece X yazdı" is
 * then not something the data supports, so the suffix says what THIS cluster
 * shows, as /blindspots does: " · Kör nokta: kümede sadece iktidar". The
 * toplayıcı / niş qualifier keeps its own wording ahead of it. Undefined (a cache
 * entry from before the field) or [] (a failed lookup) leaves the text exactly as
 * it was. Wording only: no count, percent or flag reads it.
 */
export function buildShareText(input: {
  articleCount: number;
  distribution: BiasDistribution;
  isBlindspot: boolean;
  blindspotSide: BiasCategory | null;
  wire?: { isWireRedistribution: boolean; memberCount: number };
  sources?: readonly { kind?: SourceKind | null; bias: BiasCategory }[];
  recallMatchedZones?: readonly MediaDnaZone[];
}): string {
  const {
    articleCount,
    distribution,
    isBlindspot,
    blindspotSide,
    wire,
    sources,
    recallMatchedZones,
  } = input;
  const counts = zoneCountsOf(distribution);
  const percents = zonePercents(counts);

  const classified = counts.iktidar + counts.bagimsiz + counts.muhalefet;

  let text: string;
  if (!(classified > 0)) {
    text = `${articleCount} kaynak · sınıflandırılmış kaynak yok`;
  } else {
    const pcts = [
      `%${percents.iktidar} iktidar`,
      `%${percents.bagimsiz} bağımsız`,
      `%${percents.muhalefet} muhalefet`,
    ].join(" · ");
    if (classified < articleCount) {
      text = `${articleCount} kaynak · ${classified} sınıflandırılmış: ${pcts}`;
    } else if (classified > articleCount) {
      // Only a wire cluster gets here (the page passes the distinct-text
      // count as `articleCount`, while every classified member votes), so the
      // votes are news items, not sources.
      text = `${articleCount} kaynak · ${classified} sınıflandırılmış haber: ${pcts}`;
    } else {
      text = `${articleCount} kaynak · ${pcts}`;
    }
  }

  if (isBlindspot) {
    // Same "no reported side → fall back to the tallied dominant zone"
    // rule as the OG card's ribbon (opengraph-image.tsx). The DB flag fires
    // at >= BLINDSPOT.dominantShare (80%), so "sadece {zone} yazdı" holds
    // only when the other two zones have no source at all: decided on the
    // counts, not on a rounded 100 (250/1/0 rounds to 100, another zone
    // still has a source).
    const tally = tallyZones(distribution);
    const zone = blindspotSide ? zoneOf(blindspotSide) : (tally.dominantZone ?? "iktidar");
    const claim = onlyZoneClaim(
      counts,
      zone,
      sources ? nonVotingOutsideZone(sources, zone) : 0,
      recallMatchedZones?.length ?? 0,
    );
    text +=
      claim === "only"
        ? ` · Kör nokta: sadece ${ZONE_LABEL_LOWER[zone]} yazdı`
        : claim === "spectrumOnly"
          ? ` · Kör nokta: spektrumda sadece ${ZONE_LABEL_LOWER[zone]}`
          : claim === "clusterOnly"
            ? ` · Kör nokta: kümede sadece ${ZONE_LABEL_LOWER[zone]}`
            : ` · Kör nokta: ${ZONE_LABEL_LOWER[zone]} ağırlıklı`;
  }

  if (wire?.isWireRedistribution) {
    // `articleCount` is the honest (distinct-text) count, so it doubles as the
    // number of distinct texts here; see wireBadgeShort.
    text += ` · ${wireBadgeShort(wire.memberCount, articleCount)}`;
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

/** Cuts `body` at a word to at most `max` code points, "…" included, once it is
 *  longer — X and Bluesky both have a hard character cap on the composed post.
 *  The body is a headline, so it is cut like every other share surface
 *  (cutAtWord, tests/guards/no-hard-title-cut); a surrogate pair is never split,
 *  which a plain `slice` could do and make `encodeURIComponent` throw. */
function truncate(body: string, max: number): string {
  return cutAtWord(body, max);
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
