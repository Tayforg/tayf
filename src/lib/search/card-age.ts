// The basis of the age a story card prints (h192-yeni-1). Pure: no I/O, and no clock of its own when a `nowMs` is given.
//
// The newest-first archive list (?sirala=yeni, migration 215) is ordered by clusters.updated_at, but a card printed the age of
// first_published, so the visible times jumped up and down under an "en yeni" heading ("2, 15, 5, 14 saat önce"). The label,
// not the order, was wrong: in that list alone the pill now names the basis of the order, "Güncellendi 2 saat önce", and keeps
// the first story's age as its title. Every other list (the ranked archive, the feed's sections, the hubs, /blindspots, the
// cluster page's rows) stays on 'first', the age of first_published.

import { SEARCH_SORT_NEW, type SearchSort } from "@/lib/search/search-sort";
import { formatTurkishTimeAgo } from "@/lib/time";

/** Which timestamp the age pill counts from: the first story's (today's rule) or the last update's. */
export type CardAgeBasis = "first" | "updated";

/** What the pill prints before the age on the 'updated' basis. The trailing space is part of the text. */
export const UPDATED_AGE_PREFIX = "Güncellendi ";

/** What the pill's title prints before the first story's age on the 'updated' basis. */
const FIRST_STORY_TITLE_PREFIX = "İlk haber: ";

/** 'updated' for the newest-first order, 'first' for everything else (the ranked order is null). */
export function cardAgeBasis(sort: SearchSort | null): CardAgeBasis {
  return sort === SEARCH_SORT_NEW ? "updated" : "first";
}

export interface CardAgeParts {
  /** The timestamp the age is counted from. */
  iso: string;
  /** Text printed in front of the age ("" on the 'first' basis). */
  prefix: string;
  /** The pill's title attribute; absent on the 'first' basis and whenever there is nothing to say. */
  title?: string;
}

/**
 * The pieces of a card's age pill.
 *
 * - 'first': `{ iso: firstPublished, prefix: "" }`, exactly what the pill always printed.
 * - 'updated': `{ iso: updatedAt, prefix: "Güncellendi ", title: "İlk haber: <age of firstPublished>" }`. An invalid
 *   `updatedAt`, or one earlier than `firstPublished` (an update cannot precede the story), is not the basis of any order
 *   worth naming, so the result is the 'first' one. A `firstPublished` that cannot be read leaves the title out.
 *
 * `nowMs` is the "now" the title's age is measured against: a fully static page passes its read's own clock so nothing here
 * reads `Date.now()`; omitted, the title uses the server's clock like the pill's own age does.
 */
export function cardAgeParts(input: {
  basis: CardAgeBasis;
  firstPublished: string;
  updatedAt: string;
  nowMs?: number;
}): CardAgeParts {
  const { basis, firstPublished, updatedAt, nowMs } = input;
  const first: CardAgeParts = { iso: firstPublished, prefix: "" };
  if (basis !== "updated") return first;

  const updated = new Date(updatedAt).getTime();
  if (Number.isNaN(updated)) return first;
  const published = new Date(firstPublished).getTime();
  if (!Number.isNaN(published) && updated < published) return first;

  const firstAge = formatTurkishTimeAgo(firstPublished, nowMs === undefined ? undefined : { now: nowMs });
  return {
    iso: updatedAt,
    prefix: UPDATED_AGE_PREFIX,
    ...(firstAge === "" ? {} : { title: FIRST_STORY_TITLE_PREFIX + firstAge }),
  };
}
