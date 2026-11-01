// Accessible-name builders for the bookmark controls. Pure and client-safe: no
// React, no storage. Kept apart from the components so the copy and the
// truncation rule are unit-testable and shared by the card overlay, the
// cluster-page chip and the /saved remove button.
//
// Why a story-specific name: a feed is a column of identical icon-only
// buttons, and a screen-reader user listing the page's buttons hears
// "Hikâyeyi kaydet" twenty times. The name carries the story title instead.

/** Longest story title, in code points, that goes into an accessible name. */
export const BOOKMARK_LABEL_TITLE_MAX = 80;

const GENERIC_SAVE = "Hikâyeyi kaydet";
const GENERIC_REMOVE = "Kaydedilenlerden çıkar";

/**
 * A story title prepared for use inside an accessible name: trimmed, with
 * every whitespace run collapsed to one space. Titles longer than
 * BOOKMARK_LABEL_TITLE_MAX code points are cut to the first 79, trailing space
 * dropped, plus an ellipsis, so the result is never longer than the maximum.
 * The cut counts code points (Array.from), so an emoji or other astral
 * character is never split into a lone surrogate. Returns null when there is
 * nothing to name the story with.
 */
export function labelTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const clean = title.trim().replace(/\s+/g, " ");
  if (clean === "") return null;
  const points = Array.from(clean);
  if (points.length <= BOOKMARK_LABEL_TITLE_MAX) return clean;
  return points.slice(0, BOOKMARK_LABEL_TITLE_MAX - 1).join("").trimEnd() + "…";
}

/**
 * Name of the icon-only overlay bookmark button on a card. The same text in
 * both states: whether the story is saved goes through aria-pressed (a
 * toggle's label must not change with its state).
 */
export function bookmarkStoryLabel(title: string | null | undefined): string {
  const t = labelTitle(title);
  return t === null ? GENERIC_SAVE : `«${t}» hikâyesini kaydet`;
}

/**
 * Screen-reader-only suffix appended to the visible text of the cluster-page
 * chip ("Kaydet" or "Kaydedildi"), giving "Kaydet: «başlık»". The name then
 * starts with the visible label, as WCAG 2.5.3 requires. Null without a title.
 */
export function bookmarkChipSuffix(title: string | null | undefined): string | null {
  const t = labelTitle(title);
  return t === null ? null : `: «${t}»`;
}

/** Name of the icon-only remove (X) button on a /saved row. */
export function savedRemoveLabel(title: string | null | undefined): string {
  const t = labelTitle(title);
  return t === null ? GENERIC_REMOVE : `«${t}» hikâyesini kaydedilenlerden çıkar`;
}
