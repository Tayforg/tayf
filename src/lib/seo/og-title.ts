// Headline text and font size for the cluster OG / Twitter card
// (src/app/cluster/[id]/opengraph-image.tsx).
//
// Hunt 20, h20-contracts-1. The card used `slice(0, max - 3) + "…"` with a cap
// of 110 characters (95 under the blindspot ribbon) at one fixed size per
// variant. Two things went wrong:
//   - 104+ characters at 64 px wrap to 4 lines and push the İktidar / Bağımsız
//     / Muhalefet legend off the 1200x630 canvas (the legend boxes lost their
//     bottom padding);
//   - the cut ignored word boundaries: "...Akademik Ödül Töreni'ne kat…".
//
// clampOgTitle() fixes both. It never cuts inside a word, and it steps the font
// size down as the text grows, so a longer headline fits the same three lines.
// Pure: no I/O, no Date, no regex over the title. Every count is in code points
// (an emoji is one), and the scan reads at most OG_TITLE_MAX_CHARS.plain + 1 of
// them, so a megabyte of input costs the same as a sentence.

/** Longest headline, in code points, including the closing "…". */
export const OG_TITLE_MAX_CHARS = { plain: 130, ribbon: 95 } as const;

/** Line height of the title box, as a multiple of its font size. */
export const OG_TITLE_LINE_HEIGHT = 1.1;

/** The title box shows at most this many lines (it clips beyond that). */
export const OG_TITLE_MAX_LINES = 3;

/** Font sizes in px, by the length of the text that is finally drawn. */
const FONT_SIZE_SHORT = 64; // <= 80 code points
const FONT_SIZE_SHORT_RIBBON = 56; // <= 80 code points under the ribbon (the size measured to fit)
const FONT_SIZE_MEDIUM = 52; // 81-100 code points
const FONT_SIZE_LONG = 44; // 101 and more
const SHORT_UPPER = 80;
const MEDIUM_UPPER = 100;

/**
 * A blank at a position under this share of the cap is not worth cutting at: it
 * would throw away most of the headline for one early word break, so a hard cut
 * is used instead.
 */
const WORD_CUT_MIN_SHARE_PERCENT = 60;

const ELLIPSIS = "…";

// Marks that read badly right before "…": a clause mark or a dash left dangling
// at the cut. Sentence marks (. ! ?) stay, they end the thought honestly.
const DANGLING_MARKS = ",;:-–—";

/** Unicode White_Space plus the BOM: the characters a headline can break at. */
function isBlank(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** Drop trailing blanks and dangling clause marks; null when nothing would be left. */
function stripTail(head: string): string | null {
  let end = head.length;
  while (end > 0) {
    const ch = head.charAt(end - 1);
    if (!isBlank(ch) && !DANGLING_MARKS.includes(ch)) break;
    end--;
  }
  return end > 0 ? head.slice(0, end) : null;
}

function fontSizeFor(codePoints: number, ribbon: boolean): number {
  if (codePoints <= SHORT_UPPER) return ribbon ? FONT_SIZE_SHORT_RIBBON : FONT_SIZE_SHORT;
  if (codePoints <= MEDIUM_UPPER) return FONT_SIZE_MEDIUM;
  return FONT_SIZE_LONG;
}

/**
 * The text and font size for the card's headline.
 *
 * A title within the cap is returned unchanged. A longer one is cut: the first
 * `max - 1` code points are kept and trimmed back to the last blank among them
 * (or to the end of that run when the next character is a blank), trailing
 * blanks and `, ; : - – —` are dropped, and "…" is appended, so the result is
 * never longer than `max`. When the only blank is earlier than 60% of the cap
 * (one very long word) the cut is a hard cut at `max - 1` code points instead.
 *
 * The size comes from the length of the text that is finally drawn: up to 80
 * code points 64 px (56 px under the ribbon), up to 100 52 px, beyond that 44 px.
 * A non-string title is treated as empty.
 */
export function clampOgTitle(
  title: string,
  opts: { ribbon: boolean },
): { text: string; fontSize: number } {
  const ribbon = opts.ribbon;
  const max = ribbon ? OG_TITLE_MAX_CHARS.ribbon : OG_TITLE_MAX_CHARS.plain;
  const source = typeof title === "string" ? title : "";

  // One pass over at most max + 1 code points. `keep` is the UTF-16 length of the
  // first max - 1 code points; `blankAt` is the UTF-16 offset and `blankIndex` the
  // code point index of the last blank among them; `nextIsBlank` says whether the
  // code point right after them (index max - 1) is a blank.
  let count = 0;
  let units = 0;
  let keep = 0;
  let blankAt = -1;
  let blankIndex = -1;
  let nextIsBlank = false;
  let tooLong = false;
  for (const ch of source) {
    if (count === max) {
      tooLong = true;
      break;
    }
    if (count === max - 1) {
      keep = units;
      nextIsBlank = isBlank(ch);
    } else if (isBlank(ch)) {
      blankAt = units;
      blankIndex = count;
    }
    units += ch.length;
    count++;
  }

  if (!tooLong) return { text: source, fontSize: fontSizeFor(count, ribbon) };

  let cut = keep;
  if (!nextIsBlank && blankAt >= 0 && blankIndex * 100 >= max * WORD_CUT_MIN_SHARE_PERCENT) {
    cut = blankAt;
  }
  const head = source.slice(0, cut);
  const body = stripTail(head) ?? head;
  const text = body + ELLIPSIS;
  return { text, fontSize: fontSizeFor(Array.from(body).length + 1, ribbon) };
}
