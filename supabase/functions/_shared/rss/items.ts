// supabase/functions/_shared/rss/items.ts
//
// Pure RSS/Atom item-link resolution (ingest-health). Deliberately free of
// any `esm.sh` import (only `fetcher.ts` needs the XML parser itself) so
// vitest can import this module directly.
//
// Some outlets (Milliyet observed in production) omit a plain `<link>` on
// an `<item>` entirely and rely on `<atom:link href=.../>` plus a
// `<guid isPermaLink="false">` numeric id — a bare `asString(node.link)`
// read (the pre-ingest-health behaviour) resolves to `undefined` for every
// item on that feed. `pickItemLink` tries, in order: the plain `<link>`,
// then an `atom:link` href, then a `guid` that is itself an absolute
// http(s) URL and isn't explicitly marked NOT a permalink.

export type XmlNode = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && "#text" in (v as XmlNode)) {
    const t = (v as XmlNode)["#text"];
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

function isBlank(s: string | undefined): boolean {
  return s === undefined || s.trim() === "";
}

interface LinkCandidate {
  href: string;
  rel?: string;
}

function atomLinkHref(node: XmlNode): string | undefined {
  const raw = node["atom:link"];
  if (raw == null) return undefined;
  const nodes = Array.isArray(raw) ? raw : [raw];

  const candidates: LinkCandidate[] = [];
  for (const n of nodes) {
    if (typeof n === "string") {
      if (!isBlank(n)) candidates.push({ href: n });
      continue;
    }
    if (n && typeof n === "object") {
      const obj = n as XmlNode;
      const href = asString(obj.href);
      if (isBlank(href)) continue;
      const rel = asString(obj.rel);
      candidates.push({ href: href as string, rel });
    }
  }
  if (candidates.length === 0) return undefined;

  // Prefer rel="alternate" or no rel at all.
  const preferred = candidates.find(
    (c) => c.rel === "alternate" || c.rel === undefined,
  );
  if (preferred) return preferred.href;

  // Never rel="self" when another candidate exists.
  const nonSelf = candidates.find((c) => c.rel !== "self");
  if (nonSelf) return nonSelf.href;

  return candidates[0]?.href;
}

function guidLink(node: XmlNode): string | undefined {
  const guid = node.guid;
  if (guid == null) return undefined;

  let text: string | undefined;
  let isPermaLink: string | undefined;
  if (typeof guid === "string") {
    text = guid;
  } else if (typeof guid === "object") {
    const obj = guid as XmlNode;
    text = asString(obj["#text"]) ?? asString(guid);
    const perma = obj.isPermaLink;
    isPermaLink = typeof perma === "string" ? perma : undefined;
  } else {
    text = asString(guid);
  }

  if (isBlank(text)) return undefined;
  if (isPermaLink === "false") return undefined;

  const trimmed = (text as string).trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Resolves the best link for one RSS/Atom `<item>`/`<entry>` node: the
 * plain `<link>` text if present and non-blank, else an `atom:link` href
 * (preferring `rel="alternate"`/no-rel, never `rel="self"` when another
 * candidate exists), else a `<guid>` that is itself an absolute http(s) URL
 * and not explicitly marked `isPermaLink="false"`. Returns `undefined` when
 * none of the three produce a usable value.
 */
export function pickItemLink(node: XmlNode): string | undefined {
  const link = asString(node.link);
  if (!isBlank(link)) return link;

  const atom = atomLinkHref(node);
  if (!isBlank(atom)) return atom;

  return guidLink(node);
}
