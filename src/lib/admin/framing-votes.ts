import { createServerClient } from "@/lib/supabase/server";

// T11 follow-through (migration 068) — the /admin "Çerçeve oyları" section's
// reader. Modelled on src/lib/admin/archive-status.ts: /admin is
// cookie-gated and dynamic, so this is a plain async fetcher, never
// "use cache". Never throws: a missing migration or a Supabase hiccup
// renders as a status sentence, not a 500. `null` means "could not read at
// all" (the candidate RPC itself failed); `totalVotes: null` inside a
// non-null status means only the head count failed while the candidate
// list is still usable — the section renders a different sentence for
// each.

export interface FramingGoldCandidate {
  article_id: string;
  title: string;
  vote: string;
  n: number;
  share: number;
}

export interface FramingVoteAdminStatus {
  totalVotes: number | null;
  candidates: FramingGoldCandidate[];
}

export const FRAMING_GOLD_MIN_VOTES = 5;
export const FRAMING_GOLD_MIN_SHARE = 0.8;
export const FRAMING_GOLD_LIMIT = 20;

// Raw RPC row shape — every field optional/nullable, since a malformed or
// partial row must never throw (see module doc comment: "Never throws").
interface RawFramingGoldCandidate {
  article_id?: string | null;
  title?: string | null;
  vote?: string | null;
  n?: unknown;
  share?: unknown;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapCandidate(row: RawFramingGoldCandidate): FramingGoldCandidate {
  return {
    article_id: typeof row.article_id === "string" ? row.article_id : "",
    title: typeof row.title === "string" ? row.title : "",
    vote: typeof row.vote === "string" ? row.vote : "",
    n: toCount(row.n),
    share: toCount(row.share),
  };
}

export async function getFramingVoteStatus(): Promise<FramingVoteAdminStatus | null> {
  try {
    const supabase = createServerClient();

    // Per R0.2: rpc() resolves to a plain {data, error} envelope, not a
    // chainable builder — no filters chained here.
    const { data, error } = await supabase.rpc("framing_gold_candidates", {
      p_min_votes: FRAMING_GOLD_MIN_VOTES,
      p_min_share: FRAMING_GOLD_MIN_SHARE,
    });

    if (error) {
      console.error(
        `[admin] framing vote status unavailable: ${error.message}`,
      );
      return null;
    }

    const rows = Array.isArray(data) ? data : data ? [data] : [];
    const candidates = (rows as RawFramingGoldCandidate[])
      .map(mapCandidate)
      .slice(0, FRAMING_GOLD_LIMIT);

    const { count, error: countError } = await supabase
      .from("framing_votes")
      .select("id", { count: "exact", head: true });

    if (countError) {
      console.error(
        `[admin] framing vote total unavailable: ${countError.message}`,
      );
      return { totalVotes: null, candidates };
    }

    return { totalVotes: count ?? null, candidates };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] framing vote status unavailable: ${message}`);
    return null;
  }
}

export function formatGoldShare(share: number): string {
  return `%${Math.round(share * 100)}`;
}
