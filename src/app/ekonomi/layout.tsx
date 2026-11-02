import { JetBrains_Mono } from "next/font/google";

// Route-scoped monospace for /ekonomi and /ekonomi/[ticker] (h21-perf-1). This
// is the one named exception to the "next/font/google is imported only by the
// root layout" rule in tests/guards/font-preload.test.ts.
//
// Why: /ekonomi is mostly mono text and the root layout loads JetBrains Mono
// with `preload: false` (#143, 6 -> 4 font preloads on the home page). On a
// cold mobile load the font finished near 3.1 s and swapped in over text laid
// out in next/font's automatic fallback: Arial with size-adjust 134.59%, a
// PROPORTIONAL face scaled to the mono average width. Its glyph widths differ
// from the real font, so the flex-wrap strips, the grid and the ticker tape
// reflowed at once: one shift, CLS 0.229 ("needs improvement").
//
// Fix, measured with `next build` + `next start` (390x844 DPR3, Slow 4G, 4x
// CPU, 3 cold runs, median):
//   - preload: true            CLS 0, but FCP +360 ms: two more files on a
//                              1.4 Mbps link compete with the CSS and JS. Not shipped.
//   - this config              CLS 0, FCP +72 ms. The instance drops the Arial
//                              fallback and lists fixed-width faces instead, so the
//                              swap is between two ~0.6 em faces and nothing
//                              reflows. No extra preload: `/` and /ekonomi keep four.
//
// Why a wrapper div works: globals.css declares
// `@theme inline { --font-mono: var(--font-mono, ...) }`, which resolves per
// element, so `font-mono` anywhere under this div reads the variable set by
// `ekonomiMono.variable` here instead of the root's. loading.tsx renders
// inside this layout, so the skeleton is wrapped too. The woff2 files are
// content-hashed, so this instance and the root one fetch the same files;
// never hardcode hashed font file URLs.
const ekonomiMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin", "latin-ext"],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  fallback: ["ui-monospace", "Menlo", "Courier New", "monospace"],
});

export default function EkonomiLayout({ children }: { children: React.ReactNode }) {
  return <div className={ekonomiMono.variable}>{children}</div>;
}
