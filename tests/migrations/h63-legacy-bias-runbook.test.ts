import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** Escapes every RegExp metacharacter, backslash included. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// Runbook guard for hunt 63, finding h63-clusterintegrity-1.
//
// 034 re-derived clusters.bias_distribution for the last 48 hours only, so
// older clusters still count aggregator and niche votes and 215 of them carry a
// public "Kör nokta" flag that fails the 5-voting-source rule. The repair TOOLS
// already exist and are applied in production (migration 132:
// recompute_bias_distribution_range, clear_false_blindspots_range,
// legacy_bias_voter_dists, plus scripts/recompute-legacy-bias.mjs), so h63 ships
// NO migration: it ships the runbook that tells the founder how to run those
// tools. This file pins that runbook (docs/migration-guide.md, subsection
// "Legacy bias_distribution repair (h63)" under the 034 section):
//
//   * it exists inside the 034 section and says what the operator must know:
//     founder-run prod write, off-peak, chunks of at most 31 days, oldest first,
//     a read-only count before and after, 215 now and 0 after;
//   * the read-only dry-run query is quoted verbatim and every SQL block in the
//     section only reads;
//   * every function the section names is defined by a migration (a runbook
//     that names a function nobody created is a runbook that fails at 3 a.m.);
//   * the apply commands are contiguous, ascending, at most 31 days each;
//   * the live range after 2026-09-05 is dry-run and snapshotted too (the apply
//     covers it, and the October lost-update pair lives there);
//   * the page check quotes the caption the cluster page really renders;
//   * the old "full rebuild" of the 034 section (a one-shot recompute over every
//     cluster, which cannot fit the 8 s PostgREST limit and would newly flag
//     clusters nobody recall-checked) is no longer offered as a runnable block,
//     and no other runnable `select public.recompute_blindspot_flags()` (032
//     verification, 034 step 3, the owner checklist) is left without a
//     "do not re-run" warning: once the repair writes voter-derived
//     distributions, the next global flag pass would flag the 153 clusters
//     nobody recall-checked (132 step 5).
//
// The zone map, voting kinds and 5 / 0.8 thresholds inside the quoted query are
// pinned against the contract modules in zone-parity.test.ts.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const GUIDE_PATH = resolve(ROOT, "docs", "migration-guide.md");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");

const HEADING = "### Legacy bias_distribution repair (h63)";
const SECTION_034 = "## Source kinds (034)";
const SCRIPT = "node scripts/recompute-legacy-bias.mjs";

// Quoted verbatim from the finding (fix_spec, RUNBOOK (a)).
const DRY_RUN_QUERY =
  "with b as (select id, updated_at from clusters where is_blindspot and not is_archived and article_count>=2), v as (select b.id, s.bias from b join cluster_articles ca on ca.cluster_id=b.id join articles a on a.id=ca.article_id join sources s on s.id=a.source_id where s.kind in ('outlet','wire')), z as (select id, case when bias in ('pro_government','gov_leaning','state_media','islamist_conservative','nationalist') then 'i' when bias in ('center','international','pro_kurdish') then 'b' else 'm' end zone, count(*) n from v group by 1,2), t as (select b.id, coalesce(sum(z.n),0) total, coalesce(max(z.n),0) top from b left join z on z.id=b.id group by 1) select count(*) flagged, count(*) filter (where total<5 or top::numeric/nullif(total,0)<0.8) failing from t;";

interface Fence {
  info: string;
  body: string;
}

/** The fenced blocks of a markdown text (indented fences inside list items included). */
function fences(markdown: string): Fence[] {
  const out: Fence[] = [];
  let open: { info: string; lines: string[] } | null = null;
  for (const line of markdown.split("\n")) {
    const t = line.trimStart();
    if (open === null) {
      if (t.startsWith("```")) open = { info: t.slice(3).trim().split(/\s/)[0]?.toLowerCase() ?? "", lines: [] };
    } else if (t.startsWith("```") && t.trim() === "`".repeat(t.trim().length)) {
      out.push({ info: open.info, body: open.lines.join("\n") });
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  return out;
}

/** Statements of a SQL text: `--` comments dropped, split on `;`. */
function statements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const DAY_MS = 86_400_000;
const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

let guide = "";
let section = "";
let sqlBlocks: string[] = [];
let bashBlocks: string[] = [];

beforeAll(() => {
  guide = readFileSync(GUIDE_PATH, "utf8");
  const at = guide.indexOf(HEADING);
  expect(at, `${HEADING} must exist in docs/migration-guide.md`).toBeGreaterThanOrEqual(0);
  // The subsection ends at the next heading or the horizontal rule that closes the 034 section.
  const rest = guide.slice(at + HEADING.length);
  const end = rest.search(/\n#{2,3} |\n---\n/);
  section = HEADING + (end === -1 ? rest : rest.slice(0, end));
  const blocks = fences(section);
  sqlBlocks = blocks.filter((b) => ["sql", "psql"].includes(b.info)).map((b) => b.body);
  bashBlocks = blocks.filter((b) => ["bash", "sh"].includes(b.info)).map((b) => b.body);
});

describe("h63 runbook: placement", () => {
  it("the subsection exists once and sits inside the 034 section", () => {
    expect(guide.split(HEADING).length - 1).toBe(1);
    const start034 = guide.indexOf(SECTION_034);
    expect(start034).toBeGreaterThanOrEqual(0);
    const end034 = guide.indexOf("\n## ", start034 + 1);
    const at = guide.indexOf(HEADING);
    expect(at).toBeGreaterThan(start034);
    expect(at).toBeLessThan(end034);
  });

  it("the section is not empty and has SQL and shell blocks (the scan is not vacuous)", () => {
    expect(section.length).toBeGreaterThan(1500);
    expect(sqlBlocks.length).toBeGreaterThanOrEqual(3);
    expect(bashBlocks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("h63 runbook: what the operator must be told", () => {
  it("says the repair is a founder-run prod write that the worker and CI never run", () => {
    expect(section).toMatch(/founder-run/i);
    expect(section).toMatch(/production write|prod write/i);
    expect(section).toMatch(/never (runs|run|ran)/i);
  });

  it("says off-peak, chunks of at most 31 days, oldest first", () => {
    expect(section).toMatch(/off-peak/i);
    expect(section).toMatch(/31 days/);
    expect(section).toMatch(/oldest first/i);
  });

  it("requires a read-only dry-run count before and after, expecting 215 now and 0 after", () => {
    expect(section).toMatch(/read-only/i);
    expect(section).toMatch(/before/i);
    expect(section).toMatch(/after/i);
    expect(section).toMatch(/failing\D{0,40}215/);
    expect(section).toMatch(/failing\D{0,40}\b0\b/);
    expect(section).toContain("Kör nokta");
    expect(section).toContain("5 voting");
  });

  it("names the existing 132 tools and the script, and says no new migration is needed", () => {
    for (const name of ["132", "recompute_bias_distribution_range", "clear_false_blindspots_range", "scripts/recompute-legacy-bias.mjs"]) {
      expect(section, name).toContain(name);
    }
    expect(section).toMatch(/no new migration/i);
  });

  it("states the expected effect: about 9.3k bars change, 215 pills drop, 153 clusters stay unflagged", () => {
    expect(section).toMatch(/9\.3k/);
    expect(section).toMatch(/215/);
    expect(section).toMatch(/153/);
    expect(section).toMatch(/never (sets|set) a flag|never flag/i);
  });

  it("states the residual: 12 same-source duplicate clusters keep a double vote (voting is per article), a data decision outside this change", () => {
    expect(section).toMatch(/\b12\b/);
    expect(section).toMatch(/same-source/i);
    expect(section).toMatch(/per article/i);
    expect(section).toMatch(/data decision/i);
  });

  it("gives read-only spot checks for the motivating clusters and the lost-update pair", () => {
    for (const id of ["861b4249-f553-41b7-be98-45544008b1bc", "e0c1324a", "52823177"]) {
      expect(section, id).toContain(id);
    }
    // The caption cluster/[id]/page.tsx renders when the stored total equals the voting
    // members (4 outlets here) and one aggregator is not counted. "Spektrum 4 kaynaktan"
    // is the OTHER branch (stored total differs from the voters) and never appears once repaired.
    expect(section).toContain(
      "Spektrum 4 sınıflandırılmış kaynaktan oluşturuldu · 1 toplayıcı / niş kaynak sayılmadı",
    );
    expect(section).not.toContain("Spektrum 4 kaynaktan");
  });

  it("points at the rollback of 132 (CSV snapshots), not at an undo that does not exist", () => {
    expect(section).toMatch(/snapshot/i);
    expect(section).toMatch(/rollback/i);
  });
});

describe("h63 runbook: SQL blocks only read and quote the dry-run query verbatim", () => {
  it("quotes the dry-run count query verbatim in a sql block", () => {
    const hit = sqlBlocks.some((b) => b.trim() === DRY_RUN_QUERY);
    expect(hit, "a sql block equal to the finding's RUNBOOK (a) query").toBe(true);
  });

  it("has a per-window mismatch query filtered on first_published (updated_at windows hit 57014)", () => {
    const q = sqlBlocks.find((b) => /first_published\s*>=/.test(b) && /first_published\s*</.test(b));
    expect(q, "a sql block filtered on first_published").toBeDefined();
    expect(q).toMatch(/s\.kind in \('outlet',\s*'wire'\)/);
    expect(q).toMatch(/jsonb_each_text\(bias_distribution\)/);
    expect(section).toMatch(/57014/);
  });

  it("every statement in every sql block is a plain select / with: no write, no DDL, no recompute call", () => {
    expect(sqlBlocks.length).toBeGreaterThan(0);
    for (const block of sqlBlocks) {
      const stmts = statements(block);
      expect(stmts.length).toBeGreaterThan(0);
      for (const stmt of stmts) {
        expect(stmt, stmt.slice(0, 60)).toMatch(/^(select|with)\b/i);
        expect(stmt, stmt.slice(0, 60)).not.toMatch(
          /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b\s/i,
        );
        expect(stmt, stmt.slice(0, 60)).not.toMatch(
          /\b(recompute_[a-z_]+|clear_false_blindspots_range|cluster_unlink_article)\s*\(/i,
        );
      }
    }
  });
});

describe("h63 runbook: every function it names exists in a migration", () => {
  const defined = new Set<string>();
  beforeAll(() => {
    for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql"))) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, f), "utf8");
      for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_0-9]+)\s*\(/gi)) {
        defined.add((m[1] as string).toLowerCase());
      }
    }
  });

  it("the definition scan is not vacuous (132 and 034 functions are found)", () => {
    expect(defined.has("recompute_bias_distribution_range")).toBe(true);
    expect(defined.has("clear_false_blindspots_range")).toBe(true);
    expect(defined.has("legacy_bias_voter_dists")).toBe(true);
    expect(defined.has("recompute_bias_distribution")).toBe(true);
  });

  it("each recompute_* / clear_* / legacy_* identifier in the section is defined by some migration", () => {
    const names = new Set(
      [...section.matchAll(/\b((?:recompute|clear|legacy)_[a-z_0-9]+)\b/gi)].map((m) => (m[1] as string).toLowerCase()),
    );
    expect(names.size).toBeGreaterThanOrEqual(3);
    for (const n of names) expect(defined.has(n), `${n} is not created by any migration`).toBe(true);
  });
});

describe("h63 runbook: the apply commands", () => {
  interface Cmd {
    from: string;
    to: string;
    apply: boolean;
    line: string;
  }

  function commands(): Cmd[] {
    const out: Cmd[] = [];
    for (const block of bashBlocks) {
      for (const raw of block.split("\n")) {
        const line = raw.trim();
        if (!line.startsWith(SCRIPT)) continue;
        const from = /--from\s+(\d{4}-\d{2}-\d{2})\b/.exec(line)?.[1];
        const to = /--to\s+(\d{4}-\d{2}-\d{2})\b/.exec(line)?.[1];
        if (from && to) out.push({ from, to, apply: /--apply\b/.test(line), line });
      }
    }
    return out;
  }

  it("the section has dated apply commands (the scan is not vacuous)", () => {
    expect(commands().filter((c) => c.apply).length).toBeGreaterThanOrEqual(5);
  });

  it("the dated apply commands start at 2026-04-01, are contiguous and ascending, at most 31 days each, and cover the legacy boundary 2026-09-05 and the live range after it", () => {
    const dated = commands().filter((c) => c.apply);
    expect(dated.length).toBeGreaterThanOrEqual(8);
    expect((dated[0] as Cmd).from).toBe("2026-04-01");
    for (let i = 0; i < dated.length; i++) {
      const c = dated[i] as Cmd;
      const days = (day(c.to) - day(c.from)) / DAY_MS;
      expect(days, c.line).toBeGreaterThan(0);
      expect(days, c.line).toBeLessThanOrEqual(31);
      if (i > 0) expect(c.from, c.line).toBe((dated[i - 1] as Cmd).to);
    }
    // The legacy range ends exactly at a chunk boundary (132's range is updated_at < 2026-09-05)
    expect(dated.some((c) => c.to === "2026-09-05")).toBe(true);
    // ... and chunks continue into the live range (the two lost-update clusters are from October).
    expect((dated[dated.length - 1] as Cmd).to >= "2026-11-01").toBe(true);
  });

  it("no command passes --days above 31 and none applies a range wider than 31 days", () => {
    for (const c of commands()) {
      expect((day(c.to) - day(c.from)) / DAY_MS, c.line).toBeLessThanOrEqual(31);
      const d = /--days\s+(\d+)/.exec(c.line)?.[1];
      if (d !== undefined) expect(Number(d), c.line).toBeLessThanOrEqual(31);
    }
  });

  it("the last command runs from the end of the dated chunks up to tomorrow (a placeholder), so no day is left out", () => {
    const dated = commands().filter((c) => c.apply);
    const lastTo = (dated[dated.length - 1] as Cmd).to;
    expect(section).toMatch(new RegExp(`${escapeRegExp(SCRIPT)} --from ${lastTo} --to <tomorrow[^>]*> --apply`));
  });

  it("dry-runs the live range (read-only) before the first apply, so the live pages are warmed and the October pair is counted", () => {
    const firstApply = section.search(/node scripts\/recompute-legacy-bias\.mjs[^\n]*--apply/);
    expect(firstApply).toBeGreaterThanOrEqual(0);
    const before = section.slice(0, firstApply);
    const span = /`(node scripts\/recompute-legacy-bias\.mjs --from 2026-09-05 --to <tomorrow[^`]*)`/.exec(before);
    expect(span, "an inline dry-run command for the live range before the first --apply").not.toBeNull();
    expect(span![1]).not.toMatch(/--apply/);
    expect(before).toMatch(/would_clear 0/);
  });

  it("the snapshot step names the live windows the apply also covers (2026-09-05, 2026-10-05, 2026-11-05, tomorrow)", () => {
    const start = section.indexOf("**Snapshot**");
    const end = section.indexOf("**Apply**");
    expect(start, "the **Snapshot** step").toBeGreaterThanOrEqual(0);
    expect(end, "the **Apply** step").toBeGreaterThan(start);
    const step2 = section.slice(start, end);
    for (const d of ["2026-09-05", "2026-10-05", "2026-11-05", "<tomorrow"]) {
      expect(step2, d).toContain(d);
    }
    // The 132 \copy is not a sql-fence statement here: the windows stay prose, so the read-only scan holds.
    expect(sqlBlocks.some((b) => /\\copy/.test(b))).toBe(false);
  });

  it("the snapshot step of 132 comes before the first apply", () => {
    const snap = section.search(/snapshot/i);
    const firstApply = section.search(/node scripts\/recompute-legacy-bias\.mjs[^\n]*--apply/);
    expect(snap).toBeGreaterThanOrEqual(0);
    expect(firstApply).toBeGreaterThanOrEqual(0);
    expect(snap).toBeLessThan(firstApply);
  });
});

describe("h63 runbook: the superseded full rebuild is no longer offered", () => {
  it("no fenced block in the guide runs recompute_bias_distribution over 1970-01-01", () => {
    const offenders = fences(guide).filter((b) => /recompute_bias_distribution\s*\(\s*'1970-01-01'/.test(b.body));
    expect(offenders).toEqual([]);
  });

  it("every fenced block that runs select public.recompute_blindspot_flags() says do not re-run (the flag pass would flag the 153 never-recall-checked clusters)", () => {
    const runnable = fences(guide).filter((b) => /select\s+public\.recompute_blindspot_flags\s*\(/.test(b.body));
    // Not vacuous: the 032 verification block and the 034 step 3 block run it.
    expect(runnable.length).toBeGreaterThanOrEqual(2);
    for (const b of runnable) {
      expect(b.body, b.body.slice(0, 80)).toMatch(/do not re-?run/i);
    }
  });

  it("no owner sign-off checklist line asks for recompute_blindspot_flags", () => {
    const lines = guide.split("\n").filter((l) => /^\s*- \[ \]/.test(l));
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.filter((l) => l.includes("recompute_blindspot_flags"))).toEqual([]);
  });

  it("the 034 section says the one-shot rebuild is superseded and why (timeout, 153 never-recall-checked clusters)", () => {
    const start = guide.indexOf(SECTION_034);
    const end = guide.indexOf("\n## ", start + 1);
    const text = guide.slice(start, end);
    expect(text).toMatch(/superseded/i);
    expect(text).toMatch(/recompute_blindspot_flags\(\)/);
    expect(text).toMatch(/timeout/i);
    expect(text).toMatch(/153/);
  });
});
