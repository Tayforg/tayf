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
