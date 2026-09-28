// ---------------------------------------------------------------------------
// Minimal RSS 2.0 parser for tests.
//
// `fetcher.ts` imports `fast-xml-parser` from an esm.sh URL (Deno-only, not in
// node_modules; see the header of tests/functions/_shared/fetcher.test.ts).
// Tests that want to drive the REAL fetcher against captured feed XML mock
// that one import with `XMLParser: class { parse(x) { return miniParseRss(x) } }`.
//
// It returns the shape fast-xml-parser produces with the fetcher's options
// (attributeNamePrefix "", `item` always an array, values as strings):
//   { rss: { channel: { item: [ { title, link, description, pubDate, guid,
//                                 "dc:date", "content:encoded", "atom:link" } ] } } }
// A body without `<rss` yields `{ html: {} }` (=> NotAFeedError in the fetcher).
// Regex-based on purpose: good enough for the captured fixtures, not a general
// XML parser.
// ---------------------------------------------------------------------------

type Node = Record<string, unknown>;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** Unwrap a CDATA section, or entity-decode plain text. */
function textOf(raw: string): string {
  const trimmed = raw.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(trimmed);
  if (cdata) return (cdata[1] as string).trim();
  return decodeEntities(trimmed);
}

function parseAttrs(attrSrc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of attrSrc.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1] as string] = decodeEntities((m[3] ?? m[4] ?? "") as string);
  }
  return out;
}

function firstTag(body: string, tag: string): string | undefined {
  // Full regex escape (backslash included), not just the XML-name punctuation.
  const esc = tag.replace(/[\\^$.*+?()[\]{}|:-]/g, "\\$&");
  const m = new RegExp(`<${esc}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc}>`).exec(body);
  return m ? textOf(m[1] as string) : undefined;
}

function parseItem(body: string): Node {
  const item: Node = {};
  for (const tag of ["title", "link", "description", "pubDate", "dc:date", "content:encoded"]) {
    // `link` must not match `<atom:link .../>`: the regex requires `<link`.
    const v = firstTag(body, tag);
    if (v !== undefined) item[tag] = v;
  }

  const guid = /<guid((?:\s[^>]*)?)>([\s\S]*?)<\/guid>/.exec(body);
  if (guid) {
    const attrs = parseAttrs((guid[1] as string) ?? "");
    const text = textOf(guid[2] as string);
    item.guid = Object.keys(attrs).length > 0 ? { "#text": text, ...attrs } : text;
  }

  const atoms: Array<{ href: string; rel?: string }> = [];
  for (const m of body.matchAll(/<atom:link\s([^>]*?)\/?>/g)) {
    const a = parseAttrs(m[1] as string);
    if (a.href) atoms.push({ href: a.href, ...(a.rel ? { rel: a.rel } : {}) });
  }
  if (atoms.length === 1) item["atom:link"] = atoms[0];
  else if (atoms.length > 1) item["atom:link"] = atoms;

  return item;
}

export function miniParseRss(xml: string): Record<string, unknown> {
  if (!/<rss[\s>]/.test(xml)) return { html: {} };
  const items: Node[] = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    items.push(parseItem(m[1] as string));
  }
  return { rss: { channel: { item: items } } };
}
