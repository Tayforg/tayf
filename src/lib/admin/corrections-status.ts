import { createServerClient } from "@/lib/supabase/server";

// /admin "Düzeltme bildirimleri" reader — shared by the attention strip
// (attention.ts) and the section body (corrections-list.tsx) so both render
// from one read.
//
// It used to take the newest 50 rows regardless of status, so the 51st-oldest
// OPEN report was invisible and the "Açık düzeltme" tile capped at 50. It now
// PAGES the open rows, oldest first (so no report starves behind newer ones),
// with the exact open total from a `count: "exact"` select, and keeps a small
// separate window of recently closed rows for reference.
//
// Mirrors src/lib/admin/archive-status.ts's rationale: /admin is
// cookie-gated and dynamic, so this is a plain async fetcher, NOT
// "use cache". Never throws: a Supabase hiccup renders as a status
// sentence, never a 500. `null` means "could not read".

/** Page size of the OPEN list. */
export const CORRECTIONS_LIMIT = 50;
/** Statuses that still need a decision. `new` is the legacy spelling of `open` (033 → 042 rebase). */
export const OPEN_CORRECTION_STATUSES = ["open", "new"] as const;
/** How many recently closed rows the section offers behind its <details>. */
export const CORRECTIONS_CLOSED_LIMIT = 20;
/** Upper bound for the `?duzeltme=` page parameter (anything above is clamped). */
export const CORRECTIONS_MAX_PAGE = 1000;

const CORRECTION_COLUMNS = "id, status, created_at, reviewed_at, url, message, email";

/** PostgREST: the requested range starts past the last row. */
const RANGE_NOT_SATISFIABLE = "PGRST103";

export interface CorrectionRow {
  id: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  url: string;
  message: string;
  email: string | null;
}

export interface CorrectionsPage {
  /** This page of OPEN rows, oldest first. */
  open: CorrectionRow[];
  /** Exact number of open rows across all pages. */
  openTotal: number;
  /** The page actually served (1-based); may differ from the one requested. */
  page: number;
  /** Always >= 1. */
  pageCount: number;
  /** Up to CORRECTIONS_CLOSED_LIMIT most recently created closed rows, newest first. */
  closed: CorrectionRow[];
}

/**
 * `?duzeltme=` -> a page number. Anything that is not a plain positive integer
 * string (missing, repeated, negative, zero, decimal, exponent, junk) is page 1;
 * above CORRECTIONS_MAX_PAGE it is clamped. Never throws.
 */
export function parseCorrectionsPage(raw: string | string[] | undefined): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, CORRECTIONS_MAX_PAGE);
}

type ReadResult =
  | { kind: "ok"; value: CorrectionsPage }
  | { kind: "out-of-range" }
  | { kind: "error" };

async function readPage(page: number): Promise<ReadResult> {
  const supabase = createServerClient();
  const from = (page - 1) * CORRECTIONS_LIMIT;
  const to = from + CORRECTIONS_LIMIT - 1;

  const [openRes, closedRes] = await Promise.all([
    supabase
      .from("corrections")
      .select(CORRECTION_COLUMNS, { count: "exact" })
      .in("status", [...OPEN_CORRECTION_STATUSES])
      // Oldest first, id as a tiebreaker so a page boundary is stable.
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
    supabase
      .from("corrections")
      .select(CORRECTION_COLUMNS)
      .not("status", "in", `(${OPEN_CORRECTION_STATUSES.join(",")})`)
      .order("created_at", { ascending: false })
      .limit(CORRECTIONS_CLOSED_LIMIT),
  ]);

  if (openRes.error) {
    if (openRes.error.code === RANGE_NOT_SATISFIABLE) return { kind: "out-of-range" };
    // Messages only: never log a row or an email (corrections carry
    // reader-submitted contact info).
    console.error(`[admin] corrections unavailable: ${openRes.error.message}`);
    return { kind: "error" };
  }
  if (closedRes.error) {
    console.error(`[admin] corrections unavailable: ${closedRes.error.message}`);
    return { kind: "error" };
  }

  const open = (openRes.data as CorrectionRow[] | null) ?? [];
  // Some PostgREST versions answer a page past the end with 200 and an empty
  // body instead of PGRST103; both mean "go back to page 1".
  if (open.length === 0 && page > 1) return { kind: "out-of-range" };

  const openTotal = openRes.count;
  if (typeof openTotal !== "number") {
    console.error("[admin] corrections unavailable: missing exact count");
    return { kind: "error" };
  }

  return {
    kind: "ok",
    value: {
      open,
      openTotal,
      page,
      pageCount: Math.max(1, Math.ceil(openTotal / CORRECTIONS_LIMIT)),
      closed: (closedRes.data as CorrectionRow[] | null) ?? [],
    },
  };
}

/**
 * One page of open corrections (oldest first) plus the recently closed ones.
 * A page past the end (a stale `?duzeltme=` after the queue shrank) retries
 * ONCE as page 1 and reports page 1. Never throws; `null` = could not read.
 */
export async function getCorrectionsPage(page: number): Promise<CorrectionsPage | null> {
  const requested =
    Number.isInteger(page) && page >= 1 ? Math.min(page, CORRECTIONS_MAX_PAGE) : 1;

  try {
    let result = await readPage(requested);
    if (result.kind === "out-of-range" && requested > 1) {
      result = await readPage(1);
    }
    return result.kind === "ok" ? result.value : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] corrections unavailable: ${message}`);
    return null;
  }
}
