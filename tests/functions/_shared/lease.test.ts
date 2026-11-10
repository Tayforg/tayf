import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  acquireLease,
  isLeaseRpcMissing,
  releaseLease,
  waitForLease,
} from "../../../supabase/functions/_shared/lease.ts";

// ---------------------------------------------------------------------------
// Direct tests for supabase/functions/_shared/lease.ts (h106-attachdesign-1, migration 190).
//
// The cluster consumer takes a TTL lease row before it drains cluster_work, so the cron-triggered
// consumer and the consumer ingest kicks never read the queue at the same time. This module is the thin
// RPC wrapper (the same shape as _shared/pgmq.ts) plus the one waiting loop of the kick path, with an
// injectable clock and sleep so the timing is tested without waiting:
//
//   1. acquireLease / releaseLease call the exact RPC with the exact argument object and map an error to
//      a thrown Error that keeps the PostgREST / Postgres code (so a caller can tell "migration 190 is
//      not applied" from a real failure);
//   2. isLeaseRpcMissing is true for PGRST202 and 42883 only;
//   3. waitForLease: the 10 s / 400 ms wait of a kick, depth re-checked on every failed try;
//   4. '190 contract': the RPC and argument names equal those of supabase/migrations/190_consumer_lease.sql.
// ---------------------------------------------------------------------------

type Client = Parameters<typeof acquireLease>[0];
interface RpcResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/** A client whose rpc() records (name, args) and answers from a FIFO of queued results. */
function fakeClient(...results: RpcResult[]): { client: Client; rpc: ReturnType<typeof vi.fn> } {
  const queue = [...results];
  const rpc = vi.fn(async (_name: string, _args: unknown): Promise<RpcResult> => {
    const next = queue.shift();
    if (!next) throw new Error("fake rpc queue exhausted");
    return next;
  });
  return { client: { rpc } as unknown as Client, rpc };
}

const ok = (data: unknown): RpcResult => ({ data, error: null });
const fail = (message: string, code?: string): RpcResult => ({
  data: null,
  error: code === undefined ? { message } : { message, code },
});

describe("acquireLease", () => {
  it("calls consumer_lease_acquire with p_name, p_holder and p_ttl_seconds", async () => {
    const { client, rpc } = fakeClient(ok(true));
    expect(await acquireLease(client, "cluster-consumer", "holder-1", 45)).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("consumer_lease_acquire", {
      p_name: "cluster-consumer",
      p_holder: "holder-1",
      p_ttl_seconds: 45,
    });
  });

  it("answers false when the lease is held by someone else", async () => {
    const { client } = fakeClient(ok(false));
    expect(await acquireLease(client, "n", "h", 45)).toBe(false);
  });

  it("throws 'lease.acquire(n): boom' on an RPC error and keeps the code", async () => {
    const { client } = fakeClient(fail("boom", "57014"));
    const err = await acquireLease(client, "n", "h", 45).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("lease.acquire(n): boom");
    expect((err as Error & { code?: string }).code).toBe("57014");
  });

  it("leaves the code off when the error has none", async () => {
    const { client } = fakeClient(fail("boom"));
    const err = await acquireLease(client, "n", "h", 45).catch((e: unknown) => e);
    expect((err as Error).message).toBe("lease.acquire(n): boom");
    expect(Object.prototype.hasOwnProperty.call(err, "code")).toBe(false);
  });

  it.each([null, undefined, "t", 1, 0, [true], { ok: true }])(
    "treats a result that is not a boolean (%j) as an error, never as 'free' or 'busy'",
    async (data) => {
      const { client } = fakeClient(ok(data));
      const err = await acquireLease(client, "n", "h", 45).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("lease.acquire(n)");
      expect(isLeaseRpcMissing(err)).toBe(false);
    },
  );

  it("lets a rejected call (network failure) propagate", async () => {
    const rpc = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await expect(acquireLease({ rpc } as unknown as Client, "n", "h", 45)).rejects.toThrow("fetch failed");
  });
});

describe("releaseLease", () => {
  it("calls consumer_lease_release with p_name and p_holder", async () => {
    const { client, rpc } = fakeClient(ok(true));
    expect(await releaseLease(client, "cluster-consumer", "holder-1")).toBe(true);
    expect(rpc).toHaveBeenCalledWith("consumer_lease_release", { p_name: "cluster-consumer", p_holder: "holder-1" });
  });

  it("answers false when nothing was released (the lease had expired and been taken over)", async () => {
    const { client } = fakeClient(ok(false));
    expect(await releaseLease(client, "n", "h")).toBe(false);
  });

  it("answers false for an empty result (null) instead of throwing: a release is best effort", async () => {
    const { client } = fakeClient(ok(null));
    expect(await releaseLease(client, "n", "h")).toBe(false);
  });

  it("throws 'lease.release(n): boom' on an RPC error and keeps the code", async () => {
    const { client } = fakeClient(fail("boom", "PGRST202"));
    const err = await releaseLease(client, "n", "h").catch((e: unknown) => e);
    expect((err as Error).message).toBe("lease.release(n): boom");
    expect((err as Error & { code?: string }).code).toBe("PGRST202");
  });
});

describe("isLeaseRpcMissing", () => {
  it.each(["PGRST202", "42883"])("is true for %s (migration 190 not applied, or dropped while PostgREST still cached it)", (code) => {
    expect(isLeaseRpcMissing(Object.assign(new Error("x"), { code }))).toBe(true);
    expect(isLeaseRpcMissing({ code })).toBe(true);
  });

  it.each(["57014", "42501", "23502", "PGRST301", "", "pgrst202"])("is false for the real failure %s", (code) => {
    expect(isLeaseRpcMissing(Object.assign(new Error("x"), { code }))).toBe(false);
  });

  it.each([null, undefined, "PGRST202", 42883, {}, new Error("no code"), { code: 42883 }])("is false for %j", (value) => {
    expect(isLeaseRpcMissing(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// waitForLease: the kick's wait. A fake clock that only the injected sleep moves.
// ---------------------------------------------------------------------------

function clock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    at: () => t,
  };
}

describe("waitForLease", () => {
  const WAIT = 10_000;
  const STEP = 400;

  it("acquires on the first try without sleeping and without looking at the queue", async () => {
    const c = clock();
    const acquire = vi.fn(async () => true);
    const depth = vi.fn(async () => 5);
    const r = await waitForLease({ acquire, depth, waitMs: WAIT, stepMs: STEP, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ outcome: "acquired", tries: 1, waitedMs: 0 });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(depth).not.toHaveBeenCalled();
    expect(c.sleeps).toEqual([]);
  });

  it("waits step by step while the lease is held and acquires the moment it frees", async () => {
    const c = clock();
    const answers = [false, false, true];
    const acquire = vi.fn(async () => answers.shift() ?? false);
    const depth = vi.fn(async () => 3);
    const r = await waitForLease({ acquire, depth, waitMs: WAIT, stepMs: STEP, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ outcome: "acquired", tries: 3, waitedMs: 800 });
    expect(c.sleeps).toEqual([400, 400]);
    expect(depth).toHaveBeenCalledTimes(2); // once after each failed try
  });

  it("gives up as busy after exactly 10 s of waiting: 26 tries at 0, 400, ... 10000 ms, 25 sleeps of 400 ms", async () => {
    const c = clock();
    const acquire = vi.fn(async () => false);
    const depth = vi.fn(async () => 7);
    const r = await waitForLease({ acquire, depth, waitMs: WAIT, stepMs: STEP, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ outcome: "busy", tries: 26, waitedMs: 10_000 });
    expect(acquire).toHaveBeenCalledTimes(26);
    expect(c.sleeps).toHaveLength(25);
    expect(new Set(c.sleeps)).toEqual(new Set([400]));
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(depth).toHaveBeenCalledTimes(25); // not after the last, timed-out try
  });

  it("shortens the last sleep so the wait never passes waitMs (1000 ms in steps of 400: 400, 400, 200)", async () => {
    const c = clock();
    const acquire = vi.fn(async () => false);
    const r = await waitForLease({ acquire, depth: async () => 1, waitMs: 1_000, stepMs: 400, now: c.now, sleep: c.sleep });
    expect(c.sleeps).toEqual([400, 400, 200]);
    expect(r).toEqual({ outcome: "busy", tries: 4, waitedMs: 1_000 });
  });

  it("exits 'empty' as soon as the queue is empty after a failed try, and makes no further try", async () => {
    const c = clock();
    const depths = [4, 2, 0];
    const acquire = vi.fn(async () => false);
    const depth = vi.fn(async () => depths.shift() ?? 0);
    const r = await waitForLease({ acquire, depth, waitMs: WAIT, stepMs: STEP, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ outcome: "empty", tries: 3, waitedMs: 800 });
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(c.sleeps).toEqual([400, 400]);
  });

  it("an unknown depth (null, or the probe throwing) is not 'empty': it keeps waiting", async () => {
    const c = clock();
    let n = 0;
    const depth = vi.fn(async () => {
      n += 1;
      if (n % 2 === 0) throw new Error("metrics down");
      return null;
    });
    const r = await waitForLease({ acquire: async () => false, depth, waitMs: 1_200, stepMs: 400, now: c.now, sleep: c.sleep });
    expect(r.outcome).toBe("busy");
    expect(c.sleeps).toEqual([400, 400, 400]);
  });

  it("returns 'error' with the thrown error on the first failing try: no sleep, no second try (a kick fails closed)", async () => {
    const c = clock();
    const boom = Object.assign(new Error("lease.acquire(n): nope"), { code: "PGRST202" });
    const acquire = vi.fn(async () => {
      throw boom;
    });
    const r = await waitForLease({ acquire, depth: async () => 1, waitMs: WAIT, stepMs: STEP, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ outcome: "error", error: boom, tries: 1, waitedMs: 0 });
    expect(isLeaseRpcMissing((r as { error: unknown }).error)).toBe(true);
    expect(c.sleeps).toEqual([]);
  });

  it("returns 'error' when a LATER try fails, after the sleeps before it", async () => {
    const c = clock();
    let n = 0;
    const acquire = vi.fn(async () => {
      n += 1;
      if (n === 3) throw new Error("statement timeout");
      return false;
    });
    const r = await waitForLease({ acquire, depth: async () => 1, waitMs: WAIT, stepMs: STEP, now: c.now, sleep: c.sleep });
    expect(r.outcome).toBe("error");
    expect(r.tries).toBe(3);
    expect(r.waitedMs).toBe(800);
  });

  it("waitMs 0 is one try: busy at once, no sleep, no depth probe", async () => {
    const c = clock();
    const depth = vi.fn(async () => 1);
    const r = await waitForLease({ acquire: async () => false, depth, waitMs: 0, stepMs: STEP, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ outcome: "busy", tries: 1, waitedMs: 0 });
    expect(depth).not.toHaveBeenCalled();
    expect(c.sleeps).toEqual([]);
  });

  it("terminates on a frozen clock: the time slept counts as time waited", async () => {
    const sleeps: number[] = [];
    const r = await waitForLease({
      acquire: async () => false,
      depth: async () => 1,
      waitMs: 1_000,
      stepMs: 400,
      now: () => 5,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(r.outcome).toBe("busy");
    expect(sleeps).toEqual([400, 400, 200]);
  });

  it("terminates on a clock that is not a number", async () => {
    const sleeps: number[] = [];
    const r = await waitForLease({
      acquire: async () => false,
      depth: async () => 1,
      waitMs: 1_000,
      stepMs: 400,
      now: () => Number.NaN,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(r.outcome).toBe("busy");
    expect(sleeps).toEqual([400, 400, 200]);
  });

  it.each([0, -5, Number.NaN])("a step of %s still terminates (it is floored, never an endless loop)", async (stepMs) => {
    const c = clock();
    const r = await waitForLease({ acquire: async () => false, depth: async () => 1, waitMs: 2_000, stepMs, now: c.now, sleep: c.sleep });
    expect(r.outcome).toBe("busy");
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBe(2_000);
  });

  it("sleeps for real (setTimeout) when no sleep is injected", async () => {
    vi.useFakeTimers();
    try {
      const acquire = vi.fn(async () => false);
      const done = waitForLease({ acquire, depth: async () => 1, waitMs: 800, stepMs: 400 });
      await vi.advanceTimersByTimeAsync(800);
      const r = await done;
      expect(r).toMatchObject({ outcome: "busy", tries: 3 });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// '190 contract': the names of the RPCs and their arguments are those of the migration.
// ---------------------------------------------------------------------------

describe("190 contract", () => {
  const migration = readFileSync(resolve(__dirname, "..", "..", "..", "supabase", "migrations", "190_consumer_lease.sql"), "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");

  function paramsOf(fn: string): string[] {
    const m = new RegExp(`create or replace function public\\.${fn}\\(([^)]*)\\)`, "i").exec(migration);
    expect(m, `${fn} must be created by migration 190`).not.toBeNull();
    return (m?.[1] ?? "").split(",").map((p) => p.trim().split(/\s+/)[0] ?? "");
  }

  it("acquireLease sends exactly the parameters consumer_lease_acquire declares", async () => {
    const { client, rpc } = fakeClient(ok(true));
    await acquireLease(client, "n", "h", 45);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("consumer_lease_acquire");
    expect(Object.keys(args)).toEqual(paramsOf("consumer_lease_acquire"));
  });

  it("releaseLease sends exactly the parameters consumer_lease_release declares", async () => {
    const { client, rpc } = fakeClient(ok(true));
    await releaseLease(client, "n", "h");
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("consumer_lease_release");
    expect(Object.keys(args)).toEqual(paramsOf("consumer_lease_release"));
  });

  it("no other migration names the lease table or its functions (190 owns them alone)", () => {
    const dir = resolve(__dirname, "..", "..", "..", "supabase", "migrations");
    const hits = readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && !f.startsWith("190_"))
      .filter((f) => /consumer_lease/i.test(readFileSync(resolve(dir, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
