// ---------------------------------------------------------------------------
// Source-text guards read a file as text and must not be satisfied (or tripped)
// by prose in its comments. This blanks `//` and block comments to spaces,
// keeping every offset and newline, with ONE character scan: no regex over the
// source, so the cost is linear in the file size whatever it contains (an
// unterminated comment or a long run of slashes cannot make it quadratic).
//
// String and template literals are copied through untouched, so a `//` inside
// a URL string is not mistaken for a comment. Limits, on purpose: it does not
// understand regex literals or JSX text, so a quote character in either would
// open a "string"; the files it is used on (a route handler, a small client
// component) have neither.
// ---------------------------------------------------------------------------

/** `text` with every character except newlines replaced by a space. */
function blank(text: string): string {
  return text
    .split("\n")
    .map((line) => " ".repeat(line.length))
    .join("\n");
}

export function blankComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close === -1 ? src.length : close + 2;
      out.push(blank(src.slice(i, stop)));
      i = stop;
    } else if (ch === "/" && next === "/") {
      const newline = src.indexOf("\n", i);
      const stop = newline === -1 ? src.length : newline;
      out.push(" ".repeat(stop - i));
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") j++;
        j++;
      }
      const stop = Math.min(j + 1, src.length);
      out.push(src.slice(i, stop));
      i = stop;
    } else {
      out.push(ch);
      i++;
    }
  }
  return out.join("");
}
