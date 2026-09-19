import { ImageResponse } from "next/og";

import { selectStoryCard, type StoryCard } from "@/lib/cards/story-card";
import { getClusterDetail } from "@/lib/clusters/cluster-detail-query";
import { getZoneFeedHealth } from "@/lib/clusters/feed-health";
import { formatDdMmYyyy } from "@/lib/format/date-tr";
import { isGameEligibleTitle } from "@/lib/game/pii-filter";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import type { MediaDnaZone } from "@/types";

// U-02 "Manşet Kartı" — the 9:16 (1080×1920) story card a reader can save
// and post. Deliberately a route handler rather than a file-convention
// image so it has a stable, linkable URL ("Kartı indir" on the cluster
// page) instead of Next's hashed /opengraph-image path.
//
// Editorial contract — mostly enforced by the data layer (src/lib/cards/
// story-card.ts), with the two exceptions this file has to handle itself:
//   * headlines ONLY — no excerpt, no summary, no article image, so the
//     card needs no `excerpt_allowed` right from any outlet; outlet names
//     and their own headlines are all it shows.
//   * every per-zone headline has already cleared `isGameEligibleTitle`
//     (the KVKK private-individual filter) in story-card.ts. The cluster
//     TITLE has not: `cluster.title_tr` is the neutral title, which
//     `pickNeutralTitle` may pass through verbatim from a member headline
//     — so this route applies `isGameEligibleTitle` to it below (G-PRIV-1)
//     and 404s rather than rasterising a name into the card's largest text.
//   * a zone with no printable headline says which of the two reasons
//     applies — genuinely nobody wrote, or somebody wrote and the headline
//     is not shareable — because the coverage counter beside it would
//     otherwise contradict a blanket "no news here".
//   * every count carries its denominator (the zone yield), and an
//     unknown, zero or count-exceeding denominator says so in words
//     instead of printing an impossible fraction.
//
// Satori (the engine behind ImageResponse) supports no Tailwind, no grid
// and no pseudo-elements: every rule below is an inline `style`, every
// element with more than one child sets `display: "flex"` explicitly, and
// only Satori's bundled Geist-Regular (weight 400) is available.
//
// Next 16 `cacheComponents`: no `export const dynamic`/`revalidate` here —
// freshness is expressed through the response's Cache-Control below.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

const ZONE_STYLE: Record<
  MediaDnaZone,
  { label: string; bar: string; text: string }
> = {
  iktidar: { label: "İktidar", bar: "#ef4444", text: "#fecaca" },
  bagimsiz: { label: "Bağımsız", bar: "#a1a1aa", text: "#e4e4e7" },
  muhalefet: { label: "Muhalefet", bar: "#10b981", text: "#a7f3d0" },
};

const GROUND = "#0a0a0a";
const FOREGROUND = "#fafafa";
const MUTED = "#a1a1aa";
const DIM = "#71717a";
const WARN = "#fbbf24";

const TITLE_MAX = 140;
const HEADLINE_MAX = 110;

/** Hard character cap with an ellipsis — Satori has no line clamping, so
 *  overflow has to be prevented in the data, not in CSS. Slices by code
 *  point (not UTF-16 code unit) so a cut at the cap cannot emit a lone
 *  surrogate into the SVG Satori rasterises. */
function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  const points = Array.from(trimmed);
  if (points.length <= max) return trimmed;
  return `${points.slice(0, max - 1).join("")}…`;
}

/** "3 / 12 kaynak", or a wording-only form whenever the fraction would be
 *  dishonest. The numerator (cluster members over the story's lifetime)
 *  and the denominator (feeds that delivered inside the yield window) are
 *  different populations, so `count > denominator` is possible and would
 *  read as >100% — the same escape hatches src/lib/yelpaze/markdown.ts
 *  uses. Never "3 / null", never "1 / 0", never a bare count that reads as
 *  if the denominator were the whole registry. */
function counterLabel(coverage: StoryCard["coverage"][MediaDnaZone]): string {
  const { count, denominator, denominatorUnknown } = coverage;
  if (denominatorUnknown || denominator === null) {
    return `${count} kaynak · payda bilinmiyor`;
  }
  if (denominator === 0) {
    return `${count} kaynak · payda: 0 sağlıklı kaynak`;
  }
  if (count > denominator) {
    return `${count} kaynak · payda güvenilir değil (${denominator})`;
  }
  return `${count} / ${denominator} kaynak`;
}

// A plain builder, not a React component: Satori renders the tree it is
// handed, and building it eagerly keeps the whole card observable (and
// therefore assertable) in the element `ImageResponse` receives.
function renderCard({
  card,
  id,
  title,
  dateLabel,
}: {
  card: StoryCard;
  id: string;
  title: string;
  dateLabel: string;
}) {
  const totalCoverage = ZONES.reduce(
    (sum, zone) => sum + card.coverage[zone].count,
    0,
  );

  return (
    <div
      style={{
        width: "1080px",
        height: "1920px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px",
        backgroundColor: GROUND,
        color: FOREGROUND,
        fontFamily: "Geist, sans-serif",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "48px" }}>
        <div
          style={{
            fontSize: 28,
            letterSpacing: "0.08em",
            color: MUTED,
          }}
        >
          TAYF · Aynı haber, farklı dünyalar
        </div>

        <div style={{ fontSize: 64, lineHeight: 1.15, color: FOREGROUND }}>
          {truncate(title, TITLE_MAX)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "56px" }}>
        {ZONES.map((zone) => {
          const headline = card.headlines[zone];
          const coverage = card.coverage[zone];
          const palette = ZONE_STYLE[zone];
          return (
            <div
              key={zone}
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              <div style={{ fontSize: 26, color: palette.text }}>
                {palette.label}
              </div>
              {headline ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  <div style={{ fontSize: 30, color: FOREGROUND }}>
                    {headline.outletName}
                  </div>
                  <div style={{ fontSize: 34, lineHeight: 1.25 }}>
                    {truncate(headline.title, HEADLINE_MAX)}
                  </div>
                </div>
              ) : coverage.count > 0 ? (
                // Members exist, but every one of their titles was
                // PII-filtered. Saying "no news on this side" here would
                // contradict the coverage counter three elements below,
                // which prints the unfiltered member count — and would
                // assert a silence that did not happen.
                <div style={{ fontSize: 34, color: DIM }}>
                  {`${coverage.count} kaynak yazdı · başlık paylaşıma uygun değil`}
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  <div style={{ fontSize: 34, color: DIM }}>
                    — bu tarafta haber yok
                  </div>
                  {coverage.degraded ? (
                    <div style={{ fontSize: 26, color: WARN }}>
                      bazı kaynaklara ulaşılamıyor
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
          {ZONES.map((zone) => (
            <div
              key={zone}
              style={{
                display: "flex",
                // All-zero coverage cannot happen for a rendered card (an
                // empty cluster 404s upstream), but a flex-grow of 0 on
                // every segment would collapse the bar to nothing, so fall
                // back to three equal segments.
                flexGrow:
                  totalCoverage === 0 ? 1 : card.coverage[zone].count,
                height: "18px",
                borderRadius: "9px",
                backgroundColor: ZONE_STYLE[zone].bar,
              }}
            />
          ))}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            justifyContent: "space-between",
          }}
        >
          {ZONES.map((zone) => (
            <div key={zone} style={{ fontSize: 26, color: MUTED }}>
              {counterLabel(card.coverage[zone])}
            </div>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            justifyContent: "space-between",
            fontSize: 26,
            color: MUTED,
          }}
        >
          <div>{dateLabel}</div>
          <div>{`tayfhaber.com/cluster/${id}`}</div>
        </div>
      </div>
    </div>
  );
}

// G-SEC-1: this is a public, unauthenticated handler that rasterises the
// largest image the app produces (1080×1920 ≈ 2.07 MP) through Satori +
// resvg on every cache miss, and `s-maxage=300` does not help because a
// shared-cache key includes the query string — `?x=1 … ?x=N` on one valid
// id is unlimited misses. Same convention as the 12 rate-limited handlers
// under src/app/api (see src/app/api/sources/route.ts, B-SEC-05).
// HONEST LIMIT: src/lib/rate-limit.ts documents itself as process-local,
// so this bounds a single-instance burst only; multi-instance serverless
// needs a shared store (Upstash/Redis). It is not a complete defence.
const kartLimit = createRateLimiter("cluster-kart", {
  capacity: 10,
  refillPerSecond: 1 / 6,
});

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { allowed, retryAfterMs } = kartLimit(clientKey(req));
  if (!allowed) {
    return new Response(null, {
      status: 429,
      headers: { "retry-after": String(Math.ceil(retryAfterMs / 1000)) },
    });
  }

  const { id } = await ctx.params;

  // Validate before any fetch: the id reaches Supabase and the rendered
  // footer text, so anything that is not a uuid is a 404, not a query.
  if (!UUID_RE.test(id)) return new Response(null, { status: 404 });

  const detail = await getClusterDetail(id);
  if (!detail) return new Response(null, { status: 404 });

  const health = await getZoneFeedHealth();
  const card = selectStoryCard(detail.members, health);
  // No members at all → nothing shareable; same answer as an unknown id
  // rather than an empty card with three silent zones.
  if (!card) return new Response(null, { status: 404 });

  // `ClusterDetail.cluster.title_tr` is ALREADY the neutral title:
  // cluster-detail-query coalesces `title_tr_neutral ?? title_tr` at the
  // query boundary and exposes no separate neutral field. But neutral is
  // not the same as PII-clean — `pickNeutralTitle` can return a member
  // headline verbatim — and this string renders at fontSize 64, the
  // card's dominant text. Offer no shareable card for a story whose own
  // title names a private individual, the same answer `selectStoryCard`
  // gives for an empty cluster.
  const title = detail.cluster.title_tr;
  if (!isGameEligibleTitle(title)) return new Response(null, { status: 404 });

  return new ImageResponse(
    renderCard({
      card,
      id,
      title,
      dateLabel: formatDdMmYyyy(detail.cluster.first_published),
    }),
    {
      width: 1080,
      height: 1920,
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        "Content-Disposition": 'inline; filename="tayf-kart.png"',
      },
    },
  );
}
