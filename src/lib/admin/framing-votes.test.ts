import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// T11 follow-through (migration 068) — the /admin "Çerçeve oyları" section's
// reader. Mirrors src/lib/admin/archive-status.test.ts for the shared
// chainable Supabase fake: framing_gold_candidates is an RPC (per R0.2,
// rpc() resolves to a plain {data, error} envelope — no chained filters),
// and the total-votes line is a `count: "exact", head: true` read of
// framing_votes.

const fixture = vi.hoisted(() => ({
  candidates: [] as unknown[],
  rpcError: null as { message: string } | null,
  rpcArgs: [] as unknown[],
  totalVotes: 0,
  countError: null as { message: string } | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      framing_votes: () => {
        if (fixture.countError) return { data: null, error: fixture.countError };
        return { data: null, error: null, count: fixture.totalVotes };
      },
    },
    rpc: {
      framing_gold_candidates: (args) => {
        fixture.rpcArgs.push(args);
        if (fixture.rpcError) return { data: null, error: fixture.rpcError };
        return { data: fixture.candidates, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import {
  FRAMING_GOLD_LIMIT,
  FRAMING_GOLD_MIN_SHARE,
  FRAMING_GOLD_MIN_VOTES,
  formatGoldShare,
  getFramingVoteStatus,
  type FramingGoldCandidate,
} from "./framing-votes";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.candidates = [];
  fixture.rpcError = null;
  fixture.rpcArgs = [];
  fixture.totalVotes = 0;
  fixture.countError = null;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

function candidate(
  overrides: Partial<FramingGoldCandidate> = {},
): FramingGoldCandidate {
  return {
    article_id: "a1",
    title: "Başlık",
    vote: "iktidar",
    n: 8,
    share: 0.83,
    ...overrides,
  };
}

describe("getFramingVoteStatus", () => {
  it("calls framing_gold_candidates with p_min_votes 5 and p_min_share 0.8", async () => {
    await getFramingVoteStatus();

    expect(fixture.rpcArgs).toEqual([
      { p_min_votes: FRAMING_GOLD_MIN_VOTES, p_min_share: FRAMING_GOLD_MIN_SHARE },
    ]);
    expect(FRAMING_GOLD_MIN_VOTES).toBe(5);
    expect(FRAMING_GOLD_MIN_SHARE).toBe(0.8);
  });

  it("caps the candidate list at 20 rows", async () => {
    fixture.candidates = Array.from({ length: 30 }, (_, i) =>
      candidate({ article_id: `a${i}`, n: 30 - i }),
    );
    fixture.totalVotes = 500;

    const result = await getFramingVoteStatus();

    expect(result).not.toBeNull();
    expect(result!.candidates).toHaveLength(FRAMING_GOLD_LIMIT);
    expect(FRAMING_GOLD_LIMIT).toBe(20);
  });

  it("returns null when the RPC errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.rpcError = {
      message: 'function "framing_gold_candidates" does not exist',
    };

    await expect(getFramingVoteStatus()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("coerces a malformed candidate row instead of throwing", async () => {
    fixture.candidates = [
      { article_id: "x", title: null, vote: "iktidar", n: null, share: "0.9" },
    ];
    fixture.totalVotes = 12;

    const result = await getFramingVoteStatus();

    expect(result).not.toBeNull();
    expect(result!.candidates).toHaveLength(1);
    expect(result!.candidates[0]?.n).toBe(0);
    expect(typeof result!.candidates[0]?.title).toBe("string");
  });

  it("keeps the candidates when only the head count fails and reports totalVotes null", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.candidates = [candidate()];
    fixture.countError = { message: 'relation "framing_votes" does not exist' };

    const result = await getFramingVoteStatus();

    expect(result).not.toBeNull();
    expect(result!.totalVotes).toBeNull();
    expect(result!.candidates).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("formatGoldShare", () => {
  it("renders 0.83 as %83", () => {
    expect(formatGoldShare(0.83)).toBe("%83");
  });
});
