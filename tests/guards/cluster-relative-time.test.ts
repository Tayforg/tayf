import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h47-time-1). The service worker keeps /cluster/<id> pages
// for up to 14 days and serves them on a 3 s timeout, offline or on a 5xx. A
// copy carried plain server strings ("Güncellendi: 33 dakika önce") that stayed
// frozen for as long as the copy lived. Three files print an age on the cluster
// page: the header (page.tsx), "Karşı tarafı oku" (read-across-spectrum.tsx)
// and the member rows (framing-comparison.tsx). All three now print it through
// <RelativeTime iso nowMs />, which keeps the server text on the first render
// and re-bases to the reader's clock after mount, so a stale copy shows its real
// age. A direct formatTurkishTimeAgo( call brings the frozen string back.
//
// The page also hands the instant it rendered to <StaleCopyNotice>, taken ONCE,
// in the per-request body, after the page's data await. A clock read in a
// static PPR shell or inside a "use cache" body would stamp the BUILD time (or
// a cache fill) instead of the request, and every reader would be told their
// fresh page is an old copy.
//
// Source scans on comment-stripped text, as in tests/guards/static-page-clock.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const PAGE = "src/app/cluster/[id]/page.tsx";
const READ_ACROSS = "src/components/story/read-across-spectrum.tsx";
const FRAMING = "src/components/story/framing-comparison.tsx";
const NOTICE = "src/components/pwa/stale-copy-notice.tsx";

/** Blanks // and block comments (offsets kept) so prose cannot trip a match. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

function read(rel: string): string {
  return stripComments(readFileSync(resolve(ROOT, rel), "utf8"));
}

/**
 * The text of every `<Tag ... >` or `<Tag ... />` opening tag, found by scanning
 * to the closing `>` at brace depth 0 (a `>` inside an expression prop does not
 * end the element early).
 */
function openingTags(code: string, tag: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(new RegExp(`<${tag}\\b`, "g"))) {
    const start = m.index ?? 0;
    let depth = 0;
    let end = start + m[0].length;
    for (; end < code.length; end++) {
      const ch = code[end];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    out.push(code.slice(start, end + 1));
  }
  return out;
}

/** Number of non-overlapping occurrences of `needle` in `hay`. */
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

describe("cluster page ages are printed through RelativeTime (h47-time-1)", () => {
  for (const file of [PAGE, READ_ACROSS, FRAMING]) {
    describe(file, () => {
      const code = read(file);

      it("has no direct formatTurkishTimeAgo( call and does not import the helper", () => {
        expect(code).not.toMatch(/\bformatTurkishTimeAgo\s*\(/);
        expect(code).not.toMatch(/import[^;]*\bformatTurkishTimeAgo\b/);
      });

      it("prints ages with <RelativeTime iso=... nowMs=... /> only", () => {
        const tags = openingTags(code, "RelativeTime");
        expect(tags.length).toBeGreaterThan(0);
        for (const tag of tags) {
          expect(tag).toMatch(/\biso=\{/);
          expect(tag).toMatch(/\bnowMs=\{/);
        }
        expect(code).toMatch(/import\s*\{\s*RelativeTime\s*\}\s*from\s*"@\/components\/story\/relative-time"/);
      });
    });
  }

  it("page.tsx: two RelativeTime elements (header age and Güncellendi cue), both on renderNowMs", () => {
    const tags = openingTags(read(PAGE), "RelativeTime");
    expect(tags).toHaveLength(2);
    for (const tag of tags) expect(tag).toMatch(/\bnowMs=\{renderNowMs\}/);
  });

  it("read-across-spectrum.tsx and framing-comparison.tsx take a required nowMs prop and pass it on", () => {
    for (const file of [READ_ACROSS, FRAMING]) {
      const code = read(file);
      // Required (no `?`): a caller that forgets it fails typecheck instead of
      // silently printing a frozen age.
      expect(code, file).toMatch(/\bnowMs:\s*number\b/);
      expect(code, file).not.toMatch(/\bnowMs\?:/);
      for (const tag of openingTags(code, "RelativeTime")) {
        expect(tag, file).toMatch(/\bnowMs=\{nowMs\}/);
      }
    }
    expect(read(PAGE)).toMatch(/<ReadAcrossSpectrum[^>]*\bnowMs=\{renderNowMs\}/);
    expect(read(PAGE)).toMatch(/<FramingComparison[^>]*\bnowMs=\{renderNowMs\}/);
  });
});

describe("page.tsx takes renderNowMs once, in the per-request body (h47-time-1)", () => {
  const code = read(PAGE);
  const defaultAt = code.indexOf("export default async function ClusterDetailPage");
  const awaitAt = code.indexOf("await getClusterDetailOrThrow(id)", defaultAt);
  // currentTimeMs() is the repo's Date.now() wrapper (react-hooks/purity forbids
  // the direct call in a component body).
  const clockAt = code.indexOf("currentTimeMs()");

  it("is the only clock read in the file", () => {
    expect(count(code, "currentTimeMs()")).toBe(1);
    expect(code).not.toMatch(/\bDate\.now\(\s*\)/);
    expect(code).not.toMatch(/\bnew Date\(\s*\)/);
    expect(code).toMatch(/const\s+renderNowMs\s*=\s*currentTimeMs\(\)\s*;/);
  });

  it("sits inside ClusterDetailPage, after the data await (never in generateMetadata or a slot)", () => {
    expect(defaultAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(defaultAt);
    expect(clockAt).toBeGreaterThan(awaitAt);
  });

  it("has no 'use cache' directive, so the stamp can never be a cache-fill time", () => {
    expect(code).not.toMatch(/["']use cache/);
  });

  it("mounts exactly one <StaleCopyNotice> on the same stamp the ages use", () => {
    const notices = openingTags(code, "StaleCopyNotice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/\brenderedAtMs=\{renderNowMs\}/);
    expect(code).toMatch(/import\s*\{\s*StaleCopyNotice\s*\}\s*from\s*"@\/components\/pwa\/stale-copy-notice"/);
  });
});

describe("stale-copy-notice.tsx stays a tiny client island (h47-time-1)", () => {
  const raw = readFileSync(resolve(ROOT, NOTICE), "utf8");
  const code = stripComments(raw);

  it("is a client module that imports only react and @/lib/time", () => {
    expect(raw.trimStart().startsWith('"use client"')).toBe(true);
    const imports = [...code.matchAll(/^import[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@/lib/time", "react"]);
  });
});
