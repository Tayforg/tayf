import { ImageResponse } from "next/og";

// browser-qa-13: iOS home-screen icon. Previously `src/app/apple-icon.svg`
// (a bare SVG) — Apple's UIWebView/Safari "Add to Home Screen" path cannot
// route an SVG apple-touch-icon at all, so it silently fell back to a
// screenshot thumbnail. This file-convention route (Next.js 16 auto-wires
// it into `<link rel="apple-touch-icon">`, replacing the hard-coded
// `metadata.icons.apple` in layout.tsx) renders the same Tayf spectrum-bar
// mark as `icon.svg`, geometry scaled ×5.625 (32px viewBox → 180px canvas),
// as a real PNG via Satori/`ImageResponse`.
//
// Tailwind is NOT supported by Satori — every rule below is an inline
// `style` prop, same constraint as opengraph-image.tsx.

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          background: "#0a0a0a",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 28,
            top: 84,
            width: 34,
            height: 68,
            borderRadius: 17,
            background: "#ef4444",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 73,
            top: 39,
            width: 34,
            height: 113,
            borderRadius: 17,
            background: "#d4a030",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 118,
            top: 62,
            width: 34,
            height: 90,
            borderRadius: 17,
            background: "#10b981",
          }}
        />
      </div>
    ),
    { ...size },
  );
}
