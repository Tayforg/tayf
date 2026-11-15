import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h192-yeni-1): the age basis of the newest-first archive list.
//
// ?sirala=yeni orders the archive list by clusters.updated_at, but every card printed the age of first_published, so the
// visible times jumped up and down under an "en yeni" heading. The age pill now takes a basis (src/lib/search/card-age.ts):
// ClusterCard gets `ageBasis` (default "first"), ClusterMetaBadges prints cardAgeParts() instead of ignoring `updatedAt`, and
// the home page passes cardAgeBasis(shownSort) from ONE place, the call inside the `view.archive.map` block. The two in-feed
// calls (Son Dakika, the day buckets) and every other ClusterCard user keep the plain first_published age.
//
// Server components are not render-tested in this repo, so this reads the sources (comments blanked, offsets kept, as in
// tests/guards/heading-outline.test.ts).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

/** Blanks // and block comments, keeping offsets (no `//` inside strings in these files except `https://`). */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

function read(rel: string): string {
  return blankComments(readFileSync(resolve(ROOT, rel), "utf8"));
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Every .ts/.tsx file under `dir` that is not a test, as repo-relative paths. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** The text of the first `{ ... }` block opened at or after `from`, braces balanced. */
function braceBlockAt(src: string, from: number): string {
  const open = src.indexOf("{", from);
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced braces");
}

describe("the newest-first archive list prints the age of updated_at (h192-yeni-1)", () => {
  const page = read("src/app/page.tsx");
  const card = read("src/components/story/cluster-card.tsx");

  it("home: renderClusterCard takes an optional CardAgeBasis and hands it to the card as ageBasis", () => {
    const fn = page.indexOf("function renderClusterCard(");
    expect(fn).toBeGreaterThan(-1);
    const signature = page.slice(fn, page.indexOf(")", page.indexOf("nowMs", fn)) + 1);
    expect(signature).toMatch(/ageBasis\?:\s*CardAgeBasis/);
    const body = braceBlockAt(page, page.indexOf(")", fn));
    expect(count(body, "ageBasis={ageBasis}")).toBe(1);
    expect(page).toMatch(/import\s*\{[^}]*\bcardAgeBasis\b[^}]*\}\s*from\s*"@\/lib\/search\/card-age"/);
  });

  it("home: only the call inside the archive map passes cardAgeBasis(shownSort); the two in-feed calls keep the default", () => {
    const calls = [...page.matchAll(/\brenderClusterCard\(b, /g)].map((m) => m.index!);
    expect(calls).toHaveLength(3);
    expect(count(page, "cardAgeBasis(")).toBe(1);
    const archiveMap = page.indexOf("view.archive.map(");
    expect(archiveMap).toBeGreaterThan(-1);
    const archiveSection = page.slice(archiveMap, page.indexOf("</section>", archiveMap));
    expect(archiveSection).toContain("renderClusterCard(b, renderIndex++, nowMs, cardAgeBasis(shownSort))");
    for (const at of calls) {
      const call = page.slice(at, page.indexOf(")", at) + 1);
      const inArchive = at > archiveMap && at < archiveMap + archiveSection.length;
      if (!inArchive) expect(call).toBe("renderClusterCard(b, renderIndex++, nowMs)");
    }
    // shownSort is the order SHOWN (null for the ranked order and for a newest request the RPC answered ranked), not the asked one.
    expect(page).toMatch(/const shownSort: SearchSort \| null = search\?\.ok === true && search\.newest === true/);
  });

  it("the card: ClusterCard defaults ageBasis to 'first' and forwards it, with updated_at, to ClusterMetaBadges", () => {
    expect(card).toMatch(/ageBasis\?:\s*CardAgeBasis/);
    expect(card).toMatch(/ageBasis\s*=\s*"first"/);
    const tagAt = card.indexOf("<ClusterMetaBadges");
    expect(tagAt).toBeGreaterThan(-1);
    const tag = card.slice(tagAt, card.indexOf("/>", tagAt));
    expect(tag).toContain("updatedAt={cluster.updated_at}");
    expect(tag).toContain("ageBasis={ageBasis}");
    expect(tag).toContain("nowMs={nowMs}");
  });

  it("the card: ClusterMetaBadges no longer ignores updatedAt, it prints cardAgeParts()", () => {
    const fn = card.indexOf("function ClusterMetaBadges(");
    expect(fn).toBeGreaterThan(-1);
    const destructure = card.slice(fn, card.indexOf("}: ClusterMetaBadgesProps", fn));
    expect(destructure).toMatch(/\bupdatedAt\b/);
    expect(destructure).toMatch(/\bageBasis\b/);
    const body = braceBlockAt(card, card.indexOf("}: ClusterMetaBadgesProps", fn));
    expect(body).toContain("cardAgeParts(");
    expect(body).toMatch(/updatedAt/);
    // The pill is built from the parts: the prefix, the age of `iso`, and the title; firstPublished is no longer printed raw.
    expect(body).toMatch(/\bparts\.prefix\b/);
    expect(body).toMatch(/\bparts\.title\b/);
    expect(body).toMatch(/<RelativeTime iso=\{parts\.iso\}/);
    expect(body).toMatch(/formatTurkishTimeAgo\(parts\.iso/);
    expect(body).not.toMatch(/<RelativeTime iso=\{firstPublished\}/);
    expect(body).not.toMatch(/formatTurkishTimeAgo\(firstPublished\)/);
  });

  it("the pill stays inside the div whose id the card link's aria-describedby points at", () => {
    const fn = card.indexOf("function ClusterMetaBadges(");
    const body = braceBlockAt(card, card.indexOf("}: ClusterMetaBadgesProps", fn));
    expect(body).toMatch(/<div id=\{id\}/);
    expect(body.indexOf("parts.prefix")).toBeGreaterThan(body.indexOf("<div id={id}"));
    expect(card).toMatch(/aria-describedby=\{[^}]*\$\{metaId\}/);
  });

  it("no other source file chooses an age basis: only page.tsx, cluster-card.tsx and card-age.ts mention it", () => {
    const users = sourceFiles("src")
      .filter((f) => /\bageBasis\b|\bcardAgeBasis\b|\bcardAgeParts\b/.test(blankComments(readFileSync(resolve(ROOT, f), "utf8"))))
      .map((f) => f.split("\\").join("/"))
      .sort();
    expect(users).toEqual(["src/app/page.tsx", "src/components/story/cluster-card.tsx", "src/lib/search/card-age.ts"]);
  });
});
