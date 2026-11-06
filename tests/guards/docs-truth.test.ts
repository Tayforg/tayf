import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { VercelConfig } from "@vercel/config/v1";
import config from "../../vercel";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt 56, h56-docsdrift-1): an operator-facing claim in the
// docs must be a claim the repo can still prove. h29-docs-2 (#178) fixed README
// and architecture.md after vercel.ts grew from one cron to five, but docs/api.md
// and the vercel.ts header comment kept saying "the only Vercel cron", and nothing
// connected the prose to the config. The same sweep found:
//   * docs/architecture.md linked a runbook.md that does not exist,
//   * README.md cited src/app/admin/page.tsx (the page is src/app/admin/(protected)/page.tsx),
//   * "fans out across the 144 RSS sources" while ingest selects only active ones
//     (supabase/functions/ingest/index.ts: .eq("active", true); 118 of 144 on 2026-11-06),
//   * docs/ops-heartbeat.md said social runs until 20:59 UTC, but `*/20 5-20` last
//     fires at 20:40,
//   * docs/architecture.md named two pgmq queues, migration 151 made a third.
//
// What this file checks, each against its source of truth and not a copy of it:
//   1. CRONS    vercel.ts: the cron count, the paths, the schedules. api.md,
//               architecture.md, README.md and vercel.ts's own header comment must
//               not call a Vercel cron "the only" one, must agree on any "<N> Vercel
//               crons" count, must name every route, and every path/schedule pair
//               they print must be the pair vercel.ts holds.
//   2. WINDOW   the social window in docs/ops-heartbeat.md and in the vercel.ts
//               comment is derived from the social schedule, not typed.
//   3. FILES    every relative link to a .md file in README.md and docs/architecture.md
//               resolves; every backticked src/... path in them exists on disk.
//   4. INGEST   the docs may not state an unqualified count of RSS sources while the
//               ingest select filters on active; they carry a dated "N of M" snapshot.
//   5. QUEUES   every pgmq queue a migration creates is named in docs/architecture.md,
//               in prose and in the mermaid diagram.
//
// Excluded on purpose: docs/adr/*, docs/PULL_REQUEST.md and the dated history in
// docs/migration-guide.md describe the state at the time they were written.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CronEntry {
  path: string;
  schedule: string;
}

/** Every `path: "/api/cron/...", schedule: "..."` pair of a vercel.ts source text. */
function cronEntries(source: string): CronEntry[] {
  const out: CronEntry[] = [];
  const re = /path:\s*"(\/api\/cron\/[^"]+)",\s*schedule:\s*"([^"]+)"/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) out.push({ path: m[1] ?? "", schedule: m[2] ?? "" });
  return out;
}

/** The text of the leading block comment(s) of a TS file (everything before `const config`), as one prose string. */
function headerComment(source: string): string {
  const end = source.indexOf("const config");
  const head = end < 0 ? source : source.slice(0, end);
  return head
    .split("\n")
    .map((line) => line.replace(/^\s*(\/\*\*|\*\/|\*)\s?/, ""))
    .join("\n");
}

/** Text with code ticks dropped and every run of whitespace one space: wrapped lines read as one sentence. */
function prose(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ");
}

// `prose` with markdown emphasis (bold, italics) dropped too, for phrase search only: it would corrupt a cron step and a snake_case name.
function phrasing(text: string): string {
  return prose(text).replace(/[*_]/g, "");
}

/** "only Vercel cron", "single remaining Vercel cron", "sole Vercel cron", "one Vercel cron" (singular or plural). */
const SOLE_CRON_CLAIM = /\b(?:only|single|sole|one)\s+(?:remaining\s+)?vercel\s+crons?\b/i;

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** Every "<number> Vercel crons" claim of a prose string, as numbers (digits or English words one to ten). */
function statedCronCounts(text: string): number[] {
  const out: number[] = [];
  const re = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+vercel\s+crons\b/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const word = (m[1] ?? "").toLowerCase();
    out.push(NUMBER_WORDS[word] ?? Number(word));
  }
  return out;
}

/** Lines outside fenced blocks, joined back; the fence is a line that starts with three or more backticks. */
function outsideFences(markdown: string): string {
  const out: string[] = [];
  let fence = 0;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trimStart();
    let run = 0;
    while (trimmed[run] === "`") run++;
    if (fence === 0) {
      if (run >= 3) fence = run;
      else out.push(line);
    } else if (run >= fence && trimmed.trim() === "`".repeat(trimmed.trim().length)) fence = 0;
  }
  return out.join("\n");
}

/** The bodies of the fenced blocks whose info string is `lang`. */
function fencedBlocks(markdown: string, lang: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (current === null) {
      if (trimmed.startsWith("```") && trimmed.slice(3).trim() === lang) current = [];
    } else if (trimmed.startsWith("```")) {
      blocks.push(current.join("\n"));
      current = null;
    } else current.push(line);
  }
  return blocks;
}

/** Backticked tokens of a text, in order. */
function backtickTokens(text: string): string[] {
  const out: string[] = [];
  const re = /`([^`\n]+)`/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1] ?? "");
  return out;
}

const CRON_FIELD = /^[0-9*/,-]+$/;

function isCronExpression(token: string): boolean {
  const fields = token.split(" ");
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
}

/** Relative link targets to `.md` files ([text](target), fragment and query dropped), outside fenced blocks. */
function relativeMarkdownLinks(markdown: string): string[] {
  const out: string[] = [];
  const re = /\]\(([^)\s]+)\)/g;
  const text = outsideFences(markdown);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const target = (m[1] ?? "").split("#")[0]?.split("?")[0] ?? "";
    if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // anchor-only, or http(s):, mailto:, ...
    if (target.endsWith(".md")) out.push(target);
  }
  return out;
}

/** Backticked `src/...` tokens that name a single path (a glob, a placeholder or a phrase is not a path), outside fences. */
function srcPathTokens(markdown: string): string[] {
  return backtickTokens(outsideFences(markdown)).filter((t) => t.startsWith("src/") && !/[\s*{}<>]/.test(t));
}

interface FireWindow {
  step: number;
  first: string;
  last: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** First and last firing of an every-N-minutes schedule with an hour range (step, from-to, three stars), as HH:MM in UTC; else null. */
function fireWindow(schedule: string): FireWindow | null {
  const m = /^\*\/(\d+) (\d+)-(\d+) \* \* \*$/.exec(schedule);
  if (!m) return null;
  const step = Number(m[1]);
  const from = Number(m[2]);
  const to = Number(m[3]);
  if (step < 1 || step > 59 || from > to || to > 23) return null;
  return { step, first: `${pad2(from)}:00`, last: `${pad2(to)}:${pad2(Math.floor(59 / step) * step)}` };
}

/** Shift an HH:MM by whole hours (Istanbul is UTC+3, no daylight saving). */
function shiftHours(hhmm: string, hours: number): string {
  const [h, mm] = hhmm.split(":");
  return `${pad2((Number(h) + hours + 24) % 24)}:${mm ?? "00"}`;
}

/** Queue names a set of migration texts creates with `pgmq.create('<name>')` and does not drop with `pgmq.drop_queue('<name>')`. */
function createdQueues(sqlFiles: string[]): string[] {
  const queues = new Set<string>();
  for (const sql of sqlFiles) {
    const code = sql
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    for (const m of code.matchAll(/pgmq\.create\(\s*'([a-z][a-z0-9_]*)'\s*\)/gi)) queues.add(m[1] ?? "");
    for (const m of code.matchAll(/pgmq\.drop_queue\(\s*'([a-z][a-z0-9_]*)'\s*\)/gi)) queues.delete(m[1] ?? "");
  }
  return [...queues].sort();
}

/** True when `id` appears as a whole identifier (not as a prefix of cluster_attach_shadow, say). */
function mentionsIdentifier(text: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${id}(?![A-Za-z0-9_])`).test(text);
}

// ---------------------------------------------------------------------------
// Sources of truth and the documents under guard
// ---------------------------------------------------------------------------

const VERCEL_TS = read("vercel.ts");
const CRONS = cronEntries(VERCEL_TS);
const CRON_COUNT = CRONS.length;
const shortName = (path: string): string => path.slice("/api/cron/".length);

/** Documents that describe the Vercel crons; vercel.ts is read as its header comment. */
const CRON_DOCS: Array<{ name: string; text: string }> = [
  { name: "docs/api.md", text: read("docs/api.md") },
  { name: "docs/architecture.md", text: read("docs/architecture.md") },
  { name: "README.md", text: read("README.md") },
  { name: "vercel.ts (header comment)", text: headerComment(VERCEL_TS) },
];

// ---------------------------------------------------------------------------
// 1. Vercel crons against vercel.ts
// ---------------------------------------------------------------------------

describe("docs truth: Vercel crons against vercel.ts", () => {
  it("reads the same crons from the source text as the exported config holds (the scan is not vacuous)", () => {
    expect(CRON_COUNT).toBeGreaterThan(1);
    expect(CRONS).toEqual((config as VercelConfig).crons);
  });

  it("no live doc and no vercel.ts comment calls one Vercel cron the only one while vercel.ts defines several", () => {
    expect(CRON_COUNT).toBeGreaterThan(1);
    const hits = CRON_DOCS.filter((d) => SOLE_CRON_CLAIM.test(phrasing(d.text))).map((d) => d.name);
    expect(hits).toEqual([]);
  });

  it("any '<N> Vercel crons' count in those documents is the number of crons in vercel.ts", () => {
    for (const d of CRON_DOCS) {
      for (const stated of statedCronCounts(phrasing(d.text))) expect(stated, `${d.name}: stated cron count`).toBe(CRON_COUNT);
    }
    // At least one document states it, so this test cannot pass by every document being silent.
    expect(CRON_DOCS.flatMap((d) => statedCronCounts(phrasing(d.text))).length).toBeGreaterThan(0);
  });

  it("README.md, docs/architecture.md and the vercel.ts comment name every cron route", () => {
    for (const d of CRON_DOCS.filter((x) => x.name !== "docs/api.md")) {
      for (const { path } of CRONS) expect(d.text.includes(path), `${d.name} names ${path}`).toBe(true);
    }
  });

  it("docs/api.md lists every cron by short name with the schedule vercel.ts holds", () => {
    const api = prose(CRON_DOCS.find((d) => d.name === "docs/api.md")?.text ?? "");
    for (const { path, schedule } of CRONS) {
      expect(api.includes(`${shortName(path)} ${schedule}`), `docs/api.md names "${shortName(path)} ${schedule}"`).toBe(true);
    }
  });

  it("every backticked route followed by a backticked schedule on one line pairs with the schedule in vercel.ts", () => {
    const schedules = new Map(CRONS.map((c) => [c.path, c.schedule]));
    let verified = 0;
    const mismatches: string[] = [];
    for (const file of ["README.md", "docs/architecture.md"]) {
      outsideFences(read(file))
        .split("\n")
        .forEach((line, index) => {
          const tokens = backtickTokens(line);
          const routes = tokens.filter((t) => schedules.has(t));
          const exprs = tokens.filter(isCronExpression);
          // A line that names as many routes as schedules is a list of pairs; any other line is prose about one of them.
          if (routes.length === 0 || routes.length !== exprs.length) return;
          verified++;
          routes.forEach((route, i) => {
            if (schedules.get(route) !== exprs[i]) {
              mismatches.push(`${file}:${index + 1} ${route} is documented as \`${exprs[i]}\` but vercel.ts has \`${schedules.get(route)}\``);
            }
          });
        });
    }
    expect(mismatches).toEqual([]);
    expect(verified).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 2. The social window is derived from its schedule
// ---------------------------------------------------------------------------

describe("docs truth: the social window", () => {
  const social = CRONS.find((c) => c.path === "/api/cron/social");
  const window = fireWindow(social?.schedule ?? "");

  it("vercel.ts schedules social as a '*/N a-b * * *' window", () => {
    expect(social).toBeDefined();
    expect(window).not.toBeNull();
  });

  it("docs/ops-heartbeat.md says social runs from the first to the last firing of that schedule", () => {
    const m = /social every (\d+) minutes from (\d{2}:\d{2}) to (\d{2}:\d{2}) UTC/.exec(prose(read("docs/ops-heartbeat.md")));
    expect(m, "the sentence 'social every N minutes from HH:MM to HH:MM UTC'").not.toBeNull();
    expect({ step: Number(m?.[1]), first: m?.[2], last: m?.[3] }).toEqual(window);
  });

  it("the vercel.ts comment gives the same window in UTC and in Istanbul time (UTC+3)", () => {
    const comment = prose(headerComment(VERCEL_TS));
    const trt = /between (\d{2}:\d{2}) and (\d{2}:\d{2}) TRT \((\d{2}:\d{2})-(\d{2}:\d{2}) UTC\)/.exec(comment);
    expect(trt, "'between HH:MM and HH:MM TRT (HH:MM-HH:MM UTC)'").not.toBeNull();
    expect({ first: trt?.[3], last: trt?.[4] }).toEqual({ first: window?.first, last: window?.last });
    expect({ first: trt?.[1], last: trt?.[2] }).toEqual({
      first: shiftHours(window?.first ?? "", 3),
      last: shiftHours(window?.last ?? "", 3),
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Links and paths against the filesystem
// ---------------------------------------------------------------------------

const LINKED_DOCS = ["README.md", "docs/architecture.md"] as const;

describe("docs truth: links and paths resolve", () => {
  it("every relative link to a .md file in README.md and docs/architecture.md resolves to an existing file", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of LINKED_DOCS) {
      for (const target of relativeMarkdownLinks(read(file))) {
        seen++;
        if (!existsSync(resolve(ROOT, dirname(file), target))) missing.push(`${file} -> ${target}`);
      }
    }
    expect(missing).toEqual([]);
    expect(seen).toBeGreaterThanOrEqual(3);
  });

  it("every backticked src/... path in README.md and docs/architecture.md exists on disk", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of LINKED_DOCS) {
      for (const token of srcPathTokens(read(file))) {
        seen++;
        if (!existsSync(resolve(ROOT, token))) missing.push(`${file}: ${token}`);
      }
    }
    expect(missing).toEqual([]);
    expect(seen).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// 4. Ingest polls the active sources
// ---------------------------------------------------------------------------

describe("docs truth: ingest polls the active sources, not every registered one", () => {
  const SNAPSHOT = /active RSS sources \((\d+) of (\d+) registered on (\d{4}-\d{2}-\d{2})\)/;

  it("the premise holds: the ingest source select filters on active", () => {
    const ingest = read("supabase/functions/ingest/index.ts");
    expect(ingest).toMatch(/from\("sources"\)\s*\.select\([^)]*\)\s*\.eq\("active",\s*true\)/);
  });

  it("README.md and docs/architecture.md never state an unqualified count of RSS sources or feeds", () => {
    for (const file of LINKED_DOCS) {
      // The whole file, fenced diagrams included: README's ASCII flow chart once began with "144 RSS feeds".
      expect(prose(read(file)).match(/\b\d+\s+RSS\s+(?:sources|feeds)\b/gi), `${file}`).toBeNull();
    }
  });

  it("they say the active RSS sources, with a dated 'N of M registered' snapshot that cannot exceed the registered count", () => {
    for (const file of LINKED_DOCS) {
      const m = SNAPSHOT.exec(prose(read(file)));
      expect(m, `${file}: 'active RSS sources (N of M registered on YYYY-MM-DD)'`).not.toBeNull();
      expect(Number(m?.[1]), `${file}: active <= registered`).toBeLessThanOrEqual(Number(m?.[2]));
    }
  });
});

// ---------------------------------------------------------------------------
// 5. pgmq queues against the migrations
// ---------------------------------------------------------------------------

describe("docs truth: pgmq queues", () => {
  const migrationsDir = resolve(ROOT, "supabase", "migrations");
  const queues = createdQueues(
    readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(resolve(migrationsDir, f), "utf8")),
  );
  const architecture = read("docs/architecture.md");

  it("the migrations create at least the three known queues (the scan is not vacuous)", () => {
    expect(queues).toEqual(expect.arrayContaining(["cluster_attach", "cluster_work", "image_backfill"]));
  });

  it("docs/architecture.md names every queue a migration creates", () => {
    expect(queues.filter((q) => !mentionsIdentifier(prose(architecture), q))).toEqual([]);
  });

  it("the architecture mermaid diagram has a node for every one of them", () => {
    const diagram = fencedBlocks(architecture, "mermaid").join("\n");
    expect(diagram.length).toBeGreaterThan(0);
    expect(queues.filter((q) => !mentionsIdentifier(diagram, q))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-tests of the helpers
// ---------------------------------------------------------------------------

describe("docs truth: helper self-tests", () => {
  it("reads cron entries and the header comment, and stops the comment at `const config`", () => {
    const src = [
      "/**",
      " * The single remaining",
      " * Vercel cron is x.",
      " */",
      "const config = {",
      '  crons: [{ path: "/api/cron/a", schedule: "*/5 * * * *" }, { path: "/api/cron/b",',
      '    schedule: "0 6 * * 6" }],',
      "};",
      '// path: "/api/cron/not-a-cron-after-the-comment-block" is only matched when it has a schedule',
    ].join("\n");
    expect(cronEntries(src)).toEqual([
      { path: "/api/cron/a", schedule: "*/5 * * * *" },
      { path: "/api/cron/b", schedule: "0 6 * * 6" },
    ]);
    expect(prose(headerComment(src))).toBe(" The single remaining Vercel cron is x. ");
  });

  it("catches the sole-cron phrasings through markdown emphasis and line wraps, and not the true statements", () => {
    for (const bad of [
      "This is the **only** Vercel cron in the architecture",
      "The single remaining\n * Vercel cron is the rewriter",
      "the _sole_ Vercel cron",
      "a single Vercel cron (`/api/cron/headline`)",
      "ONLY VERCEL CRON",
    ]) {
      expect(SOLE_CRON_CLAIM.test(phrasing(bad)), bad).toBe(true);
    }
    for (const good of [
      "This is one of the five Vercel crons in vercel.ts",
      "A single Vercel region is allowed on every plan",
      "the only cron that calls an LLM",
      "the app side has five Vercel crons",
    ]) {
      expect(SOLE_CRON_CLAIM.test(phrasing(good)), good).toBe(false);
    }
  });

  it("reads '<N> Vercel crons' counts in digits and words", () => {
    expect(statedCronCounts("one of the five Vercel crons, 5 Vercel crons, Six vercel crons, a Vercel cron")).toEqual([5, 5, 6]);
  });

  it("derives the first and last firing of a window schedule, and refuses other shapes", () => {
    expect(fireWindow("*/20 5-20 * * *")).toEqual({ step: 20, first: "05:00", last: "20:40" });
    expect(fireWindow("*/10 8-9 * * *")).toEqual({ step: 10, first: "08:00", last: "09:50" });
    expect(fireWindow("*/7 0-23 * * *")).toEqual({ step: 7, first: "00:00", last: "23:56" });
    for (const other of ["*/5 * * * *", "0 6 * * 6", "*/20 5-20 * * 1-5", "*/0 5-20 * * *", "*/20 20-5 * * *", ""]) {
      expect(fireWindow(other), other).toBeNull();
    }
    expect(shiftHours("20:40", 3)).toBe("23:40");
    expect(shiftHours("05:00", 3)).toBe("08:00");
    expect(shiftHours("22:15", 3)).toBe("01:15");
  });

  it("extracts relative .md links only, outside fences, with fragments dropped", () => {
    const md = [
      "[a](docs/x.md) [b](../y.md#sec) [c](https://example.com/z.md) [d](#local) [e](mailto:a@b.c) [f](img.png)",
      "```",
      "[g](in-fence.md)",
      "```",
      "[h](runbook.md)",
    ].join("\n");
    expect(relativeMarkdownLinks(md)).toEqual(["docs/x.md", "../y.md", "runbook.md"]);
  });

  it("extracts backticked src paths, skipping globs, placeholders, phrases and fenced blocks", () => {
    const md = [
      "See `src/app/page.tsx`, `src/app/cluster/[id]/page.tsx`, `src/**/*.ts`, `src/{a,b}`, `src/lib x`, `docs/x.md`.",
      "```",
      "`src/in/fence.ts`",
      "```",
      "And `src/app/admin/(protected)/page.tsx`.",
    ].join("\n");
    expect(srcPathTokens(md)).toEqual(["src/app/page.tsx", "src/app/cluster/[id]/page.tsx", "src/app/admin/(protected)/page.tsx"]);
  });

  it("finds queues that migrations create, not those in comments, and not those dropped later", () => {
    expect(
      createdQueues([
        "-- perform pgmq.create('ghost');\ndo $$ begin perform pgmq.create('a'); perform pgmq.create( 'b' ); end $$;",
        "-- rollback: select pgmq.drop_queue('a');\nselect pgmq.create('c'); select pgmq.drop_queue('b');",
      ]),
    ).toEqual(["a", "c"]);
  });

  it("matches a queue name as a whole identifier only", () => {
    expect(mentionsIdentifier("QA[(pgmq: cluster_attach, shadow)]", "cluster_attach")).toBe(true);
    expect(mentionsIdentifier("table cluster_attach_shadow", "cluster_attach")).toBe(false);
    expect(mentionsIdentifier("my_cluster_attach", "cluster_attach")).toBe(false);
  });

  it("recognises fenced blocks by language and cron expressions strictly", () => {
    expect(fencedBlocks("a\n```mermaid\ngraph TB\n```\n```sql\nselect 1\n```\n```mermaid\nB\n```", "mermaid")).toEqual(["graph TB", "B"]);
    expect(isCronExpression("*/20 5-20 * * *")).toBe(true);
    expect(isCronExpression("0 6 * * 6")).toBe(true);
    expect(isCronExpression("/api/cron/headline")).toBe(false);
    expect(isCronExpression("* * * *")).toBe(false);
  });
});
