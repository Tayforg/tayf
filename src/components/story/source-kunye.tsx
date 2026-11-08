import { SourceChips } from "@/components/source/source-chips";
import { SourceBadge } from "@/components/story/source-badge";
import { SourceProfileLink } from "@/components/story/source-profile-link";
import type { Source } from "@/types";

/**
 * "Kaynak künyesi" — the cluster page's factuality + ownership lineage strip,
 * one row per participating (SOURCE_METADATA-tagged) outlet. Server Component,
 * no client JS: the overflow sits behind a native <details>.
 *
 * h49-browser-1: the list used to render every rated outlet, so a 21-source
 * story pushed "Aynı Haber, Farklı Dünyalar" about four phone screens down.
 * Now the first `KUNYE_VISIBLE` rows are always shown and, once the list is
 * long enough that the disclosure hides at least two rows
 * (`KUNYE_COLLAPSE_MIN`), the rest sit behind "Tüm künye (N kaynak)" (same
 * pattern as StoryTimeline's "Tüm sıra"). A disclosure that would hide a single
 * row is no saving, so 7 sources still render in full. The cap applies at every
 * width.
 *
 * Every row keeps its markup (profile link + chips + kayyum badge). Only the
 * visible rows get the fade-up stagger; hidden rows stay un-animated since they
 * appear on demand. All class strings are literals for Tailwind 4's scanner.
 */

/** Rows shown before the disclosure. */
export const KUNYE_VISIBLE = 6;

/** Fewer sources than this render in full (the disclosure would hide < 2 rows). */
export const KUNYE_COLLAPSE_MIN = 8;

export type SourceKunyeSource = Pick<Source, "id" | "slug" | "name" | "trustee_since">;

// `stagger-1`..`stagger-8` are defined in globals.css; `stagger-0` is not
// (row 0 has no delay), which is how the page always rendered it. An
// un-collapsed list has at most KUNYE_COLLAPSE_MIN - 1 = 7 rows, so indexes
// 0..6 cover every animated row. Spelled out so the names are literals.
const STAGGER: readonly string[] = [
  "stagger-0",
  "stagger-1",
  "stagger-2",
  "stagger-3",
  "stagger-4",
  "stagger-5",
  "stagger-6",
];

const LIST_CLASS = "flex flex-wrap gap-x-3 gap-y-1.5 min-w-0";
const ROW_CLASS = "flex flex-wrap items-center gap-1.5 min-w-0 max-w-full";
const ROW_ANIMATED_CLASS = "flex flex-wrap items-center gap-1.5 min-w-0 max-w-full animate-fade-up";

function rowClass(i: number, animated: boolean): string {
  if (!animated) return ROW_CLASS;
  const stagger = STAGGER[i];
  return stagger === undefined ? ROW_ANIMATED_CLASS : `${ROW_ANIMATED_CLASS} ${stagger}`;
}

// A plain function (not a component) so the <li> sits directly in the tree.
function kunyeRow(source: SourceKunyeSource, className: string) {
  return (
    <li key={source.id} className={className}>
      <SourceProfileLink slug={source.slug} name={source.name} />
      <SourceChips slug={source.slug} />
      <SourceBadge trusteeSince={source.trustee_since} />
    </li>
  );
}

export function SourceKunye({ sources }: { sources: readonly SourceKunyeSource[] }) {
  if (sources.length === 0) return null;

  const collapse = sources.length >= KUNYE_COLLAPSE_MIN;
  const visible = collapse ? sources.slice(0, KUNYE_VISIBLE) : sources;
  const rest = collapse ? sources.slice(KUNYE_VISIBLE) : [];

  return (
    <div className="space-y-1.5">
      {/* h67-landmarks-1: a heading, not a <div>, so heading navigation finds
          the strip. Same classes: h1-h3 get the serif heading font from
          globals.css (font-serif is already here) and tracking-wide overrides
          the heading letter-spacing, so the label looks as it did. */}
      <h2 className="font-serif text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Kaynak künyesi
      </h2>
      <ul className={LIST_CLASS}>
        {visible.map((source, i) => kunyeRow(source, rowClass(i, true)))}
      </ul>
      {rest.length > 0 && (
        <details>
          <summary className="inline-flex min-h-[44px] cursor-pointer touch-manipulation list-none items-center text-[12px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">
            {`Tüm künye (${sources.length} kaynak)`}
          </summary>
          <ul className={LIST_CLASS}>
            {rest.map((source) => kunyeRow(source, rowClass(0, false)))}
          </ul>
        </details>
      )}
    </div>
  );
}
