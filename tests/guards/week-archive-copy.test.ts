import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard: the closed-week archive (/hafta/<week>) must never go
// back to printing developer jargon or present-tense copy.
//
// Verified on prod 2026-11-01 (h9-routing-2): GET /hafta/2026-W43, a closed
// week, printed 'payda bilinmiyor' three times, a footnote about the
// "son 72 saatte" delivering sources and "şu anda bilinmiyor", "Bu hafta ..."
// headings for a week that was over, 'geri çağırma vetosu' and a link called
// 'Güncel özet: /hafta'. All reader copy for these sections now lives in
// src/lib/weekly/week-copy.ts (pure, unit-tested for the same terms), so the
// two component files must hold NO such literal themselves: a new string
// added in place would bypass the closed-week wording.
//
// Comments are blanked before matching (the files explain the old wording in
// comments); string literals are kept.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

const SECTIONS = resolve(ROOT, "src/components/weekly/week-sections.tsx");
const PAGE = resolve(ROOT, "src/app/hafta/[hafta]/page.tsx");

/**
 * Same length as the input, comments replaced by spaces (newlines kept), string
 * and template literals left intact. A quote with no closing partner on its
 * own line (a JSX apostrophe) is treated as a plain character so it cannot
 * swallow the rest of the file.
 */
function blankComments(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        j++;
      }
      i = src[j] === c ? j + 1 : i + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

const files = [
  { name: "src/components/weekly/week-sections.tsx", path: SECTIONS },
  { name: "src/app/hafta/[hafta]/page.tsx", path: PAGE },
];

const code = Object.fromEntries(
  files.map((f) => [f.name, existsSync(f.path) ? blankComments(readFileSync(f.path, "utf8")) : ""]),
) as Record<string, string>;

const BANNED = [
  "payda bilinmiyor",
  "vetosu",
  "veto",
  "geri çağırma",
  "Güncel özet: /hafta",
  "72 saat",
  "şu anda bilinmiyor",
];

describe("closed-week archive copy guard", () => {
  it.each(files)("$name exists and sources its copy from week-copy", ({ name, path }) => {
    expect(existsSync(path)).toBe(true);
    expect(code[name]).toMatch(/\bweekCopy\b/);
    expect(code[name]).toMatch(/from\s+["']@\/lib\/weekly\/week-copy["']/);
  });

  it.each(files)("$name holds no jargon or present-tense literal", ({ name }) => {
    const text = code[name]!;
    expect(text.length).toBeGreaterThan(500);
    const lower = text.toLocaleLowerCase("tr-TR");
    for (const term of BANNED) {
      expect(lower, `${name} must not contain "${term}"`).not.toContain(
        term.toLocaleLowerCase("tr-TR"),
      );
    }
    // 'Bu hafta' in any casing: a closed week says 'O hafta', and the live
    // wording lives in week-copy.ts.
    expect(lower, `${name} must not hold a 'bu hafta' literal`).not.toContain("bu hafta");
  });

  it("[hafta]/page.tsx derives its copy from the closed state of the week", () => {
    const text = code["src/app/hafta/[hafta]/page.tsx"]!;
    expect(text).toContain("weekCopy(!isCurrentWeek)");
    expect(text).toContain("copy.latestLinkText");
  });

  it.each(["ZoneShares", "WidestSpectrum", "Blindspots"])(
    "[hafta]/page.tsx passes archive={!isCurrentWeek} to <%s>",
    (component) => {
      const text = code["src/app/hafta/[hafta]/page.tsx"]!;
      const tag = new RegExp(`<${component}\\b[\\s\\S]*?/>`).exec(text);
      expect(tag, `<${component} .../> must be rendered`).toBeTruthy();
      expect(tag![0]).toContain("archive={!isCurrentWeek}");
    },
  );

  it("week-sections.tsx renders the /kaynaklar/durum link only under copy.showStatusLink", () => {
    const text = code["src/components/weekly/week-sections.tsx"]!;
    const occurrences = text.split("/kaynaklar/durum").length - 1;
    expect(occurrences).toBe(1);
    expect(text).toMatch(/copy\.showStatusLink\s*(\?|&&)\s*\(?\s*<Link[^>]*href="\/kaynaklar\/durum"/);
  });

  it("week-sections.tsx renders the per-zone source count only under copy.showSourceCounts", () => {
    const text = code["src/components/weekly/week-sections.tsx"]!;
    expect(text).toMatch(/copy\.showSourceCounts\s*&&\s*delivering\s*!==\s*null/);
  });

  it("week-sections.tsx lets every section opt into archive wording", () => {
    const text = code["src/components/weekly/week-sections.tsx"]!;
    expect((text.match(/weekCopy\(archive\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
