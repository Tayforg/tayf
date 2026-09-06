import { ImageResponse } from "next/og";

import { getClusterDetail } from "@/lib/clusters/cluster-detail-query";
import { tallyZones, zoneOf } from "@/lib/bias/config";
import { zoneCountsOf, zonePercents } from "@/lib/bias/zone-summary";
import type { MediaDnaZone } from "@/types";

// File-route OG card for /cluster/[id].
//
// Next.js 16 auto-registers this as the page segment's
// `openGraph.images[0]` (and, via the sibling `twitter-image.tsx`
// re-export, `twitter.images[0]`) — but ONLY when the segment's own
// metadata does NOT set an `images` key on `openGraph`/`twitter`.
// `mergeStaticMetadata` in `next/dist/lib/metadata/resolve-metadata.js`
// gates the file convention on `!source.openGraph?.hasOwnProperty(
// 'images')` (same check for twitter). The cluster page's
// `generateMetadata` used to set `openGraph.images`/`twitter.images`
// (even as `[]`), which — despite this file's old top-comment claiming
// the framework "merges" the two — silently disabled this card and left
// social crawlers showing the raw article photo instead. `page.tsx` no
// longer sets those keys, so this generated card actually ships now.
//
// Tailwind is NOT supported by Satori (the engine behind ImageResponse),
// so every visual rule below is an inline `style` prop. Only flexbox
// and a subset of CSS properties render — no `display: grid`, no
// pseudo-elements, no fancy gradients beyond linear. We also skip
// custom font fetching to keep build dependencies minimal: Satori
// falls back to its bundled Geist-Regular, which renders Turkish
// diacritics (ç ğ ı ö ş ü) correctly — but only ships weight 400, so the
// `fontWeight` values below render lighter than the numbers suggest.

export const alt = "Tayf — haber kümesi kartı";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

interface ImageProps {
  // Next.js 16: dynamic-route `params` is a Promise. Same shape as the
  // page component itself — keeps the contract obvious.
  params: Promise<{ id: string }>;
}

// Zone presentation tokens — the Tailwind class strings in
// `src/lib/bias/zones.ts` aren't usable here (no Tailwind in Satori),
// so we mirror the same red / zinc / emerald palette as raw hex codes.
const ZONE_STYLE: Record<
  MediaDnaZone,
  { label: string; bar: string; text: string }
> = {
  iktidar: { label: "İktidar", bar: "#ef4444", text: "#fecaca" },
  bagimsiz: { label: "Bağımsız", bar: "#a1a1aa", text: "#e4e4e7" },
  muhalefet: { label: "Muhalefet", bar: "#10b981", text: "#a7f3d0" },
};

export default async function Image({ params }: ImageProps) {
  const { id } = await params;
  const detail = await getClusterDetail(id);

  // Fallback card if the cluster vanished between SSR and the OG fetch.
  // We still return a 200 with a usable card so social crawlers don't
  // cache a 404 — Slack/Twitter are notoriously sticky about that.
  if (!detail) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "#0a0a0a",
            color: "#fafafa",
            fontSize: 64,
            fontWeight: 700,
            letterSpacing: "-0.02em",
          }}
        >
          <div style={{ display: "flex" }}>Tayf</div>
          <div
            style={{
              display: "flex",
              fontSize: 28,
              fontWeight: 500,
              color: "#a1a1aa",
              marginTop: 16,
            }}
          >
            Haber kümesi bulunamadı
          </div>
        </div>
      ),
      { ...size },
    );
  }

  const { cluster, wire } = detail;
  const zones = zoneCountsOf(cluster.bias_distribution);
  const percents = zonePercents(zones);
  const zoneTotal = zones.iktidar + zones.bagimsiz + zones.muhalefet;
  // Guard against div-by-zero on a freshly clustered row whose
  // bias_distribution hasn't been backfilled yet.
  const safeTotal = zoneTotal > 0 ? zoneTotal : 1;

  // Blindspot ribbon zone + share: prefer the reported `blindspot_side`; a
  // freshly-flagged row without one yet falls back to whichever zone
  // covered the story the most (same rule `buildShareText` uses). The DB
  // flag now fires at >= BLINDSPOT.dominantShare (80%), so the ribbon says
  // "sadece {Zone} yazdı" only at an exact 100% share and "%{share} {Zone}"
  // otherwise.
  const tally = tallyZones(cluster.bias_distribution);
  const ribbonZone: MediaDnaZone | null = cluster.is_blindspot
    ? cluster.blindspot_side
      ? zoneOf(cluster.blindspot_side)
      : (tally.dominantZone ?? "iktidar")
    : null;
  const ribbonShare = Math.round(tally.dominantShare * 100);

  // Trim very long Turkish headlines so they fit in the title box.
  // Roughly 110 characters before Satori starts pushing things
  // off-canvas at fontSize 64 — tighter once the blindspot ribbon shrinks
  // the title to fontSize 56, since the ribbon and top row also compete
  // for vertical space in the column.
  const titleFontSize = ribbonZone ? 56 : 64;
  const titleMaxChars = ribbonZone ? 95 : 110;
  const title =
    cluster.title_tr.length > titleMaxChars
      ? cluster.title_tr.slice(0, titleMaxChars - 3) + "…"
      : cluster.title_tr;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          padding: "64px 72px",
          background:
            "linear-gradient(135deg, #0a0a0a 0%, #18181b 60%, #0f172a 100%)",
          color: "#fafafa",
          fontFamily: "sans-serif",
        }}
      >
        {/* Top row: Tayf wordmark + source count pill */}
        <div
          style={{
            display: "flex",
            flexShrink: 0,
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontSize: 36,
              fontWeight: 800,
              letterSpacing: "-0.03em",
              color: "#fafafa",
            }}
          >
            {/* Brand mark — a simple gradient square stands in for a
                logo. Cheap to render and avoids shipping a binary asset
                through the 500KB bundle limit. */}
            <div
              style={{
                display: "flex",
                width: 44,
                height: 44,
                borderRadius: 10,
                background:
                  "linear-gradient(135deg, #ef4444 0%, #a1a1aa 50%, #10b981 100%)",
              }}
            />
            Tayf
          </div>
          <div
            style={{
              display: "flex",
              flexShrink: 0,
              alignItems: "center",
              gap: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                flexShrink: 0,
                alignItems: "center",
                padding: "10px 22px",
                borderRadius: 999,
                background: "rgba(250,250,250,0.08)",
                border: "1px solid rgba(250,250,250,0.18)",
                fontSize: 24,
                fontWeight: 600,
                color: "#e4e4e7",
              }}
            >
              {wire.effectiveArticleCount} kaynak
            </div>
            {/* wire-redistribution: violet, not amber — amber is reserved
                for the Kör nokta ribbon below so the two claims never
                render as one repeated style. */}
            {wire.isWireRedistribution && (
              <div
                style={{
                  display: "flex",
                  flexShrink: 0,
                  alignItems: "center",
                  padding: "10px 22px",
                  borderRadius: 999,
                  background: "rgba(139,92,246,0.16)",
                  border: "1px solid rgba(139,92,246,0.45)",
                  fontSize: 20,
                  fontWeight: 600,
                  color: "#c4b5fd",
                }}
              >
                {wire.memberCount} kopya · tek kaynak
              </div>
            )}
          </div>
        </div>

        {/* Blindspot ribbon — only when this cluster is a "kör nokta"
            (one Medya DNA zone holds ≥ BLINDSPOT.dominantShare of the
            sources). Sits between the top row and the title so it reads
            as the headline claim. */}
        {ribbonZone && (
          <div
            style={{
              display: "flex",
              flexShrink: 0,
              alignItems: "center",
              alignSelf: "flex-start",
              marginTop: 28,
              padding: "10px 22px",
              borderRadius: 999,
              background: "rgba(245,158,11,0.16)",
              border: "1px solid rgba(245,158,11,0.45)",
              color: "#fcd34d",
              fontSize: 26,
              fontWeight: 800,
              letterSpacing: "0.04em",
            }}
          >
            {ribbonShare === 100
              ? `KÖR NOKTA — sadece ${ZONE_STYLE[ribbonZone].label} yazdı`
              : `KÖR NOKTA — %${ribbonShare} ${ZONE_STYLE[ribbonZone].label}`}
          </div>
        )}

        {/* Title — flex-grow pushes the bias breakdown to the bottom. */}
        <div
          style={{
            display: "flex",
            flexGrow: 1,
            alignItems: "center",
            marginTop: 32,
            marginBottom: 32,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: titleFontSize,
              fontWeight: 800,
              lineHeight: 1.1,
              letterSpacing: "-0.025em",
              color: "#fafafa",
              overflow: "hidden",
              lineClamp: 3,
            }}
          >
            {title}
          </div>
        </div>

        {/* Bias breakdown — stacked horizontal bar + 3 zone chips. The
            stacked bar mirrors the BiasSpectrum component on the page,
            and the chips below give a percentage readout per zone. */}
        <div
          style={{
            display: "flex",
            flexShrink: 0,
            flexDirection: "column",
            width: "100%",
          }}
        >
          <div
            style={{
              display: "flex",
              width: "100%",
              height: 18,
              borderRadius: 999,
              overflow: "hidden",
              background: "rgba(250,250,250,0.08)",
            }}
          >
            {(["iktidar", "bagimsiz", "muhalefet"] as MediaDnaZone[]).map(
              (zone) => {
                const pct = (zones[zone] / safeTotal) * 100;
                if (pct <= 0) return null;
                return (
                  <div
                    key={zone}
                    style={{
                      display: "flex",
                      width: `${pct}%`,
                      height: "100%",
                      background: ZONE_STYLE[zone].bar,
                    }}
                  />
                );
              },
            )}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 20,
              gap: 16,
            }}
          >
            {(["iktidar", "bagimsiz", "muhalefet"] as MediaDnaZone[]).map(
              (zone) => {
                const pct = percents[zone];
                return (
                  <div
                    key={zone}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      flex: 1,
                      padding: "16px 20px",
                      borderRadius: 12,
                      background: "rgba(250,250,250,0.05)",
                      border: "1px solid rgba(250,250,250,0.12)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          width: 12,
                          height: 12,
                          borderRadius: 999,
                          background: ZONE_STYLE[zone].bar,
                        }}
                      />
                      <div
                        style={{
                          display: "flex",
                          fontSize: 22,
                          fontWeight: 600,
                          color: ZONE_STYLE[zone].text,
                        }}
                      >
                        {ZONE_STYLE[zone].label}
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        fontSize: 32,
                        fontWeight: 800,
                        color: "#fafafa",
                        marginTop: 8,
                      }}
                    >
                      {pct}% · {zones[zone]}
                    </div>
                  </div>
                );
              },
            )}
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
