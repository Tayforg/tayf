// Entrance-animation classes for feed cards.
//
// Card 0 gets NO animation. It is the LCP card: `animate-fade-up` starts from
// opacity 0 and `stagger-1` adds a 50 ms delay, so the largest element on the
// page painted ~50 ms after React revealed it (h13-weight-1). Every later card
// keeps the stagger it had before, so the cascade below the fold is unchanged.
//
// The class strings are literal (one entry per stagger step) because Tailwind 4
// only emits classes it can read as whole tokens in source; a template literal
// like `stagger-${n}` works today only because globals.css defines .stagger-N by
// hand, and nothing would flag a rename.

const STAGGER = [
  "animate-fade-up stagger-1",
  "animate-fade-up stagger-2",
  "animate-fade-up stagger-3",
  "animate-fade-up stagger-4",
  "animate-fade-up stagger-5",
  "animate-fade-up stagger-6",
  "animate-fade-up stagger-7",
  "animate-fade-up stagger-8",
] as const;

/**
 * - `wrap8` (home feed): the stagger step cycles through 1..8, `(idx % 8) + 1`.
 * - `cap6` (/blindspots): the step climbs to 6 and stays there, `min(idx + 1, 6)`.
 *
 * Returns `""` for index 0 and for anything that is not a non-negative finite
 * number, so callers pass `cardEnterClass(i) || undefined` and render no
 * `class` attribute at all for the first card.
 */
export function cardEnterClass(
  idx: number,
  mode: "wrap8" | "cap6" = "wrap8",
): string {
  if (!Number.isFinite(idx)) return "";
  const i = Math.floor(idx);
  if (i <= 0) return "";
  const step = mode === "cap6" ? Math.min(i, 5) : i % 8;
  return STAGGER[step] ?? "";
}
