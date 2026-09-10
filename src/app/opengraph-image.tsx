import { ImageResponse } from "next/og";

// Root share card for tayfhaber.com — used for the homepage and as the
// generic fallback wherever a page segment doesn't ship its own
// `opengraph-image.tsx` (e.g. /cluster/[id] has its own, richer card; see
// that file's top comment for the Next 16 file-convention gating rules
// this follows too). No data fetching here, so unlike the cluster card
// there's no not-found fallback branch to worry about.
//
// Tailwind is NOT supported by Satori (the engine behind ImageResponse),
// so every visual rule below is an inline `style` prop — same constraint
// as src/app/cluster/[id]/opengraph-image.tsx. We skip custom font
// fetching for the same reason: Satori's bundled Geist-Regular renders
// Turkish diacritics (ç ğ ı ö ş ü) correctly out of the box.

export const alt = "Tayf — Aynı haber, farklı dünyalar.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Zone bar colours — literal hexes matching the İktidar / Bağımsız /
// Muhalefet tones used across the app (see ZONE_META in
// src/lib/bias/config.ts, whose Tailwind class strings aren't usable here
// since Satori doesn't run Tailwind's JIT).
const ZONE_COLORS = {
  iktidar: "#fb2c36",
  bagimsiz: "#71717b",
  muhalefet: "#00bc7d",
} as const;

export default async function Image() {
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
          padding: "64px 72px",
          background:
            "linear-gradient(135deg, #0a0a0a 0%, #18181b 60%, #0f172a 100%)",
          color: "#fafafa",
          fontFamily: "sans-serif",
        }}
      >
        {/* Wordmark */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            fontSize: 120,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            color: "#fafafa",
          }}
        >
          {/* Brand mark — a simple gradient square stands in for a logo,
              cheap to render and avoids shipping a binary asset. */}
          <div
            style={{
              display: "flex",
              width: 108,
              height: 108,
              borderRadius: 24,
              background: `linear-gradient(135deg, ${ZONE_COLORS.iktidar} 0%, ${ZONE_COLORS.bagimsiz} 50%, ${ZONE_COLORS.muhalefet} 100%)`,
            }}
          />
          Tayf
        </div>

        {/* Tagline */}
        <div
          style={{
            display: "flex",
            fontSize: 40,
            fontWeight: 500,
            color: "#e4e4e7",
            marginTop: 24,
          }}
        >
          Aynı haber, farklı dünyalar.
        </div>

        {/* Three-zone bias-spectrum bar */}
        <div
          style={{
            display: "flex",
            width: 640,
            height: 22,
            borderRadius: 999,
            overflow: "hidden",
            marginTop: 56,
          }}
        >
          <div
            style={{
              display: "flex",
              width: "34%",
              height: "100%",
              background: ZONE_COLORS.iktidar,
            }}
          />
          <div
            style={{
              display: "flex",
              width: "32%",
              height: "100%",
              background: ZONE_COLORS.bagimsiz,
            }}
          />
          <div
            style={{
              display: "flex",
              width: "34%",
              height: "100%",
              background: ZONE_COLORS.muhalefet,
            }}
          />
        </div>
      </div>
    ),
    { ...size },
  );
}
