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
// The same module also serves /hafta, which is a trailing 7-day window and not
// a calendar week (h15-tz-1): its page must take the "rolling" wording and
// never print "Bu hafta" (that belongs to /hafta/<current ISO week>). The home
// feed's section labels follow the Istanbul calendar day for the same reason.
//
// Comments are blanked before matching (the files explain the old wording in
// comments); string literals are kept.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

const SECTIONS = resolve(ROOT, "src/components/weekly/week-sections.tsx");
const PAGE = resolve(ROOT, "src/app/hafta/[hafta]/page.tsx");
const ROLLING_PAGE = resolve(ROOT, "src/app/hafta/page.tsx");
const HOME_PAGE = resolve(ROOT, "src/app/page.tsx");

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

// ---------------------------------------------------------------------------
// h15-tz-1: /hafta is a rolling 7-day page. Verified on prod 2026-11-01
// 21:25Z: /hafta said 'Bu hafta kim neyi öne çıkardı' and 'Yüzdeler bu haftanın
// toplam 6.989 haberi' under a subtitle reading 'Son 7 günün ...', while
// /hafta/2026-W45 (the actual current week) also said 'Bu hafta' with a total
// of 2. Its copy now comes from weekCopyFor("rolling").
// ---------------------------------------------------------------------------

const rollingCode = existsSync(ROLLING_PAGE)
  ? blankComments(readFileSync(ROLLING_PAGE, "utf8"))
  : "";

describe("rolling /hafta page", () => {
  it("exists and is substantial", () => {
    expect(existsSync(ROLLING_PAGE)).toBe(true);
    expect(rollingCode.length).toBeGreaterThan(500);
  });

  it("holds no 'bu hafta' literal in any casing", () => {
    const lower = rollingCode.toLocaleLowerCase("tr-TR");
    expect(lower).not.toContain("bu hafta");
    expect(lower).not.toContain("bu haftanın");
  });

  it("sources its copy from week-copy through weekCopyFor(\"rolling\")", () => {
    expect(rollingCode).toMatch(/from\s+["']@\/lib\/weekly\/week-copy["']/);
    expect(rollingCode).toContain('weekCopyFor("rolling")');
  });

  it("does not keep a page-local copy of the whole-page empty state", () => {
    expect(rollingCode).not.toMatch(/\bEMPTY_COPY\b/);
    expect(rollingCode).toContain("copy.empty");
  });

  it.each(["ZoneShares", "WidestSpectrum", "Blindspots"])(
    "passes variant=\"rolling\" to <%s>",
    (component) => {
      const tag = new RegExp(`<${component}\\b[\\s\\S]*?/>`).exec(rollingCode);
      expect(tag, `<${component} .../> must be rendered`).toBeTruthy();
      expect(tag![0]).toContain('variant="rolling"');
    },
  );

  it("takes the label-changes empty state from the copy, not a literal", () => {
    expect(rollingCode).toContain("copy.labelUnchanged");
    expect(rollingCode).not.toMatch(/etiket değişmedi/);
  });
});

// The page file alone is not enough: /hafta also renders components that print
// their own reader copy. DistinctiveWords still said 'Bu hafta <zone>
// medyasında ...' in every zone column after the page itself was fixed, and the
// truncation caveat in week-sections.tsx said 'haftanın tamamı değil' on the
// rolling page. Every @/components/weekly/* module the rolling page imports is
// scanned, so a component added later is covered without touching this list.
const WEEKLY_COMPONENT_IMPORT = /from\s+["']@\/components\/weekly\/([\w-]+)["']/g;
const rollingComponents = Array.from(rollingCode.matchAll(WEEKLY_COMPONENT_IMPORT)).map((m) => m[1]!);

describe("components the rolling /hafta page renders", () => {
  it("includes the distinctive-words and week-sections components", () => {
    expect(rollingComponents).toContain("distinctive-words");
    expect(rollingComponents).toContain("week-sections");
  });

  it.each([...new Set(rollingComponents)])(
    "src/components/weekly/%s.tsx holds no 'bu hafta' or 'haftanın tamamı' literal",
    (name) => {
      const path = resolve(ROOT, `src/components/weekly/${name}.tsx`);
      expect(existsSync(path)).toBe(true);
      const lower = blankComments(readFileSync(path, "utf8")).toLocaleLowerCase("tr-TR");
      expect(lower.length).toBeGreaterThan(200);
      // Calendar-week wording on a rolling 7-day page ('Bu hafta ...').
      expect(lower, `${name} must not hold a 'bu hafta' literal`).not.toContain("bu hafta");
      // The truncation caveat prints on /hafta and on /hafta/<week>: it names
      // the period, never 'the week'.
      expect(lower, `${name} must not hold a 'haftanın tamamı' literal`).not.toContain("haftanın tamamı");
    },
  );
});

describe("closed-week page and rolling page stay on different wording", () => {
  it("[hafta]/page.tsx never asks for the rolling variant", () => {
    const text = code["src/app/hafta/[hafta]/page.tsx"]!;
    expect(text).not.toContain('"rolling"');
  });
});

// ---------------------------------------------------------------------------
// h15-tz-1: the home feed's section headings follow the Istanbul calendar day
// ('Bugün' / 'Dün' / 'Son 7 gün' / 'Daha eski'), computed by
// src/lib/home/day-buckets.ts. The old buckets were 'now - t < 24 h' and
// 'now - t < 7 d' labelled 'Bugün' / 'Bu hafta', so just after midnight the
// whole of yesterday's news sat under 'Bugün'.
// ---------------------------------------------------------------------------

const homeCode = existsSync(HOME_PAGE)
  ? blankComments(readFileSync(HOME_PAGE, "utf8"))
  : "";

describe("home feed day buckets", () => {
  it("groups through groupByDayBucket from the shared module", () => {
    expect(homeCode).toMatch(/from\s+["']@\/lib\/home\/day-buckets["']/);
    expect(homeCode).toContain("groupByDayBucket(");
  });

  it("holds no rolling-window bucket constants or 'Bu hafta' label", () => {
    expect(homeCode).not.toMatch(/\bDAY_MS\b/);
    expect(homeCode).not.toMatch(/\bWEEK_MS\b/);
    expect(homeCode).not.toMatch(/\bBUCKETS\b/);
    expect(homeCode.toLocaleLowerCase("tr-TR")).not.toContain("bu hafta");
  });
});
