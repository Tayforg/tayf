import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createMergedClusterGate } from "./merged-cluster-gate";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ENV = { url: "https://x.supabase.co", anonKey: "anon-key" };

function okFetch(rows: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => rows }) as unknown as Response);
}

function make(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  const gate = createMergedClusterGate({
    getEnv: () => ENV,
    fetchImpl,
    now: () => t,
    ...extra,
  });
  return { gate, clock };
}

describe("createMergedClusterGate", () => {
  it("is cold at first, fetches once on refresh, then answers", async () => {
    const f = okFetch([{ id: A, merged_into: B }]);
    const { gate } = make(f as unknown as typeof fetch);
    expect(gate.lookup(A)).toBeNull();
    await gate.refreshIfStale();
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(
      "/rest/v1/clusters?select=id,merged_into&merged_into=not.is.null&order=updated_at.desc&limit=1000",
    );
    expect(init.headers).toMatchObject({ apikey: "anon-key", Authorization: "Bearer anon-key" });
    expect(gate.lookup(A)).toBe(B);
    expect(gate.lookup(C)).toBeNull();
  });

  it("dedupes a concurrent refresh", async () => {
    const f = okFetch([]);
    const { gate } = make(f as unknown as typeof fetch);
    await Promise.all([gate.refreshIfStale(), gate.refreshIfStale(), gate.refreshIfStale()]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not refetch within the TTL and refetches after it", async () => {
    const f = okFetch([{ id: A, merged_into: B }]);
    const { gate, clock } = make(f as unknown as typeof fetch);
    await gate.refreshIfStale();
    clock.advance(299_000);
    await gate.refreshIfStale();
    expect(f).toHaveBeenCalledTimes(1);
    clock.advance(2_000);
    await gate.refreshIfStale();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("keeps the old map when the fetch fails or times out", async () => {
    let mode: "ok" | "500" | "throw" = "ok";
    const f = vi.fn(async () => {
      if (mode === "throw") throw new Error("timeout");
      if (mode === "500") return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      return { ok: true, status: 200, json: async () => [{ id: A, merged_into: B }] } as unknown as Response;
    });
    const { gate, clock } = make(f as unknown as typeof fetch);
    await gate.refreshIfStale();
    mode = "500";
    clock.advance(400_000);
    await gate.refreshIfStale();
    expect(gate.lookup(A)).toBe(B);
    mode = "throw";
    clock.advance(400_000);
    await expect(gate.refreshIfStale()).resolves.toBeUndefined();
    expect(gate.lookup(A)).toBe(B);
  });

  it("keeps the old map on a non-array body", async () => {
    const f = okFetch({ message: "nope" });
    const { gate } = make(f as unknown as typeof fetch);
    await gate.refreshIfStale();
    expect(gate.lookup(A)).toBeNull();
  });

  it("does nothing without env", async () => {
    const f = okFetch([{ id: A, merged_into: B }]);
    const gate = createMergedClusterGate({
      getEnv: () => ({}),
      fetchImpl: f as unknown as typeof fetch,
    });
    await gate.refreshIfStale();
    expect(f).not.toHaveBeenCalled();
    expect(gate.lookup(A)).toBeNull();
  });

  it("ignores malformed rows and self-pointers", async () => {
    const f = okFetch([
      { id: "not-a-uuid", merged_into: B },
      { id: A, merged_into: "nope" },
      { id: C, merged_into: C },
      { id: null, merged_into: B },
      null,
      { id: B, merged_into: A },
    ]);
    const { gate } = make(f as unknown as typeof fetch);
    await gate.refreshIfStale();
    expect(gate.lookup(A)).toBeNull();
    expect(gate.lookup(C)).toBeNull();
    expect(gate.lookup(B)).toBe(A);
  });

  it("is case-insensitive", async () => {
    const f = okFetch([{ id: A.toUpperCase(), merged_into: B.toUpperCase() }]);
    const { gate } = make(f as unknown as typeof fetch);
    await gate.refreshIfStale();
    expect(gate.lookup(A.toUpperCase())).toBe(B);
    expect(gate.lookup(A)).toBe(B);
  });

  it("has zero import statements (Edge-safe)", () => {
    const src = readFileSync(resolve(__dirname, "merged-cluster-gate.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});
