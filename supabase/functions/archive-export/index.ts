// supabase/functions/archive-export/index.ts
//
// Tayf Arşiv nightly export (M-10). Poked by pg_cron `archive-export` at
// 03:40 UTC (migration 060) with an empty body = "the previous UTC day";
// backfill one day at a time with POST {"day":"YYYY-MM-DD"}. Writes
// clusters.jsonl + articles.jsonl + manifest.json under YYYY/MM/DD/ in the
// PRIVATE `tayf-archive` bucket and one archive_exports ledger row.
// Idempotent per day. The algorithm lives in _shared/archive.ts; this file
// only binds it to the service-role client and the HTTP envelope.
//
// Catch-up mode (migration 131): pg_cron `archive-export-catchup` posts
// {"catchup":true} at 05:12 UTC. The function reads the exported days of the
// last ARCHIVE_CATCHUP_WINDOW_DAYS (40) days and re-exports the OLDEST missing
// one, a single day per call (deadline-safe), or answers
// {ok:true, catchup:true, day:null, reason:"no-gap"} when there is nothing to
// do. Yesterday is left to the 03:40 job. The window stays under the 45 day
// jev-shadow-prune keep window so a re-export still carries its Jev labels.
// `catchup` cannot be combined with `day`.

import { requireServiceRoleBearer } from "../_shared/auth.ts";
import { captureException, initSentry, withSentry } from "../_shared/sentry.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import {
  ARCHIVE_BUCKET,
  ARCHIVE_CATCHUP_WINDOW_DAYS,
  ARCHIVE_DEADLINE_MS,
  ARCHIVE_LABEL_TASKS,
  ARCHIVE_PAGE_SIZE,
  type ArchiveCluster,
  ArchiveDeadlineError,
  type ArchivePorts,
  labelsFromRows,
  type RawArticleRow,
  type RawLabelRow,
  resolveExportRequest,
  runArchiveCatchup,
  runArchiveExport,
} from "../_shared/archive.ts";

await initSentry("archive-export");

const CLUSTER_COLUMNS =
  "id, title_tr, title_tr_neutral, title_neutral_model, article_count, is_blindspot, blindspot_side, is_archived, bias_distribution, first_published";
// Membership lives in the cluster_articles join table (articles has no
// cluster_id column); the embed flattens to RawArticleRow in fetchArticles.
const MEMBER_COLUMNS =
  "cluster_id, article_id, article:articles ( id, title, url, published_at, source:sources ( slug, bias ) )";
// (i) `question_set:jev_answer->>question_set` is deliberate: selecting the
// whole `jev_answer` jsonb would drag `state_preview` (headline text,
// including pre-edit headlines an outlet has removed -- see migration
// 056/061) through the export process for no reason. (ii) 100 article ids x
// 5 tasks caps a chunk's result at 500 rows, comfortably under PostgREST's
// 1000 max-rows default, so no paging is needed here. (iii) the
// `.order("task").order("article_id")` pair makes the question_set
// tie-break in labelsFromRows deterministic run over run.
const LABEL_COLUMNS = "task, article_id, jev_prob, jev_choice, question_set:jev_answer->>question_set";

interface MemberRow {
  cluster_id: string;
  article_id: string;
  article:
    | { id: string; title: string; url: string; published_at: string; source: RawArticleRow["source"] }
    | { id: string; title: string; url: string; published_at: string; source: RawArticleRow["source"] }[]
    | null;
}

function makePorts(): ArchivePorts {
  const supabase = createServiceClient();
  const range = (page: number) => [page * ARCHIVE_PAGE_SIZE, page * ARCHIVE_PAGE_SIZE + ARCHIVE_PAGE_SIZE - 1] as const;
  return {
    async hasExport(day) {
      const { data, error } = await supabase.from("archive_exports").select("id").eq("day", day).maybeSingle();
      if (error) throw new Error(`archive_exports lookup failed: ${error.message}`);
      return data !== null;
    },
    async listExportedDays(fromDay) {
      // The window since `fromDay`, plus the first-ever day as the clamp
      // anchor (see ArchivePorts.listExportedDays): a hole that touches the
      // window start must not read as "the archive began later". 40 days at
      // most one row per day, so the limit is a bound, not a page.
      const { data, error } = await supabase
        .from("archive_exports")
        .select("day")
        .gte("day", fromDay)
        .order("day", { ascending: true })
        .limit(60);
      if (error) throw new Error(`archive_exports list failed: ${error.message}`);
      const days = (data ?? []).map((r) => (r as { day: string }).day);
      const { data: first, error: firstError } = await supabase
        .from("archive_exports")
        .select("day")
        .order("day", { ascending: true })
        .limit(1);
      if (firstError) throw new Error(`archive_exports first-day lookup failed: ${firstError.message}`);
      for (const r of first ?? []) days.push((r as { day: string }).day);
      return days;
    },
    async fetchClusters(start, end, page) {
      const [from, to] = range(page);
      const { data, error } = await supabase
        .from("clusters")
        .select(CLUSTER_COLUMNS)
        .gte("first_published", start)
        .lt("first_published", end)
        .order("first_published", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw new Error(`clusters page ${page} failed: ${error.message}`);
      return (data ?? []) as unknown as ArchiveCluster[];
    },
    async fetchArticles(clusterIds, page) {
      const [from, to] = range(page);
      // `cluster_articles`'s primary key is (cluster_id, article_id) and
      // article_id is not unique on its own (one article may sit in two
      // clusters of the same chunk), so both key columns are ordered —
      // a partial sort under offset paging can duplicate or drop rows
      // across a page boundary.
      const { data, error } = await supabase
        .from("cluster_articles")
        .select(MEMBER_COLUMNS)
        .in("cluster_id", clusterIds as string[])
        .order("cluster_id", { ascending: true })
        .order("article_id", { ascending: true })
        .range(from, to);
      if (error) throw new Error(`articles page ${page} failed: ${error.message}`);
      const fetched = (data ?? []).length;
      const rows: RawArticleRow[] = [];
      for (const m of (data ?? []) as unknown as MemberRow[]) {
        const a = Array.isArray(m.article) ? (m.article[0] ?? null) : m.article;
        if (!a) continue;
        rows.push({ id: a.id, cluster_id: m.cluster_id, title: a.title, url: a.url, published_at: a.published_at, source: a.source });
      }
      // `fetched` is the raw page length: paging must not stop because a
      // member row was dropped above (see ArchivePorts.fetchArticles).
      return { rows, fetched };
    },
    async fetchLabels(articleIds) {
      // Explicit bound rather than relying on PostgREST's default max-rows:
      // articleIds.length x ARCHIVE_LABEL_TASKS.length is the true row cap
      // for this query (one row per article per task).
      const labelCap = articleIds.length * ARCHIVE_LABEL_TASKS.length;
      const { data, error } = await supabase
        .from("jev_shadow_predictions")
        .select(LABEL_COLUMNS)
        .in("task", [...ARCHIVE_LABEL_TASKS])
        .in("article_id", articleIds as string[])
        .order("task", { ascending: true })
        .order("article_id", { ascending: true })
        .limit(labelCap + 1);
      if (error) throw new Error(`labels chunk failed: ${error.message}`);
      const rows = data ?? [];
      if (rows.length > labelCap) {
        console.error(`[archive-export] labels chunk hit its cap (${labelCap} rows) -- possible truncation`);
      }
      return labelsFromRows(rows as unknown as RawLabelRow[]);
    },
    async upload(path, body, contentType) {
      const { error } = await supabase.storage
        .from(ARCHIVE_BUCKET)
        .upload(path, new Blob([body], { type: contentType }), { contentType, upsert: true });
      if (error) throw new Error(`upload ${path} failed: ${error.message}`);
    },
    async recordExport(row) {
      // `day` is unique (060). The hasExport pre-check only serialises
      // sequential runs: two overlapping invocations (a pg_net-timeout cron
      // retry, or an operator backfill racing the 03:40 job) would both pass
      // it and the loser would 500 on a 23505 for work that succeeded.
      // Upsert-ignore is the idempotency 060's header already promises.
      const { error } = await supabase
        .from("archive_exports")
        .upsert(row, { onConflict: "day", ignoreDuplicates: true });
      if (error) throw new Error(`archive_exports insert failed: ${error.message}`);
    },
    now: () => Date.now(),
  };
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One error envelope for both modes: 504 on the run deadline, 500 otherwise. */
function failure(err: unknown, target: string): Response {
  const request_id = crypto.randomUUID();
  captureException("archive-export", err);
  console.error(`[archive-export] ${request_id} ${target === "catchup" ? "catchup" : `day=${target}`}`, err);
  const deadline = err instanceof ArchiveDeadlineError;
  return json(deadline ? 504 : 500, {
    ok: false,
    error: deadline ? "deadline" : "internal-error",
    request_id,
    ...(target === "catchup" ? { catchup: true } : { day: target }),
  });
}

Deno.serve(withSentry("archive-export", async (req: Request) => {
  const denied = requireServiceRoleBearer(req);
  if (denied) return denied;

  if (req.method === "GET") {
    return json(200, { ok: true, ready: true });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  let body: unknown = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: "bad-json" });
  }

  const request = resolveExportRequest(body, new Date());
  if (request.kind === "error") return json(400, { ok: false, error: request.error });

  if (request.kind === "catchup") {
    try {
      const result = await runArchiveCatchup(makePorts(), new Date(), ARCHIVE_CATCHUP_WINDOW_DAYS);
      console.log(`[archive-export] catchup ${result.day ?? "none"}`, JSON.stringify(result));
      return json(200, result);
    } catch (err) {
      return failure(err, "catchup");
    }
  }

  const day = request.day;
  try {
    const result = await runArchiveExport(makePorts(), day, { deadlineMs: ARCHIVE_DEADLINE_MS });
    console.log(`[archive-export] ${day}`, JSON.stringify(result));
    return json(200, result);
  } catch (err) {
    return failure(err, day);
  }
}));
