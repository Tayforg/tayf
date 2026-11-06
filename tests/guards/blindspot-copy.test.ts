import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h53-consistency-5): blindspot copy describes COVERAGE,
// never MOTIVE.
//
// /blindspots said, in its visible subtitle, its meta description (and so its
// og/twitter descriptions) and both RSS channel descriptions, that the other
// sides "ignored" the story and asked why they are "silent". The site's own
// rule says the opposite: absence in the data can be a clustering split or a
// story nobody has picked up yet, and the recall veto exists because the
// silent side often did cover it (src/lib/social/compose.ts,
// docs/owned-channels.md, /metodoloji, /kalite). A media-bias site must not
// state intent the data cannot show, least of all in a search snippet.
//
// The rule is enforced by a text scan of src (tests excluded): the two
// phrases below may not appear anywhere, comments included, except in the
// four allowlisted places, each pinned to its exact sentence and count so a
// new hit in an allowed file still fails. The surfaces that carried the
// phrases are additionally pinned to the replacement coverage wording.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC = join(ROOT, "src");

/**
 * The phrases that state intent: "[the others] ignored it" and "why are the
 * others silent". Whitespace-tolerant (JSX wraps lines mid-phrase) and
 * case-insensitive; "o" also matches "ö" so an ASCII-folded copy is caught.
 */
const MOTIVE = /g[öo]rmezden\s+gel|neden\s+susuyor/gi;

interface Allowed {
  /** Repo-relative path. */
  file: string;
  /** Exactly how many hits the file is allowed to have. */
  hits: number;
  /** The text around the hit must match this: the allowed sentence itself. */
  context: RegExp;
  why: string;
}

const ALLOWED: readonly Allowed[] = [
  {
    file: "src/app/metodoloji/page.tsx",
    hits: 1,
    context: /görmezden geldi[\s\S]{0,60}ayırt edilemez/i,
    why: 'negates the claim: "diğer taraf görmezden geldi" cannot be told from "henüz kimse haber yapmadı"',
  },
  {
    file: "src/app/kalite/page.tsx",
    hits: 1,
    context: /görmezden geldi[\s\S]{0,40}anlamına gelmez/i,
    why: 'negates the claim: a single-source cluster does not mean "diğerleri görmezden geldi"',
  },
  {
    file: "src/app/api/newsletter/route.ts",
    hits: 1,
    context: /bu e-postayı görmezden gelebilirsiniz/i,
    why: 'unrelated meaning: "you may ignore this e-mail" in the confirmation message',
  },
  {
    file: "src/lib/social/compose.ts",
    hits: 1,
    context: /never\s+"görmezden geldi"/i,
    why: "the comment that states this very rule",
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return relative(ROOT, file).split("\\").join("/");
}

interface Hit {
  /** Text around the hit, whitespace collapsed. */
  around: string;
  line: number;
}

function motiveHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(MOTIVE)) {
    const at = m.index ?? 0;
    hits.push({
      around: text.slice(Math.max(0, at - 40), at + 120).replace(/\s+/g, " "),
      line: text.slice(0, at).split("\n").length,
    });
  }
  return hits;
}

const FILES = walk(SRC);
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the motive scanner itself", () => {
  it("flags the two phrases the blindspots surfaces used to carry", () => {
    expect(motiveHits("diğerlerinin görmezden geldiği hikâyeler")).toHaveLength(1);
    expect(motiveHits("Diğer kaynaklar neden susuyor?")).toHaveLength(1);
  });

  it("is case-insensitive, whitespace-tolerant and folds ö to o", () => {
    expect(motiveHits("GÖRMEZDEN GELDİ")).toHaveLength(1);
    expect(motiveHits("görmezden\n            geldi")).toHaveLength(1);
    expect(motiveHits("gormezden gelen")).toHaveLength(1);
    expect(motiveHits("NEDEN  SUSUYOR")).toHaveLength(1);
  });

  it("does not flag the replacement wording", () => {
    expect(
      motiveHits(
        "diğer taraflardan az ya da hiç haber çıkmayan hikâyeler. Bu bir yok sayma iddiası değil",
      ),
    ).toEqual([]);
  });
});

describe("blindspot copy never states motive (h53-consistency-5)", () => {
  it("scans the real source tree (the scan is not vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(300);
    expect(FILES.map(rel)).toContain("src/app/blindspots/page.tsx");
    expect(FILES.map(rel)).toContain("src/lib/feeds/blindspots-feed.ts");
    expect(FILES.some((f) => /\.test\.tsx?$/.test(f))).toBe(false);
  });

  it("no source file outside the allowlist contains görmezden gel... or neden susuyor", () => {
    const allowed = new Set(ALLOWED.map((a) => a.file));
    const offenders: string[] = [];
    for (const file of FILES) {
      const path = rel(file);
      if (allowed.has(path)) continue;
      for (const hit of motiveHits(readFileSync(file, "utf8"))) {
        offenders.push(`${path}:${hit.line}: ${hit.around}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(ALLOWED.map((a) => [a.file, a] as const))(
    "%s keeps exactly its allowed sentence and nothing more",
    (_file, allowed) => {
      const hits = motiveHits(read(allowed.file));
      // A stale entry (the sentence was reworded away) must be dropped from
      // the allowlist, so the count is exact in both directions.
      expect(hits, allowed.why).toHaveLength(allowed.hits);
      for (const hit of hits) expect(hit.around).toMatch(allowed.context);
    },
  );
});

describe("the surfaces that carried the motive wording now describe coverage", () => {
  const COVERAGE =
    "Bir tarafın haberi verdiği, diğer taraflardan az ya da hiç haber çıkmayan hikâyeler.";

  it("/blindspots: meta description and visible subtitle", () => {
    const page = read("src/app/blindspots/page.tsx");
    expect(page).toContain(
      `${COVERAGE} Türk medyasındaki kör noktaları tek ekranda görün.`,
    );
    expect(page).toContain(
      `${COVERAGE} Bu bir yok sayma iddiası değil: yalnızca spektruma sayılan kaynaklar sayılır.`,
    );
  });

  it("both kör-nokta RSS feeds share one channel description", () => {
    const feed = read("src/lib/feeds/blindspots-feed.ts");
    expect(feed).toContain(COVERAGE);
    // Both URLs go through this one builder (no second copy of the channel text).
    expect(read("src/app/blindspots/rss.xml/route.ts")).toContain("blindspotsFeedResponse");
    expect(read("src/app/rss/[topic]/route.ts")).toContain("blindspotsFeedResponse");
  });

  it("the silence band speaks of coverage ('yer vermedi'), not intent", () => {
    for (const path of [
      "src/lib/clusters/silence-digest.ts",
      "src/components/blindspots/silence-digest-band.tsx",
    ]) {
      expect(motiveHits(read(path)), path).toEqual([]);
    }
  });
});
