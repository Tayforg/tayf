import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// h208-roadmap-1: the bounded member read behind the /hafta wire count. Same
// harness as weekly-query.test.ts: the shared chainable Supabase fake, recorded
// builder state, and a mocked next/cache so the "use cache" body's
// cacheLife/cacheTag calls are observable.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  members: [] as unknown[],
  error: null as { message: string } | null,
  throws: false,
  /** Every cluster_articles request, in order. */
  states: [] as unknown[],
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      cluster_articles: (state) => {
        fixture.states.push(state);
        if (fixture.throws) throw new Error("boom");
        if (fixture.error) return { data: null, error: fixture.error };
        return { data: fixture.members, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, opts?: unknown) => {
    fixture.clientOpts.push(opts);
    return supabaseFake.client;
  },
}));

import { cacheLife, cacheTag } from "next/cache";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";
import {
  WEEKLY_WIRE_MAX_IDS,
  WEEKLY_WIRE_MAX_MEMBER_ROWS,
  getWeeklyWireSignals,
} from "./weekly-wire-query";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.members = [];
  fixture.error = null;
  fixture.throws = false;
  fixture.states = [];
  fixture.clientOpts = [];
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

function wireMembers(clusterId: string, count = 5) {
  return Array.from({ length: count }, (_, i) => ({
    cluster_id: clusterId,
    articles: {
      id: `${clusterId}-a${i}`,
      source_id: `${clusterId}-s${i}`,
      published_at: `2026-11-20T10:0${i}:00.000Z`,
      content_hash: i === count - 1 ? "other" : "same",
      description: null,
    },
  }));
}

describe("getWeeklyWireSignals: the request", () => {
  it("reads cluster_articles for the sorted, de-duplicated ids on the capped reader client, with a row limit", async () => {
    fixture.members = wireMembers("w");

    await getWeeklyWireSignals(["w", "b", "w", "a"]);

    expect(fixture.states).toHaveLength(1);
    const state = fixture.states[0] as BuilderState;
    expect(state.table).toBe("cluster_articles");
    expect(state.in).toEqual([{ col: "cluster_id", vals: ["a", "b", "w"] }]);
    expect(state.limit).toBe(WEEKLY_WIRE_MAX_MEMBER_ROWS);
    // The row limit stays inside PostgREST's own 1,000-row response cap.
    expect(WEEKLY_WIRE_MAX_MEMBER_ROWS).toBeLessThanOrEqual(1000);

    // Only what wireSignalOf needs: no title, url, image or source join.
    const select = String(state.selectArgs[0]);
    for (const col of ["cluster_id", "source_id", "published_at", "content_hash", "description"]) {
      expect(select).toContain(col);
    }
    expect(select).not.toMatch(/\burl\b|image_url|title|sources\s*\(/);

    // createReaderClient: a custom fetch (the 4 s cap), not the plain client.
    const opts = fixture.clientOpts[0] as { global?: { fetch?: unknown } } | undefined;
    expect(typeof opts?.global?.fetch).toBe("function");
  });

  it("caps the id list at the rows a page can show", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `id-${String(i).padStart(2, "0")}`);

    await getWeeklyWireSignals(ids);

    const state = fixture.states[0] as BuilderState;
    expect(state.in[0]!.vals).toHaveLength(WEEKLY_WIRE_MAX_IDS);
    expect(state.in[0]!.vals).toEqual(ids.slice(0, WEEKLY_WIRE_MAX_IDS));
  });

  it("makes no request at all for an empty or unusable id list", async () => {
    await expect(getWeeklyWireSignals([])).resolves.toEqual({});
    await expect(getWeeklyWireSignals(["", "  "])).resolves.toEqual({});
    expect(fixture.states).toHaveLength(0);
    expect(fixture.clientOpts).toHaveLength(0);
    expect(cacheLife).not.toHaveBeenCalled();
  });
});

describe("getWeeklyWireSignals: the answer", () => {
  it("answers the wire clusters only, with effective and member counts", async () => {
    fixture.members = [...wireMembers("w"), ...[1, 2, 3, 4].map((i) => ({
      cluster_id: "p",
      articles: {
        id: `p-a${i}`,
        source_id: `p-s${i}`,
        published_at: `2026-11-20T10:0${i}:00.000Z`,
        content_hash: `p-h${i}`,
        description: null,
      },
    }))];

    await expect(getWeeklyWireSignals(["w", "p"])).resolves.toEqual({
      w: { effectiveArticleCount: 2, memberCount: 5 },
    });
  });

  it("a read error fails open: null, and the log names the error only (no ids)", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    await expect(getWeeklyWireSignals(["secret-cluster-id"])).resolves.toBeNull();

    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("statement timeout");
    expect(logged).not.toContain("secret-cluster-id");
  });

  it("a throw fails open: null", async () => {
    fixture.throws = true;
    await expect(getWeeklyWireSignals(["w"])).resolves.toBeNull();
  });

  it("a read that fills the row limit may have cut a cluster short, so it fails open", async () => {
    fixture.members = wireMembers("w", WEEKLY_WIRE_MAX_MEMBER_ROWS);

    await expect(getWeeklyWireSignals(["w"])).resolves.toBeNull();
  });

  it("an answer with no rows is a successful empty answer, not a failure", async () => {
    fixture.members = [];
    await expect(getWeeklyWireSignals(["w"])).resolves.toEqual({});
  });
});

describe("getWeeklyWireSignals: the cache entry", () => {
  it("a read is tagged before it is given a cluster-feed life, exactly one cacheLife call", async () => {
    fixture.members = wireMembers("w");

    await getWeeklyWireSignals(["w"]);

    expect(cacheTag).toHaveBeenCalledWith("clusters-politics");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("a failed read is memoised for minutes only, so a blip is not pinned for the feed window", async () => {
    fixture.error = { message: "boom" };

    await getWeeklyWireSignals(["w"]);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
  });
});
