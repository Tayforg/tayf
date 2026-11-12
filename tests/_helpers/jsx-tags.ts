// ---------------------------------------------------------------------------
// Shared JSX opening-tag scanner for the source-text CI guards (perf-6
// feed-links-plain-anchor, h166-perf-1 row-link-prefetch, h166-perf-2
// source-profile-prefetch). It reads `.tsx` source as text, finds every
// `<Link ...>` / `<a ...>` opening tag and its literal href, so a guard can
// assert on attributes without rendering anything.
//
// Every pattern uses negated character classes only, so each scan is linear
// (CodeQL js/redos). A guard never strips markup with a regex.
// ---------------------------------------------------------------------------

export interface Tag {
  /** The opening tag, from `<Link` / `<a` through its closing `>`. */
  tag: string;
  /** 1-based line of the tag in its file. */
  line: number;
}

/**
 * Slices the opening tag that starts at `start` (the `<`). A plain `>` search
 * would stop at the `=>` of an arrow function inside an attribute, so this
 * scanner tracks `{}` depth and skips quoted strings while at depth 0 (an
 * attribute value like `title="a > b"`). Inside braces everything is
 * expression code, so quotes are not tracked there and `=>` or a comparison
 * cannot end the tag. The tag ends at the first `>` at depth 0.
 */
export function sliceOpeningTag(src: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (depth === 0 && (ch === '"' || ch === "'")) {
      const close = src.indexOf(ch, i + 1);
      if (close === -1) return null;
      i = close;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
    } else if (ch === ">" && depth === 0) {
      return src.slice(start, i + 1);
    }
  }
  return null;
}

export function tagsNamed(src: string, pattern: RegExp): Tag[] {
  const out: Tag[] = [];
  for (const match of src.matchAll(pattern)) {
    const start = match.index ?? 0;
    const tag = sliceOpeningTag(src, start);
    if (tag === null) continue;
    out.push({ tag, line: src.slice(0, start).split("\n").length });
  }
  return out;
}

export const linkTags = (src: string): Tag[] => tagsNamed(src, /<Link(?=[\s>])/g);
export const anchorTags = (src: string): Tag[] => tagsNamed(src, /<a(?=[\s>])/g);

/** The literal href of a tag: "...", '...', {"..."}, {'...'} or {`...`}. */
export function hrefOf(tag: string): string | null {
  const m = /\bhref=(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)\s*\})/.exec(
    tag,
  );
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? null;
}
