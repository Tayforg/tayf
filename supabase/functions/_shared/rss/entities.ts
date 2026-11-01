// supabase/functions/_shared/rss/entities.ts
//
// Numeric character references (&#1114112;, &#x110000;, &#0;, &#11;, &#xD800;)
// in a feed are untrusted input. `String.fromCodePoint` throws a RangeError for
// anything above U+10FFFF (and for NaN / negative / fractional values), and one
// throw inside the entity decoder used to unwind through `normalizeArticles`
// and drop EVERY item of that source for the run. A reference that does not
// throw can still produce a character XML 1.0 forbids (a C0 control, a lone
// surrogate, U+FFFE / U+FFFF), and ONE such character in ONE title makes the
// generated RSS feed unparseable for every subscriber.
//
// This module is the single place that turns a code point into a string. It is
// pure, has no imports, and so loads unchanged under Deno, vitest and Next.
// The `tests/guards/safe-code-point.test.ts` sweep keeps `String.fromCodePoint`
// out of every other runtime file.

/**
 * True when `cp` is a code point XML 1.0 allows in a document (the `Char`
 * production): TAB, LF, CR, U+0020-U+D7FF, U+E000-U+FFFD and U+10000-U+10FFFF.
 * False for every other value, including non-integers, NaN and Infinity.
 */
export function isXmlCodePoint(cp: number): boolean {
  if (!Number.isInteger(cp)) return false;
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/**
 * The string for code point `cp`, or '' when `cp` is not a legal XML 1.0
 * character. Never throws.
 *
 * DECISION: an illegal reference is DROPPED rather than replaced with U+FFFD.
 * A '�' inside a Turkish headline reads as broken text to a reader, while a
 * silently missing character from a malformed entity is invisible. This is the
 * only `String.fromCodePoint` in runtime code.
 */
export function codePointToString(cp: number): string {
  return isXmlCodePoint(cp) ? String.fromCodePoint(cp) : "";
}

// Verbatim from src/lib/feeds/rss-builder.ts: C0 controls other than TAB / LF /
// CR, the BMP non-characters U+FFFE and U+FFFF, and unpaired UTF-16 surrogates
// (a valid pair, i.e. an astral character such as an emoji, is left alone).
//
// It carries the `g` flag, so it keeps `lastIndex` between `.test()` calls.
// Use it with `String.prototype.replace` (stateless), or copy it with
// `new RegExp(INVALID_XML_CHARS_RE.source)` before calling `.test()`.
export const INVALID_XML_CHARS_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Removes every character XML 1.0 forbids, leaving legal text untouched. */
export function stripInvalidXmlChars(s: string): string {
  return s.replace(INVALID_XML_CHARS_RE, "");
}

// ---------------------------------------------------------------------------
// Entity residue
//
// Some feeds double-encode their text ("&amp;quot;" for a quote), and the ingest
// decoder in normalize.ts is single-pass BY DESIGN (a decode must never turn
// "&amp;lt;" into "<"), so the leftover "&quot;" was stored and readers saw it
// as literal text. Two helpers close that gap without weakening the guarantee:
//
//   decodeResidualEntities  ONE pass over the named and numeric references
//                           that can only ever produce plain text. Ingest runs
//                           it after stripTags.
//   repairEntityResidue     the same pass to a bounded fixpoint. Read paths use
//                           it on rows stored before the ingest fix.
//
// Neither can produce '<' or '>': `lt` and `gt` are not in the table, and a numeric
// reference to U+003C / U+003E is returned unchanged. That is what makes it
// safe to run AFTER the tag strip.
// ---------------------------------------------------------------------------

// Named entities that decode to plain text. `lt` and `gt` are deliberately
// absent: they would yield markup. `nbsp` IS here: the first-pass decoder in
// normalize.ts decodes a single-encoded "&nbsp;", but a double-encoded
// "&amp;nbsp;" leaves a literal "&nbsp;" after that pass, and this table is what
// finishes it. It decodes to an ASCII space, the same as the first pass.
//
// The set is the named references that show up in Turkish and Western European
// feeds (stored rows still carry "T&uuml;rkiye", "&Ccedil;ok", "Bakan&rsquo;dan",
// "bekliyor&hellip;"): the Turkish letters, other common accented Latin letters,
// typographic quotes and dashes, and a few symbols. Every value is ONE BMP
// character that XML 1.0 allows and is never '<' or '>'; the table test asserts
// that for every entry, so an addition that breaks it fails the suite. A name
// that is not listed passes through unchanged.
//
// A Map, not an object literal: the regex below accepts any `&name;`, and
// `({})["constructor"]` is a function that a replace callback would stringify
// into the text. `Map#get` has no prototype to fall through to.
export const RESIDUAL_NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  // markup-safe ASCII
  ["quot", '"'],
  ["apos", "'"],
  ["amp", "&"],
  ["nbsp", " "],
  // invisible but legal (U+200C); stored rows still carry a literal "&zwnj;"
  ["zwnj", "\u200C"],
  // Turkish letters
  ["uuml", "ü"],
  ["Uuml", "Ü"],
  ["ouml", "ö"],
  ["Ouml", "Ö"],
  ["ccedil", "ç"],
  ["Ccedil", "Ç"],
  ["scedil", "ş"],
  ["Scedil", "Ş"],
  ["gbreve", "ğ"],
  ["Gbreve", "Ğ"],
  ["Idot", "İ"],
  ["imath", "ı"],
  // circumflex vowels (â î û appear in Turkish loanwords and names)
  ["acirc", "â"],
  ["Acirc", "Â"],
  ["icirc", "î"],
  ["Icirc", "Î"],
  ["ucirc", "û"],
  ["Ucirc", "Û"],
  // other common accented Latin letters
  ["auml", "ä"],
  ["Auml", "Ä"],
  ["agrave", "à"],
  ["aacute", "á"],
  ["eacute", "é"],
  ["Eacute", "É"],
  ["egrave", "è"],
  ["ecirc", "ê"],
  ["iacute", "í"],
  ["oacute", "ó"],
  ["ocirc", "ô"],
  ["uacute", "ú"],
  ["ntilde", "ñ"],
  ["szlig", "ß"],
  // typographic punctuation
  ["lsquo", "\u2018"],
  ["rsquo", "\u2019"],
  ["sbquo", "\u201A"],
  ["ldquo", "\u201C"],
  ["rdquo", "\u201D"],
  ["bdquo", "\u201E"],
  ["ndash", "\u2013"],
  ["mdash", "\u2014"],
  ["hellip", "\u2026"],
  ["laquo", "«"],
  ["raquo", "»"],
  ["lsaquo", "\u2039"],
  ["rsaquo", "\u203A"],
  ["bull", "\u2022"],
  ["middot", "·"],
  // symbols
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "\u2122"],
  ["euro", "\u20AC"],
  ["pound", "£"],
  ["deg", "°"],
  ["times", "×"],
]);

/**
 * Decodes ONE level of the named references in `RESIDUAL_NAMED_ENTITIES`
 * (`&quot;`, `&amp;`, `&nbsp;`, `&uuml;`, `&rsquo;`, ...) and of numeric
 * references (`&#39;`, `&#x27;`, `&#X27;`) in a single left-to-right pass.
 *
 * One level only: the output of a replacement is never re-scanned, so
 * "&amp;quot;" becomes "&quot;", not '"'. It cannot yield '<' or '>': `&lt;`
 * and `&gt;` are not in the table, and a numeric reference whose value is 0x3C
 * or 0x3E (in any zero-padding or radix) is returned UNCHANGED. Every other
 * numeric reference goes through `codePointToString`, which never throws and
 * drops anything XML 1.0 forbids (NUL, controls, surrogates, > U+10FFFF).
 * A name outside the table (`&Foo;`, `&constructor;`) is returned unchanged.
 */
export function decodeResidualEntities(text: string): string {
  return text.replace(
    /&([a-zA-Z][a-zA-Z0-9]*|#\d+|#[xX][0-9a-fA-F]+);/g,
    (match, entity: string) => {
      if (entity[0] === "#") {
        const cp =
          entity[1] === "x" || entity[1] === "X"
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        if (cp === 0x3c || cp === 0x3e) return match;
        return codePointToString(cp);
      }
      return RESIDUAL_NAMED_ENTITIES.get(entity) ?? match;
    },
  );
}

// Defensive ceiling on `repairEntityResidue`'s loop. A changing pass already
// strictly shortens the string (every entity is at least 4 characters and
// decodes to at most 2 UTF-16 units), so the loop terminates on its own; the
// cap only bounds the work on a hostile 10k-character "&amp;amp;amp;..." chain.
const MAX_REPAIR_PASSES = 16;

/**
 * Read-time repair for text stored before the ingest fix: applies
 * `decodeResidualEntities` until the output stops changing (at most 16 passes).
 *
 * Idempotent for any text nested within the pass cap, which covers every real
 * feed: repairing already-repaired text returns it unchanged, so it is safe to
 * apply on both sides of a comparison and to run again on a surface that
 * received already-repaired text. Beyond 16 levels of "&amp;" nesting the
 * result is only partly decoded, never unsafe. Because each pass is
 * `decodeResidualEntities`, it can never create '<' or '>'. Pure, never throws.
 */
export function repairEntityResidue(text: string): string {
  let out = text;
  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    const next = decodeResidualEntities(out);
    if (next === out) break;
    out = next;
  }
  return out;
}
