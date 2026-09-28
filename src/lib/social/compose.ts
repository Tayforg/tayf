import { formatZoneLine, zoneCountsFromSources } from "@/lib/feeds/zone-line";
import { withUtm } from "@/lib/feeds/rss-builder";
import { ZONE_META } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone } from "@/types";

// Pure text composition for the owned-channels auto-poster. Telegram gets
// the full text plus a URL line (link_preview_options carries the actual
// preview); Bluesky gets the same story WITHOUT a URL line — the link goes
// in the post's embed (app.bsky.embed.external), which avoids byte-offset
// facets entirely.
//
// Deliberately says "az ya da hiç haber yok", never "görmezden geldi": the
// absence can be a clustering split rather than a deliberate editorial
// choice (see the wave-1 timeline copy this mirrors).

const BLUESKY_MAX_GRAPHEMES = 300;

export interface ComposeSource {
  bias: BiasCategory;
}

export interface ComposeBlindspotInput {
  title: string;
  clusterUrl: string;
  dominantZone: MediaDnaZone;
  sources: ReadonlyArray<ComposeSource>;
}

export interface ComposeTopStoryInput {
  title: string;
  clusterUrl: string;
  sources: ReadonlyArray<ComposeSource>;
}

export interface TelegramText {
  text: string;
  url: string;
}

export interface BlueskyEmbed {
  uri: string;
  title: string;
  description: string;
}

export interface BlueskyText {
  text: string;
  embed: BlueskyEmbed;
}

function utmUrl(clusterUrl: string, channel: "telegram" | "bluesky", campaign: "kor_nokta" | "gundem"): string {
  return withUtm(clusterUrl, { source: channel, medium: "social", campaign });
}

export function composeTelegramBlindspot(input: ComposeBlindspotInput): TelegramText {
  const counts = zoneCountsFromSources(input.sources);
  const zoneLine = formatZoneLine(counts);
  const n = input.sources.length;
  const zoneLabel = ZONE_META[input.dominantZone].label;
  const url = utmUrl(input.clusterUrl, "telegram", "kor_nokta");

  const lines = [
    `Kör nokta · ${zoneLabel} ağırlıklı haber`,
    input.title,
    `${n} kaynak: ${zoneLine}`,
    "Diğer bölgelerden bu kümede az ya da hiç haber yok.",
    url,
  ];

  return { text: lines.join("\n"), url };
}

export function composeTelegramTopStory(input: ComposeTopStoryInput): TelegramText {
  const counts = zoneCountsFromSources(input.sources);
  const zoneLine = formatZoneLine(counts);
  const n = input.sources.length;
  const url = utmUrl(input.clusterUrl, "telegram", "gundem");
  const zoneCount = countZonesCovered(counts);

  const lines = [
    `Gündem · ${n} kaynak, ${zoneCount} bölge`,
    input.title,
    zoneLine,
    `Kim nasıl yazdı: ${url}`,
  ];

  return { text: lines.join("\n"), url };
}

function countZonesCovered(counts: Record<MediaDnaZone, number>): number {
  return (Object.values(counts) as number[]).filter((c) => c > 0).length;
}

/** Truncates `title` to fit within `maxGraphemes` total (title + '…' +
 * separator budget is the caller's job); uses Intl.Segmenter('tr',
 * {granularity: 'grapheme'}) so multi-codepoint emoji and Turkish
 * combining marks are never split mid-grapheme. */
function truncateGraphemes(text: string, maxGraphemes: number): string {
  const segmenter = new Intl.Segmenter("tr", { granularity: "grapheme" });
  const graphemes = Array.from(segmenter.segment(text), (s) => s.segment);
  if (graphemes.length <= maxGraphemes) return text;
  return graphemes.slice(0, Math.max(0, maxGraphemes - 1)).join("") + "…";
}

function graphemeLength(text: string): number {
  const segmenter = new Intl.Segmenter("tr", { granularity: "grapheme" });
  return Array.from(segmenter.segment(text)).length;
}

/** Builds Bluesky text without a URL line (the URL goes in the embed) and
 * truncates the TITLE first (not the whole composed text) if the overall
 * text would exceed 300 graphemes, appending '…'. */
function buildBlueskyText(lines: string[], titleIndex: number): string {
  let candidateLines = [...lines];
  let text = candidateLines.join("\n");

  if (graphemeLength(text) <= BLUESKY_MAX_GRAPHEMES) return text;

  // Budget for the title: total budget minus every other line's length
  // (plus newlines).
  const others = candidateLines.filter((_, i) => i !== titleIndex);
  const othersLength =
    others.reduce((sum, l) => sum + graphemeLength(l), 0) + others.length; // +1 newline per other line (approx, safe upper bound)
  const titleBudget = Math.max(0, BLUESKY_MAX_GRAPHEMES - othersLength);

  candidateLines = candidateLines.map((line, i) =>
    i === titleIndex ? truncateGraphemes(line, titleBudget) : line,
  );
  text = candidateLines.join("\n");

  // Final safety clamp in case rounding still overshoots.
  if (graphemeLength(text) > BLUESKY_MAX_GRAPHEMES) {
    text = truncateGraphemes(text, BLUESKY_MAX_GRAPHEMES);
  }
  return text;
}

export function composeBlueskyBlindspot(input: ComposeBlindspotInput): BlueskyText {
  const counts = zoneCountsFromSources(input.sources);
  const zoneLine = formatZoneLine(counts);
  const n = input.sources.length;
  const zoneLabel = ZONE_META[input.dominantZone].label;
  const url = utmUrl(input.clusterUrl, "bluesky", "kor_nokta");

  const lines = [
    `Kör nokta · ${zoneLabel} ağırlıklı haber`,
    input.title,
    `${n} kaynak: ${zoneLine}`,
    "Diğer bölgelerden bu kümede az ya da hiç haber yok.",
  ];

  const text = buildBlueskyText(lines, 1);

  return {
    text,
    embed: { uri: url, title: input.title, description: zoneLine },
  };
}

export function composeBlueskyTopStory(input: ComposeTopStoryInput): BlueskyText {
  const counts = zoneCountsFromSources(input.sources);
  const zoneLine = formatZoneLine(counts);
  const n = input.sources.length;
  const zoneCount = countZonesCovered(counts);
  const url = utmUrl(input.clusterUrl, "bluesky", "gundem");

  const lines = [`Gündem · ${n} kaynak, ${zoneCount} bölge`, input.title, zoneLine];

  const text = buildBlueskyText(lines, 1);

  return {
    text,
    embed: { uri: url, title: input.title, description: zoneLine },
  };
}
