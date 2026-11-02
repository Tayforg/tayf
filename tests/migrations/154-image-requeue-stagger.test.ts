import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test, FIFO simulation and (opt-in) live checks for migration
// 154 ("image_requeue_stagger"), hunt-28 (h28-freshness-2).
//
// 142's hourly image-backfill-requeue sent 150 messages at minute 17 with no delay.
// The image-consumer drains 40 messages per 5 minute tick, so the burst kept the
// consumer busy for about 15 minutes and every FRESH article enqueued behind it (the
// queue is FIFO by msg_id) waited p95 1026 s for its image; about 89% of the retries
// (attempts 3 and 4) never healed.
//
// 154 changes the function and the cron job, nothing else:
//   * selection: image_backfill_attempts between 1 and 2 (the second and third try, the
//     only ones with a yield);
//   * every send is the 3-argument pgmq.send(queue, msg, least(v_sent * 20, 900)), so
//     the batch becomes visible one message per 20 s;
//   * cadence: '2,17,32,47 * * * *' with requeue(40) instead of '17 * * * *' with
//     requeue(150): 160 messages an hour of capacity (>= the old 150), and the largest
//     delay is 39 * 20 = 780 s. The brief's literal design (hourly 150 with the same
//     stagger) would hold messages up to 2,980 s invisible; pgmq.metrics counts invisible
//     messages in oldest_msg_age_sec, so /api/health (1800 s) would go degraded from
//     about :47 to :70 every hour, and 150's queue_lag row would warn too. The
//     simulation below proves both numbers.
//
// This file pins: the ledger row, one transaction with a lock_timeout, the function
// (same signature, body equal to 142's except for the two changes), the privileges,
// the cron block (by name, nothing else touched), the ops_cron_expected note update,
// the header, the docs, the simulation (OLD, NEW and BRIEF-LITERAL designs) and, with
// TAYF_PSQL, the behaviour on a throwaway Postgres.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE = "154_image_requeue_stagger.sql";
const MIGRATION_154 = resolve(MIGRATIONS_DIR, FILE);
const MIGRATION_142 = resolve(MIGRATIONS_DIR, "142_image_backfill_retry.sql");
const DRYRUN = resolve(ROOT, "tests", "migrations", "sql", "154-image-requeue-stagger-dryrun.sql");
const GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const HEARTBEAT = resolve(ROOT, "docs", "ops-heartbeat.md");

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Comment-free, whitespace-collapsed form. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

/** norm() with the padding inside parentheses removed, so a wrapped call compares equal to a one-line one. */
function tight(sql: string): string {
  return norm(sql).replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

/**
 * Contents of the adjacent string literals (Postgres concatenates them) that follow
 * `start`, up to the next `;` outside a literal. A character scan, not a regex, so a
 * long run of '' escapes cannot backtrack.
 */
function literalsAfter(sql: string, start: string): string {
  const at = sql.indexOf(start);
  if (at < 0) return "";
  let out = "";
  let inString = false;
  for (let i = at + start.length; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch !== "'") out += ch;
      else if (sql[i + 1] === "'") {
        out += "''";
        i++;
      } else inString = false;
    } else if (ch === "'") inString = true;
    else if (ch === ";") break;
  }
  return out;
}

/**
 * The text of the call that starts at `callStart` (index of the function name), split
 * into its top-level arguments. A character scan that follows parentheses and string
 * literals, so a comma inside jsonb_build_object(...) or least(...) does not split.
 */
function callArguments(text: string, callStart: number): string[] {
  const open = text.indexOf("(", callStart);
  expect(open).toBeGreaterThan(-1);
  const args: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          current += "'";
          i++;
        } else inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === "(") {
      depth++;
      if (depth > 1) current += ch;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      current += ch;
    } else if (ch === "," && depth === 1) {
      args.push(current.trim());
      current = "";
    } else current += ch;
  }
  throw new Error("unbalanced call");
}

const sql = readFileSync(MIGRATION_154, "utf8");
const code = stripSqlComments(sql);
const n = norm(sql);
/** Everything before the transaction: the header comment block. */
const header = sql.slice(0, sql.search(/^begin;/m));

const sql142 = readFileSync(MIGRATION_142, "utf8");
const code142 = stripSqlComments(sql142);

const FN = "public.image_backfill_requeue";
const FN_SIG = `${FN}(integer)`;
const SCHEDULE = "2,17,32,47 * * * *";

/** Between `as $fn$` and `$fn$;` of a migration's create function. */
function fnBody(source: string): string {
  const open = source.indexOf("as $fn$");
  expect(open).toBeGreaterThan(-1);
  const close = source.indexOf("$fn$;", open + 7);
  expect(close).toBeGreaterThan(open);
  return source.slice(open + 7, close);
}

/** True when a header line starts with `-- <label>` followed by a non-word character (a character scan, no dynamic RegExp). */
function hasSection(label: string): boolean {
  const prefix = `-- ${label}`;
  return header.split("\n").some((line) => line.startsWith(prefix) && !/\w/.test(line.charAt(prefix.length)));
}

// The function head by string indexing: the arguments up to the first `)`, then everything up to `as $fn$`.
const FN_OPEN = "create or replace function public.image_backfill_requeue(";
const fnOpenAt = code.indexOf(FN_OPEN);
const fnAsAt = code.indexOf("as $fn$", fnOpenAt);
const fnHeadText = fnOpenAt < 0 || fnAsAt < 0 ? "" : code.slice(fnOpenAt + FN_OPEN.length, fnAsAt);
const fnHead = fnHeadText.includes(")") ? fnHeadText : null;
const fnArgs = norm(fnHead?.slice(0, fnHead.indexOf(")")) ?? "");
const fnReturns = norm(fnHead?.slice(fnHead.indexOf(")") + 1) ?? "");
const fnAttrs = fnReturns.startsWith("returns ") ? fnReturns.slice("returns ".length) : fnReturns;
const body = tight(fnBody(code));
const body142 = tight(fnBody(code142));

const cronBlock = /do \$cron\$([\s\S]*?)\$cron\$;/i.exec(code)?.[1] ?? "";
const cron = norm(cronBlock);

const SEND_142 = "perform pgmq.send('image_backfill', pg_catalog.jsonb_build_object('article_id', r.id));";
const SEND_154 =
  "perform pgmq.send('image_backfill', pg_catalog.jsonb_build_object('article_id', r.id), least(v_sent * 20, 900));";

// The migration's own constants, read from the text: the simulation below is built from them.
const STAGGER = Number(/least\(v_sent \* (\d+), (\d+)\)/.exec(body)?.[1]);
const DELAY_CAP = Number(/least\(v_sent \* (\d+), (\d+)\)/.exec(body)?.[2]);
const SCHEDULED_N = Number(/select public\.image_backfill_requeue\((\d+)\);/.exec(cron)?.[1]);
const SCHEDULE_MINUTES = (/perform cron\.schedule\('image-backfill-requeue', '([0-9,]+) \* \* \* \*'/.exec(cron)?.[1] ?? "")
  .split(",")
  .map(Number);

describe("154 image_requeue_stagger: file, ledger and transaction", () => {
  it("is the only 154_ migration and has the agreed name", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("154_"));
    expect(files).toEqual([FILE]);
  });

  it("records version 154 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(n).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('154', '154_image_requeue_stagger') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the ledger row the last statement", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const tail = n.slice(n.indexOf("begin;"));
    expect(
      tail.endsWith(
        "insert into supabase_migrations.schema_migrations (version, name) values ('154', '154_image_requeue_stagger') on conflict do nothing; commit;",
      ),
    ).toBe(true);
  });

  it("sets a local lock_timeout of 5s right after begin", () => {
    expect(n).toContain("begin; set local lock_timeout = '5s';");
  });

  it("reloads the PostgREST schema cache before the ledger row", () => {
    expect(n).toContain("notify pgrst, 'reload schema'; insert into supabase_migrations.schema_migrations");
  });
});

describe("154 image_requeue_stagger: function signature", () => {
  it("creates or replaces exactly one function with 142's signature, so no drop function is needed", () => {
    expect([...code.matchAll(/\bcreate\s+(or\s+replace\s+)?function\b/gi)]).toHaveLength(1);
    expect(fnHead).not.toBeNull();
    expect(fnArgs).toBe("p_limit integer default 300");
    expect(code).not.toMatch(/\bdrop\s+function\b/i);
  });

  it("returns integer, plpgsql, volatile, security definer, with an empty search_path (142's attributes)", () => {
    expect(fnAttrs).toBe("integer language plpgsql volatile security definer set search_path = ''");
  });

  it("has an updated comment naming migration 154, the stagger, the attempts window and service_role", () => {
    expect(n).toMatch(/comment on function public\.image_backfill_requeue\(integer\) is '/);
    const doc = literalsAfter(code, "comment on function public.image_backfill_requeue(integer) is");
    expect(doc).toContain("migration 154");
    expect(doc).toContain("1 or 2");
    expect(doc).toContain("20 s");
    expect(doc).toContain("p_limit");
    expect(doc).toContain("service_role only");
  });
});

describe("154 image_requeue_stagger: function body", () => {
  it("equals 142's body except for exactly two changes: attempts between 1 and 2, and the delayed send", () => {
    // split/join replaces EVERY occurrence; each pattern must occur exactly once in 142's body
    expect(body142.split("a.image_backfill_attempts between 1 and 4")).toHaveLength(2);
    expect(body142.split(SEND_142)).toHaveLength(2);
    const expected = body142
      .split("a.image_backfill_attempts between 1 and 4")
      .join("a.image_backfill_attempts between 1 and 2")
      .split(SEND_142)
      .join(SEND_154);
    expect(body).toBe(expected);
  });

  it("selects only image-less articles with attempts between 1 and 2 (the second and third tries)", () => {
    expect(body).toContain("from public.articles a");
    expect(body).toMatch(/\ba\.image_url is null\b/);
    expect(body).toContain("a.image_backfill_attempts between 1 and 2");
    expect(body).not.toMatch(/between 1 and 4/);
    expect(body).not.toMatch(/between 1 and 3/);
  });

  it("keeps 142's clamp, the 2 hour and 7 day windows, the NULL-safe queue guard and newest-first order", () => {
    expect(body).toContain("v_limit integer := least(greatest(coalesce(p_limit, 300), 1), 1000);");
    expect(body).toContain("a.image_backfill_attempted_at < pg_catalog.now() - interval '2 hours'");
    expect(body).toContain("a.created_at > pg_catalog.now() - interval '7 days'");
    expect(body).toContain(
      "a.id::text not in (select q.message ->> 'article_id' from pgmq.q_image_backfill q where q.message ->> 'article_id' is not null)",
    );
    expect(body).toContain("order by a.created_at desc limit v_limit");
  });

  it("has exactly one pgmq.send, with 3 arguments: the queue, the payload and least(v_sent * 20, 900)", () => {
    expect([...body.matchAll(/pgmq\.send\(/g)]).toHaveLength(1);
    const args = callArguments(body, body.indexOf("pgmq.send("));
    expect(args).toEqual([
      "'image_backfill'",
      "pg_catalog.jsonb_build_object('article_id', r.id)",
      "least(v_sent * 20, 900)",
    ]);
  });

  it("computes the delay from the count sent so far, BEFORE v_sent is incremented (the first message has delay 0)", () => {
    expect(body.indexOf("least(v_sent * 20, 900)")).toBeGreaterThan(-1);
    expect(body.indexOf("least(v_sent * 20, 900)")).toBeLessThan(body.indexOf("v_sent := v_sent + 1;"));
    expect(body).toMatch(/v_sent integer := 0;/);
    expect(body).toMatch(/return v_sent; end;?$/);
  });

  it("uses a whole number of seconds (the integer overload of pgmq.send) and a 900 s cap", () => {
    expect(STAGGER).toBe(20);
    expect(DELAY_CAP).toBe(900);
    expect(Number.isInteger(STAGGER) && Number.isInteger(DELAY_CAP)).toBe(true);
  });

  it("qualifies every name (empty search_path): now() and jsonb_build_object come from pg_catalog, least is a keyword-like builtin", () => {
    expect(body).not.toMatch(/(?<!pg_catalog\.)\bnow\s*\(/);
    expect(body).not.toMatch(/(?<!pg_catalog\.)\bjsonb_build_object\s*\(/);
    expect(body).not.toMatch(/\bfrom\s+(?!public\.|pgmq\.)[a-z_]+\b/);
  });
});

describe("154 image_requeue_stagger: privileges", () => {
  it("has 142's revoke and grant, exactly (lines 238-239 of 142)", () => {
    expect(n).toContain(`revoke all on function ${FN_SIG} from public, anon, authenticated;`);
    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual([`grant execute on function ${FN_SIG} to service_role;`]);
    const grants142 = [...code142.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual(grants142);
    const revokes = [...code.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => norm(m[0]));
    const revokes142 = [...code142.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(revokes).toEqual(revokes142);
  });

  it("revokes before it grants", () => {
    expect(n.indexOf("revoke all on function")).toBeLessThan(n.indexOf("grant execute on function"));
  });

  it("grants nothing on pgmq and no default privileges (the 024-028 tripwire stays green)", () => {
    for (const m of code.matchAll(/\bgrant\b[^;]*;/gi)) {
      expect(m[0]).not.toMatch(/\bpgmq\b/i);
      expect(/\bto\s+([^;]*);/i.exec(m[0])?.[1]?.trim()).toBe("service_role");
    }
    expect(code).not.toMatch(/alter\s+default\s+privileges/i);
  });
});

describe("154 image_requeue_stagger: pg_cron job", () => {
  it("is one cron DO block that skips with a notice when pg_cron is not installed", () => {
    expect([...code.matchAll(/\bdo\s+\$cron\$/gi)]).toHaveLength(1);
    expect(cron).toContain("if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then");
    expect(cron).toContain("raise notice '154: pg_cron missing, skipping the image-backfill-requeue schedule.'; return; end if;");
  });

  it("unschedules an existing job of the same name (guarded on cron.job), then schedules it four times an hour", () => {
    expect(cron).toContain(
      "if exists (select 1 from cron.job where jobname = 'image-backfill-requeue') then perform cron.unschedule('image-backfill-requeue'); end if;",
    );
    expect(cron).toContain(`perform cron.schedule('image-backfill-requeue', '${SCHEDULE}',`);
    expect(cron).toContain("$sql$ set statement_timeout = '60s'; select public.image_backfill_requeue(40); $sql$);");
    expect(cron.indexOf("pg_cron missing")).toBeLessThan(cron.indexOf("cron.unschedule"));
    expect(cron.indexOf("cron.unschedule")).toBeLessThan(cron.indexOf("cron.schedule"));
  });

  it("names only image-backfill-requeue in every cron call and lookup (image-drain, ingest-drain and the rest stay untouched)", () => {
    const calls = [...code.matchAll(/\bcron\.(schedule|unschedule|alter_job|schedule_in_database)\s*\(\s*'([^']+)'/gi)];
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c[2]).toBe("image-backfill-requeue");
    const names = [...code.matchAll(/\bjobname\s*(?:=|in)\s*\(?\s*'([^']+)'/gi)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const nm of names) expect(nm).toBe("image-backfill-requeue");
    expect(code).not.toMatch(/image-drain|ingest-drain|cluster-drain/);
    expect(code).not.toMatch(/\bupdate\s+cron\./i);
    expect(code).not.toMatch(/\bdelete\s+from\s+cron\./i);
    expect(code).not.toMatch(/\bcron\.job_run_details\b/i);
  });

  it("schedules 4 bursts of 40: 160 messages an hour of capacity, at least the 150 an hour of 142", () => {
    expect(SCHEDULE_MINUTES).toEqual([2, 17, 32, 47]);
    expect(SCHEDULED_N).toBe(40);
    expect(SCHEDULE_MINUTES.length * SCHEDULED_N).toBeGreaterThanOrEqual(150);
    // inside the function's clamp, and no larger than the consumer drains in one 5 minute tick
    expect(SCHEDULED_N).toBeGreaterThanOrEqual(1);
    expect(SCHEDULED_N).toBeLessThanOrEqual(1000);
  });

  it("keeps the largest delay (39 * 20 = 780 s) far below both the 900 s cap and the 1800 s /api/health bound", () => {
    const maxDelay = (SCHEDULED_N - 1) * STAGGER;
    expect(maxDelay).toBe(780);
    expect(maxDelay).toBeLessThanOrEqual(DELAY_CAP);
    expect(maxDelay).toBeLessThan(1800);
  });

  it("stays on the minutes of 15 minute spacing and off the image-drain ticks (minutes divisible by 5)", () => {
    for (const minute of SCHEDULE_MINUTES) expect(minute % 5).not.toBe(0);
    const gaps = SCHEDULE_MINUTES.map((m, i) => ((SCHEDULE_MINUTES[(i + 1) % SCHEDULE_MINUTES.length] ?? 0) - m + 60) % 60);
    expect(gaps).toEqual([15, 15, 15, 15]);
  });
});

describe("154 image_requeue_stagger: ops_cron_expected note", () => {
  const ops = norm(/do \$ops\$([\s\S]*?)\$ops\$;/i.exec(code)?.[1] ?? "");

  it("updates only the note of the image-backfill-requeue row, only when it differs, and only if the table exists", () => {
    expect(ops).toContain("if pg_catalog.to_regclass('public.ops_cron_expected') is not null then");
    expect(ops).toContain(
      `update public.ops_cron_expected set note = '${SCHEDULE}' where jobname = 'image-backfill-requeue' and note is distinct from '${SCHEDULE}';`,
    );
    expect([...code.matchAll(/\bupdate\s+/gi)]).toHaveLength(1);
  });

  it("leaves max_gap (3 hours) alone: it is never mentioned in executable text", () => {
    expect(code).not.toMatch(/max_gap/i);
    expect(code).not.toMatch(/\binsert\s+into\s+public\.ops_cron_expected\b/i);
    expect(code).not.toMatch(/\bdelete\b/i);
  });

  it("the note equals the cron schedule (the seed rule of 150: the note is the schedule)", () => {
    const sched = /perform cron\.schedule\('image-backfill-requeue', '([^']+)'/.exec(cron)?.[1];
    expect(sched).toBe(SCHEDULE);
    expect(ops).toContain(`set note = '${sched}'`);
  });
});

describe("154 image_requeue_stagger: additive shape", () => {
  it("creates no table, index, trigger, view, extension or policy, alters and drops nothing, truncates nothing", () => {
    expect(code).not.toMatch(/\bcreate\s+(unique\s+)?index\b/i);
    expect(code).not.toMatch(/\bconcurrently\b/i);
    expect(code).not.toMatch(/\bcreate\s+(table|trigger|view|materialized|extension|policy|sequence)\b/i);
    expect(code).not.toMatch(/\balter\b/i);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
  });

  it("writes no row of public.articles and inserts nothing but the ledger row", () => {
    const inserts = [...code.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
    expect(body).not.toMatch(/\b(insert|update|delete)\b/i);
  });

  it("touches no table other than public.articles (read) and the pgmq queue table (read) inside the function", () => {
    const tables = [...body.matchAll(/\b(?:from|join)\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(tables.sort()).toEqual(["pgmq.q_image_backfill", "public.articles"]);
  });
});

describe("154 image_requeue_stagger: header documents the evidence, the design change and the way back", () => {
  it.each([["WHY"], ["WHAT"], ["STEP 0"], ["SIMULATION"], ["DRY RUNS"], ["DEPLOY"], ["VERIFY"], ["ROLLBACK"]])(
    "has a %s section",
    (label) => {
      expect(hasSection(label), `header section ${label}`).toBe(true);
    },
  );

  it("records the production read: the body md5 of 142, the cron row, the counts under attempts 1..2 and 1..4", () => {
    expect(header).toContain("917624baf55f5021fe458e8f0664b6d1");
    expect(header).toContain("17 * * * *");
    expect(header).toContain("image_backfill_requeue(150)");
    expect(header).toContain("4,253");
    expect(header).toContain("4,493");
  });

  it("explains why the brief's hourly 150 with a 20 s stagger was not used (2,980 s invisible, pgmq.metrics, 1800 s)", () => {
    expect(header).toContain("2,980");
    expect(header).toContain("oldest_msg_age_sec");
    expect(header).toContain("1800");
    expect(header).toContain("780");
    expect(header).toContain("queue_lag");
  });

  it("records both local dry runs", () => {
    expect(header).toContain("pg-bh-w3-a");
    expect(header).toContain("pg-bh-w3-b");
    expect(header).toContain("INSERT 0 1");
    expect(header).toContain("INSERT 0 0");
    expect(header).toContain("DRYRUN 154 OK");
  });

  it("gives the exact rollback statements (back to 142's cadence and body)", () => {
    expect(header).toContain("delete from supabase_migrations.schema_migrations where version = '154';");
    expect(header).toContain("142_image_backfill_retry.sql");
    expect(header).toContain("'17 * * * *'");
  });

  it("is additive and says so", () => {
    expect(header).toMatch(/Additive/);
    expect(header).toMatch(/Safe to re-apply/);
  });
});

describe("154 image_requeue_stagger: docs", () => {
  const guide = readFileSync(GUIDE, "utf8");
  const heartbeat = readFileSync(HEARTBEAT, "utf8");

  it("docs/migration-guide.md has a 153 section and a 154 section, in apply order 153 then 154", () => {
    const i153 = guide.indexOf("\n## 153 ");
    const i154 = guide.indexOf("\n## 154 ");
    expect(i153).toBeGreaterThan(-1);
    expect(i154).toBeGreaterThan(i153);
    const section154 = guide.slice(i154);
    expect(section154).toContain("2,17,32,47 * * * *");
    expect(section154).toContain("image_backfill_requeue(40)");
    expect(section154).toContain("delete from supabase_migrations.schema_migrations where version = '154';");
    expect(guide.slice(i153, i154)).toContain("delete from supabase_migrations.schema_migrations where version = '153';");
  });

  it("docs/ops-heartbeat.md no longer calls the requeue hourly", () => {
    expect(heartbeat).toContain("four times an hour, 40 messages staggered 20 s");
    expect(heartbeat).not.toContain("the hourly `image-backfill-requeue`");
  });
});

// ---------------------------------------------------------------------------
// FIFO simulation. Pure TypeScript, 1 second steps, 3 hours.
//
//   * fresh articles enqueue one message every 45 s (about the measured 79 an hour); it
//     is visible immediately;
//   * the image-drain consumer runs every 300 s and takes at most 40 VISIBLE messages in
//     msg_id order (pgmq.read orders by msg_id);
//   * a requeue burst sends `size` messages with visibility delay delayOf(i) for the i-th
//     message (pgmq.send(.., delay) sets vt = now() + delay, enqueued_at = now());
//   * fresh wait = consume time - enqueue time;
//   * "metrics age" = now - min(enqueued_at) over ALL queued messages, invisible ones
//     included: this is pgmq.metrics' oldest_msg_age_sec, which /api/health compares with
//     1800 s;
//   * "visible age" = now - min(enqueued_at) over the VISIBLE messages: 150's queue_lag.
// The NEW design is built from the constants parsed out of the migration above (cron
// minutes, N, stagger, cap), so the simulation cannot drift from the file.
// ---------------------------------------------------------------------------

interface SimMessage {
  id: number;
  enq: number;
  vt: number;
  fresh: boolean;
}

interface SimPlan {
  /** Seconds past the hour at which the requeue runs. */
  burstOffsets: readonly number[];
  size: number;
  delayOf: (i: number) => number;
}

interface SimResult {
  freshWaits: number[];
  /** Fresh messages enqueued in the 600 s after each :17 burst. */
  freshWaitsAfter17: number[];
  maxMetricsAge: number;
  maxVisibleAge: number;
  maxQueueLength: number;
  unconsumedBursts: number;
}

const FRESH_EVERY_S = 45;
const TICK_EVERY_S = 300;
const BATCH = 40;
const HORIZON_S = 3 * 3600;
const BUCKET_START_S = 17 * 60;
const BUCKET_LEN_S = 600;

function simulate(plan: SimPlan): SimResult {
  let nextId = 1;
  let queue: SimMessage[] = [];
  const fresh: { enq: number; wait: number }[] = [];
  let maxMetricsAge = 0;
  let maxVisibleAge = 0;
  let maxQueueLength = 0;
  for (let t = 1; t <= HORIZON_S; t++) {
    if (t % FRESH_EVERY_S === 0) queue.push({ id: nextId++, enq: t, vt: t, fresh: true });
    if (plan.burstOffsets.includes(t % 3600)) {
      for (let i = 0; i < plan.size; i++) {
        queue.push({ id: nextId++, enq: t, vt: t + plan.delayOf(i), fresh: false });
      }
    }
    if (t % TICK_EVERY_S === 0) {
      const taken = new Set<number>();
      for (const m of queue) {
        if (taken.size >= BATCH) break;
        if (m.vt <= t) taken.add(m.id);
      }
      for (const m of queue) {
        if (taken.has(m.id) && m.fresh) fresh.push({ enq: m.enq, wait: t - m.enq });
      }
      queue = queue.filter((m) => !taken.has(m.id));
    }
    maxQueueLength = Math.max(maxQueueLength, queue.length);
    if (queue.length > 0) {
      maxMetricsAge = Math.max(maxMetricsAge, t - Math.min(...queue.map((m) => m.enq)));
      const visible = queue.filter((m) => m.vt <= t);
      if (visible.length > 0) maxVisibleAge = Math.max(maxVisibleAge, t - Math.min(...visible.map((m) => m.enq)));
    }
  }
  const inBucket = (enq: number): boolean => {
    const into = enq % 3600;
    return into >= BUCKET_START_S && into < BUCKET_START_S + BUCKET_LEN_S;
  };
  return {
    freshWaits: fresh.map((f) => f.wait),
    freshWaitsAfter17: fresh.filter((f) => inBucket(f.enq)).map((f) => f.wait),
    maxMetricsAge,
    maxVisibleAge,
    maxQueueLength,
    unconsumedBursts: queue.filter((m) => !m.fresh).length,
  };
}

/** Nearest-rank percentile. */
function percentile(values: number[], p: number): number {
  expect(values.length).toBeGreaterThan(0);
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? Number.NaN;
}

const OLD: SimPlan = { burstOffsets: [17 * 60], size: 150, delayOf: () => 0 };
const NEW: SimPlan = {
  burstOffsets: SCHEDULE_MINUTES.map((m) => m * 60),
  size: SCHEDULED_N,
  delayOf: (i) => Math.min(i * STAGGER, DELAY_CAP),
};
// the brief's literal design: hourly 150 with delay i * 20 and no cadence change
const BRIEF_LITERAL: SimPlan = { burstOffsets: [17 * 60], size: 150, delayOf: (i) => i * STAGGER };

describe("154 image_requeue_stagger: FIFO simulation (40 per 5 minute tick, a fresh message every 45 s)", () => {
  const oldRun = simulate(OLD);
  const newRun = simulate(NEW);
  const briefRun = simulate(BRIEF_LITERAL);

  it("the simulation is anchored on the migration: NEW bursts at minutes 2, 17, 32, 47 with 40 messages, 20 s apart", () => {
    expect(NEW.burstOffsets).toEqual([120, 1020, 1920, 2820]);
    expect(NEW.size).toBe(40);
    expect(NEW.delayOf(0)).toBe(0);
    expect(NEW.delayOf(1)).toBe(20);
    expect(NEW.delayOf(39)).toBe(780);
    expect(NEW.delayOf(100)).toBe(900);
  });

  it("OLD (hourly 150, no delay): fresh messages after the :17 burst wait p95 > 900 s (production measured 1026 s)", () => {
    expect(oldRun.freshWaitsAfter17.length).toBeGreaterThanOrEqual(30);
    expect(percentile(oldRun.freshWaitsAfter17, 0.95)).toBeGreaterThan(900);
  });

  it("OLD never trips the 1800 s bounds, which is why nothing paged (production: thresholds not breached)", () => {
    expect(oldRun.maxMetricsAge).toBeLessThan(1800);
    expect(oldRun.maxVisibleAge).toBeLessThan(1800);
  });

  it("NEW (4 x 40, delay i * 20): fresh p95 after each :17 burst is under 330 s", () => {
    expect(newRun.freshWaitsAfter17.length).toBeGreaterThanOrEqual(30);
    expect(percentile(newRun.freshWaitsAfter17, 0.95)).toBeLessThan(330);
  });

  it("NEW: fresh p95 over the whole run is under 330 s too, and no fresh message waits a second full tick", () => {
    expect(percentile(newRun.freshWaits, 0.95)).toBeLessThan(330);
    expect(Math.max(...newRun.freshWaits)).toBeLessThanOrEqual(TICK_EVERY_S);
  });

  it("NEW: the pgmq.metrics age (invisible messages included) stays under 1800 s, the visible age too", () => {
    expect(newRun.maxMetricsAge).toBeLessThan(1800);
    expect(newRun.maxVisibleAge).toBeLessThan(1800);
  });

  it("NEW: the queue drains completely and never holds more than one burst plus the fresh arrivals", () => {
    expect(newRun.unconsumedBursts).toBeLessThanOrEqual(NEW.size);
    expect(newRun.maxQueueLength).toBeLessThanOrEqual(NEW.size + Math.ceil(TICK_EVERY_S / FRESH_EVERY_S) + 1);
  });

  it("NEW improves on OLD in every measured dimension", () => {
    expect(percentile(newRun.freshWaitsAfter17, 0.95)).toBeLessThan(percentile(oldRun.freshWaitsAfter17, 0.95) / 2);
    expect(newRun.maxQueueLength).toBeLessThan(oldRun.maxQueueLength);
  });

  it("BRIEF-LITERAL (hourly 150, delay i * 20): the pgmq.metrics age passes 1800 s, which is why the cadence changed", () => {
    expect(briefRun.maxMetricsAge).toBeGreaterThan(1800);
    // 149 * 20 = 2,980 s of delay plus up to one 300 s tick before the last message is consumed
    expect(briefRun.maxMetricsAge).toBeGreaterThan(2980);
    // the visible-only age of 150's queue_lag row passes 1800 s as well (it ages from enqueued_at)
    expect(briefRun.maxVisibleAge).toBeGreaterThan(1800);
  });

  it("percentile helper: nearest rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 0.95)).toBe(19);
  });
});

describe("154 image_requeue_stagger: dry-run script", () => {
  const dry = readFileSync(DRYRUN, "utf8");

  it("applies 142 first (production's state), then 154 twice, and ends with the pass marker", () => {
    expect([...dry.matchAll(/^\\ir [^\n]*142_image_backfill_retry\.sql/gm)]).toHaveLength(1);
    // apply 1, apply 2, then the drift, delete and operator-tuned repairs of the cron and ops scenarios
    expect([...dry.matchAll(/^\\ir [^\n]*154_image_requeue_stagger\.sql/gm)].length).toBeGreaterThanOrEqual(2);
    expect(dry).toContain("917624baf55f5021fe458e8f0664b6d1");
    expect(dry).toContain("DRYRUN 154 OK");
  });

  it("never touches production (no connection string, no key)", () => {
    expect(dry).not.toMatch(/supabase\.co|postgres:\/\/|eyJ[A-Za-z0-9_-]{20,}/);
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/
// PGDATABASE point at the THROWAWAY database the dry-run script leaves behind
// (tests/migrations/sql/stub.sql, the pgmq stub and fixtures of the dry-run script, 142 and
// 154 applied). Every check that writes runs inside a transaction that is rolled
// back. Never point this at production.
// ---------------------------------------------------------------------------
describe.runIf(Boolean(process.env.TAYF_PSQL))("154 against a live Postgres (154 applied)", () => {
  assertLiveReady("154", { ledger: ["142", "154"], functions: ["public.image_backfill_requeue(integer)"] });

  const psqlArgs = ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"];
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, psqlArgs, {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  function runPsqlError(input: string): string {
    try {
      execFileSync(process.env.TAYF_PSQL as string, psqlArgs, {
        input,
        encoding: "utf8",
        env: { ...process.env, PGCLIENTENCODING: "UTF8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return String((e as { stderr?: string }).stderr ?? e);
    }
    throw new Error("expected psql to fail");
  }

  /** Inserts one image-less article; created_at is `age` before the transaction start. */
  const article = (id: string, attempts: number, age: string): string =>
    `insert into public.articles (id, title, image_url, image_backfill_attempts, image_backfill_attempted_at, created_at)
       values ('${id}', 'live ${id}', null, ${attempts}, now() - interval '3 hours', now() - interval '${age}');`;
  const ID = (k: number): string => `a1540000-0000-0000-0000-${String(900000 + k).padStart(12, "0")}`;
  /**
   * Inside the (rolled back) transaction: empties the queue and takes every existing article out of the
   * candidate set (attempts 0), so the scenario sees only its own messages and its own articles.
   */
  const isolate = "delete from pgmq.q_image_backfill; update public.articles set image_backfill_attempts = 0;";

  it("the ledger row, the function and its attributes", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '154';").trim()).toBe("1");
    expect(
      runPsql(`select prosecdef, provolatile, proconfig[1], pg_get_userbyid(proowner)
                 from pg_proc where oid = '${FN_SIG}'::regprocedure;`).trim(),
    ).toBe('t|v|search_path=""|postgres');
    expect(runPsql(`select pg_get_function_identity_arguments('${FN_SIG}'::regprocedure), pg_get_function_result('${FN_SIG}'::regprocedure);`).trim()).toBe(
      "p_limit integer|integer",
    );
    expect(runPsql(`select position('least(v_sent * 20, 900)' in prosrc) > 0, position('between 1 and 2' in prosrc) > 0, position('between 1 and 4' in prosrc) = 0
                      from pg_proc where oid = '${FN_SIG}'::regprocedure;`).trim()).toBe("t|t|t");
  });

  it("only service_role can execute it", () => {
    expect(
      runPsql(`select has_function_privilege('anon', '${FN_SIG}', 'execute'), has_function_privilege('authenticated', '${FN_SIG}', 'execute'),
                      has_function_privilege('service_role', '${FN_SIG}', 'execute');`).trim(),
    ).toBe("f|f|t");
    for (const role of ["anon", "authenticated"]) {
      expect(runPsqlError(`begin; set local role ${role}; select ${FN}(1); rollback;`)).toMatch(/permission denied for function image_backfill_requeue/);
    }
  });

  it("requeue(3) sends 3 messages with vt about 0, 20 and 40 s ahead, newest article first", () => {
    const out = runPsql(`begin;
      ${isolate}
      ${article(ID(1), 1, "3 days")}
      ${article(ID(2), 2, "2 days")}
      ${article(ID(3), 1, "1 day")}
      select ${FN}(3);
      select q.message ->> 'article_id' || '|' || round(extract(epoch from (q.vt - now())))::int
        from pgmq.q_image_backfill q order by q.msg_id;
      rollback;`);
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("3");
    const sent = lines.slice(1).map((l) => {
      const [id, delay] = l.split("|");
      return { id, delay: Number(delay) };
    });
    expect(sent.map((s) => s.id)).toEqual([ID(3), ID(2), ID(1)]);
    const expected = [0, 20, 40];
    sent.forEach((s, i) => expect(Math.abs(s.delay - (expected[i] ?? Number.NaN))).toBeLessThanOrEqual(2));
  });

  it("selects attempts 1 and 2 only: articles at 0, 3, 4 and 5 attempts are not sent", () => {
    const out = runPsql(`begin;
      ${isolate}
      ${article(ID(11), 0, "1 day")}
      ${article(ID(12), 1, "1 day")}
      ${article(ID(13), 2, "1 day")}
      ${article(ID(14), 3, "1 day")}
      ${article(ID(15), 4, "1 day")}
      ${article(ID(16), 5, "1 day")}
      select ${FN}(100);
      select coalesce(string_agg(q.message ->> 'article_id', ',' order by q.msg_id), '') from pgmq.q_image_backfill q;
      rollback;`);
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("2");
    expect(new Set((lines[1] ?? "").split(","))).toEqual(new Set([ID(12), ID(13)]));
  });

  it("caps the delay at 900 s however large the batch is", () => {
    const out = runPsql(`begin;
      ${isolate}
      insert into public.articles (id, title, image_url, image_backfill_attempts, image_backfill_attempted_at, created_at)
        select ('a1540000-0000-0000-0000-' || lpad((800000 + g)::text, 12, '0'))::uuid, 'bulk ' || g, null, 1,
               now() - interval '3 hours', now() - interval '1 day' - g * interval '1 minute'
          from generate_series(1, 60) g;
      select ${FN}(60);
      select min(round(extract(epoch from (q.vt - now())))::int), max(round(extract(epoch from (q.vt - now())))::int),
             count(*) filter (where round(extract(epoch from (q.vt - now()))) > 902)
        from pgmq.q_image_backfill q;
      rollback;`);
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("60");
    const [min = Number.NaN, max = Number.NaN, over = Number.NaN] = (lines[1] ?? "").split("|").map(Number);
    expect(Math.abs(min - 0)).toBeLessThanOrEqual(2);
    expect(Math.abs(max - 900)).toBeLessThanOrEqual(2);
    expect(over).toBe(0);
  });

  it("skips an article already queued (the NULL-safe guard) and writes no article row", () => {
    const out = runPsql(`begin;
      ${isolate}
      ${article(ID(21), 1, "1 day")}
      ${article(ID(22), 1, "2 days")}
      select md5(string_agg(a::text, '|' order by a.id)) from public.articles a;
      select pgmq.send('image_backfill', jsonb_build_object('article_id', '${ID(21)}'));
      select pgmq.send('image_backfill', jsonb_build_object('other', 1));
      select ${FN}(10);
      select md5(string_agg(a::text, '|' order by a.id)) from public.articles a;
      rollback;`);
    const lines = out.trim().split("\n");
    // lines: md5 before, two msg_ids from the manual sends, the count requeue returned, md5 after
    expect(lines[3]).toBe("1");
    expect(lines[4]).toBe(lines[0]);
  });

  it("the cron job is the 154 schedule, and the other jobs are unchanged (needs a pg_cron or the dry-run fake)", () => {
    const has = runPsql("select to_regclass('cron.job') is not null;").trim();
    if (has !== "t") return;
    expect(
      runPsql(`select schedule || '|' || command from cron.job where jobname = 'image-backfill-requeue';`).trim(),
    ).toBe(`${SCHEDULE}| set statement_timeout = '60s'; select public.image_backfill_requeue(40);`);
    expect(runPsql("select count(*) from cron.job where jobname = 'image-backfill-requeue';").trim()).toBe("1");
    expect(runPsql("select count(*) from cron.job where schedule = '17 * * * *' and jobname = 'image-backfill-requeue';").trim()).toBe("0");
  });

  it("the ops_cron_expected note follows the schedule and max_gap stays 3 hours (when the table exists)", () => {
    const has = runPsql("select to_regclass('public.ops_cron_expected') is not null;").trim();
    if (has !== "t") return;
    expect(
      runPsql("select note || '|' || max_gap::text from public.ops_cron_expected where jobname = 'image-backfill-requeue';").trim(),
    ).toBe(`${SCHEDULE}|03:00:00`);
  });
});
