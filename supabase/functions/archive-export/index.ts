// supabase/functions/archive-export/index.ts
//
// Tayf Arşiv nightly export (M-10). Poked by pg_cron `archive-export` at
// 03:40 UTC (migration 060) with an empty body = "the previous UTC day";
// backfill one day at a time with POST {"day":"YYYY-MM-DD"}. Writes
// clusters.jsonl + articles.jsonl + manifest.json under YYYY/MM/DD/ in the
// PRIVATE `tayf-archive` bucket and one archive_exports ledger row.
// Idempotent per day. The algorithm lives in _shared/archive.ts; this file
// only binds it to the service-role client and the HTTP envelope.

import { requireServiceRoleBearer } from "../_shared/auth.ts";
import { captureException, initSentry, withSentry } from "../_shared/sentry.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import {
  ARCHIVE_BUCKET,
  ARCHIVE_DEADLINE_MS,
  ARCHIVE_PAGE_SIZE,
  type ArchiveCluster,
  ArchiveDeadlineError,
  type ArchivePorts,
  isValidDay,
  previousUtcDay,
  type RawArticleRow,
  runArchiveExport,
} from "../_shared/archive.ts";

await initSentry("archive-export");

const CLUSTER_COLUMNS =
  "id, title_tr, title_tr_neutral, title_neutral_model, article_count, is_blindspot, blindspot_side, is_archived, bias_distribution, first_published";
// Membership lives in the cluster_articles join table (articles has no
// cluster_id column); the embed flattens to RawArticleRow in fetchArticles.
const MEMBER_COLUMNS =
  "cluster_id, article_id, article:articles ( id, title, url, published_at, source:sources ( slug, bias ) )";

interface MemberRow {
  cluster_id: string;
  article_id: string;
  article:
    | { id: string; title: string; url: string; published_at: string; source: RawArticleRow["source"] }
    | { id: string; title: string; url: string; published_at: string; source: RawArticleRow["source"] }[]
    | null;
}

interface Body {
  day?: unknown;
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

Deno.serve(withSentry("archive-export", async (req: Request) => {
  const denied = requireServiceRoleBearer(req);
  if (denied) return denied;

  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, ready: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  let body: Body = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as Body;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "bad-json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let day: string;
  if (body.day === undefined) {
    day = previousUtcDay(new Date());
  } else if (isValidDay(body.day)) {
    day = body.day;
  } else {
    return new Response(JSON.stringify({ ok: false, error: "bad-day" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const result = await runArchiveExport(makePorts(), day, { deadlineMs: ARCHIVE_DEADLINE_MS });
    console.log(`[archive-export] ${day}`, JSON.stringify(result));
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const request_id = crypto.randomUUID();
    captureException("archive-export", err);
    console.error(`[archive-export] ${request_id} day=${day}`, err);
    const status = err instanceof ArchiveDeadlineError ? 504 : 500;
    return new Response(JSON.stringify({ ok: false, error: err instanceof ArchiveDeadlineError ? "deadline" : "internal-error", request_id, day }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}));
