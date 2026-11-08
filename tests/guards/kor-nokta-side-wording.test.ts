import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h72-newreader-1): how "kör nokta" names a side.
//
// /blindspots counts a story under the side that WROTE it (the dominant zone).
// "İktidar tarafında 38" therefore counted what İktidar wrote, yet in plain
// Turkish it reads as "the government side's blind spot", the opposite of what
// is counted; and the cluster page's "kör nokta (Muhalefet)" put the SILENT
// zone in brackets on a story the İktidar side wrote. The rule is one word
// order: name the writing side with "ağırlıklı" ("İktidar ağırlıklı 38"), name
// a silent zone inside a sentence, and never write a zone in brackets after
// "kör nokta" or "X tarafında N" for a kör-nokta count.
//
// The cluster page and /blindspots must also link the definition at
// /metodoloji#kor-nokta, which holds the rule these counts come from.
//
// A static source scan (AGENTS.md: no render tests of server components).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC = join(ROOT, "src");

/** A zone in brackets right after "kör nokta": the silent zone read as the owner. */
const BRACKETED_ZONE = /kör nokta \(/;
/** The count builders' old template: "İktidar tarafında ${formatCountTr(n)}". */
const SIDE_COUNT_TEMPLATE = "tarafında ${formatCountTr";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const SOURCES = walk(SRC).map((file) => ({
  file: relative(ROOT, file).split(sep).join("/"),
  text: readFileSync(file, "utf8"),
}));

describe("kör nokta side wording (h72-newreader-1)", () => {
  it("scans a real source tree (the scan below is not vacuous)", () => {
    expect(SOURCES.length).toBeGreaterThan(100);
    expect(SOURCES.some((s) => s.file === "src/lib/clusters/silence-digest.ts")).toBe(true);
  });

  it("detects the two old wordings it forbids", () => {
    expect(BRACKETED_ZONE.test("— kör nokta (Muhalefet)")).toBe(true);
    expect(BRACKETED_ZONE.test("haber yok (kör nokta)")).toBe(false);
    expect("`İktidar tarafında ${formatCountTr(n)}`".includes(SIDE_COUNT_TEMPLATE)).toBe(true);
    expect("`İktidar ağırlıklı ${formatCountTr(n)}`".includes(SIDE_COUNT_TEMPLATE)).toBe(false);
  });

  it("no source file puts a zone in brackets after 'kör nokta'", () => {
    const offenders = SOURCES.filter((s) => BRACKETED_ZONE.test(s.text)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("no source file builds a 'X tarafında N' count", () => {
    const offenders = SOURCES.filter((s) => s.text.includes(SIDE_COUNT_TEMPLATE)).map(
      (s) => s.file,
    );
    expect(offenders).toEqual([]);
  });

  it.each(["src/app/cluster/[id]/page.tsx", "src/app/blindspots/page.tsx"])(
    "%s links the definition at /metodoloji#kor-nokta",
    (file) => {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text).toContain("/metodoloji#kor-nokta");
    },
  );

  it("/metodoloji still has the #kor-nokta anchor those links point to", () => {
    const text = readFileSync(join(SRC, "app/metodoloji/page.tsx"), "utf8");
    expect(text).toContain('id="kor-nokta"');
  });
});
