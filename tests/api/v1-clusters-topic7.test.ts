import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseFake } from "../_helpers/supabase-fake";

// fetchTopic7 probes `clusters.topic7` and remembers (process-wide) that the
// column is not shipped. The latch must only trip on a definitive "column
// does not exist" signal: a 4 s reader-cap abort, a statement_timeout or a
// network throw says nothing about the schema, and latching on it would make
// every later /api/v1/clusters response from the instance report
// `topic7: null` until it is recycled.

type PgError = { message: string; code?: string };

const IDS = ["c1", "c2"];

/** A client whose `clusters` read answers from `responses`, one per call (last repeats). */
function clientWith(responses: Array<{ data: unknown; error: PgError | null } | "throw">) {
  let calls = 0;
  const { client } = createSupabaseFake({
    tables: {
      clusters: () => {
        const r = responses[Math.min(calls, responses.length - 1)];
        calls += 1;
        if (r === "throw") throw new TypeError("fetch failed");
        return r as never;
      },
    },
  });
  return {
    client: client as unknown as SupabaseClient,
    calls: () => calls,
  };
}

const OK = {
  data: [
    { id: "c1", topic7: "politika" },
    { id: "c2", topic7: null },
  ],
  error: null,
};

async function freshFetchTopic7() {
  vi.resetModules();
  const mod = await import("@/lib/api/v1-clusters");
  return mod.fetchTopic7;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("fetchTopic7", () => {
  it("returns the non-null topics keyed by cluster id", async () => {
    const fetchTopic7 = await freshFetchTopic7();
    const { client } = clientWith([OK]);

    const map = await fetchTopic7(client, IDS);

    expect(map).toEqual(new Map([["c1", "politika"]]));
  });

  it("short-circuits on an empty id list without querying", async () => {
    const fetchTopic7 = await freshFetchTopic7();
    const { client, calls } = clientWith([OK]);

    const map = await fetchTopic7(client, []);

    expect(map.size).toBe(0);
    expect(calls()).toBe(0);
  });

  it("does NOT latch off on a reader-cap abort: the next call still reads topic7", async () => {
    const fetchTopic7 = await freshFetchTopic7();
    const { client, calls } = clientWith([
      {
        data: null,
        error: { message: "AbortError: Supabase request exceeded 4000 ms", code: "" },
      },
      OK,
    ]);

    const first = await fetchTopic7(client, IDS);
    const second = await fetchTopic7(client, IDS);

    expect(first.size).toBe(0);
    expect(calls()).toBe(2);
    expect(second.get("c1")).toBe("politika");
  });

  it("does NOT latch off on a statement_timeout (57014)", async () => {
    const fetchTopic7 = await freshFetchTopic7();
    const { client, calls } = clientWith([
      {
        data: null,
        error: { message: "canceling statement due to statement timeout", code: "57014" },
      },
      OK,
    ]);

    await fetchTopic7(client, IDS);
    const second = await fetchTopic7(client, IDS);

    expect(calls()).toBe(2);
    expect(second.get("c1")).toBe("politika");
  });

  it("does NOT latch off when the client throws (network failure)", async () => {
    const fetchTopic7 = await freshFetchTopic7();
    const { client, calls } = clientWith(["throw", OK]);

    const first = await fetchTopic7(client, IDS);
    const second = await fetchTopic7(client, IDS);

    expect(first.size).toBe(0);
    expect(calls()).toBe(2);
    expect(second.get("c1")).toBe("politika");
  });

  it("latches off for good on Postgres undefined_column (42703)", async () => {
    const fetchTopic7 = await freshFetchTopic7();
    const { client, calls } = clientWith([
      {
        data: null,
        error: { message: "column clusters.topic7 does not exist", code: "42703" },
      },
      OK,
    ]);

    const first = await fetchTopic7(client, IDS);
    const second = await fetchTopic7(client, IDS);

    expect(first.size).toBe(0);
    expect(second.size).toBe(0);
    // The probe ran once; the second call never reached the database.
    expect(calls()).toBe(1);
  });

  it("latches off on a PostgREST schema-cache miss (PGRST204)", async () => {
    const fetchTopic7 = await freshFetchTopic7();
    const { client, calls } = clientWith([
      {
        data: null,
        error: {
          message: "Could not find the 'topic7' column of 'clusters' in the schema cache",
          code: "PGRST204",
        },
      },
      OK,
    ]);

    await fetchTopic7(client, IDS);
    const second = await fetchTopic7(client, IDS);

    expect(second.size).toBe(0);
    expect(calls()).toBe(1);
  });

  it("latches off on a code-less 'topic7 ... does not exist' message", async () => {
    const fetchTopic7 = await freshFetchTopic7();
    const { client, calls } = clientWith([
      { data: null, error: { message: "column clusters.topic7 does not exist" } },
      OK,
    ]);

    await fetchTopic7(client, IDS);
    await fetchTopic7(client, IDS);

    expect(calls()).toBe(1);
  });

  it("does NOT latch on an unrelated 'does not exist' error", async () => {
    const fetchTopic7 = await freshFetchTopic7();
    const { client, calls } = clientWith([
      { data: null, error: { message: "relation \"clusters\" does not exist", code: "42P01" } },
      OK,
    ]);

    await fetchTopic7(client, IDS);
    const second = await fetchTopic7(client, IDS);

    expect(calls()).toBe(2);
    expect(second.get("c1")).toBe("politika");
  });
});
