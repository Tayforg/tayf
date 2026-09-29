import { describe, it, expect, vi, beforeEach } from "vitest";

import { createSupabaseFake, type PgResult } from "../../../tests/_helpers/supabase-fake";

const S = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";

let rpcImpl: (args: unknown) => PgResult | Promise<PgResult>;
let rpcSpy: ReturnType<typeof vi.fn>;
let throwOnCreate = false;

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => {
    if (throwOnCreate) throw new Error("boom");
    const { client } = createSupabaseFake({
      rpc: {
        cluster_merge_atomic: (args: unknown) => {
          rpcSpy(args);
          return rpcImpl(args);
        },
      },
    });
    return client;
  },
}));

import { MERGE_ERROR_CODES, mergeClusters, mergeRevalidationTags } from "./merge";

const okData = {
  log_id: 7,
  resweep: false,
  moved: 3,
  duplicates: 1,
  source_count_before: 4,
  target_count_before: 5,
  target_count_after: 8,
  target_blindspot_before: true,
  target_blindspot_after: false,
};

const input = { source: S, target: T, actor: "admin", origin: "manual" as const };

beforeEach(() => {
  rpcSpy = vi.fn();
  throwOnCreate = false;
  rpcImpl = () => ({ data: okData, error: null });
});

describe("mergeClusters", () => {
  it("maps the snake-case jsonb to a MergeOutcome", async () => {
    const r = await mergeClusters(input);
    expect(r).toEqual({
      ok: true,
      outcome: {
        logId: 7,
        resweep: false,
        moved: 3,
        duplicates: 1,
        sourceCountBefore: 4,
        targetCountBefore: 5,
        targetCountAfter: 8,
        targetBlindspotBefore: true,
        targetBlindspotAfter: false,
      },
    });
    expect(rpcSpy).toHaveBeenCalledWith({ p_source: S, p_target: T, p_actor: "admin", p_origin: "manual" });
  });

  it("maps a null log_id (resweep) to logId null", async () => {
    rpcImpl = () => ({ data: { ...okData, log_id: null, resweep: true, moved: 0 }, error: null });
    const r = await mergeClusters(input);
    expect(r.ok && r.outcome.logId).toBeNull();
    expect(r.ok && r.outcome.resweep).toBe(true);
  });

  it.each([
    ["cluster_merge_self", "invalid"],
    ["cluster_merge_bad_actor", "invalid"],
    ["cluster_merge_bad_origin", "invalid"],
    ["cluster_merge_not_found", "not-found"],
    ["cluster_merge_target_archived", "conflict"],
    ["cluster_merge_target_merged", "conflict"],
    ["cluster_merge_source_merged", "conflict"],
    ["something else entirely", "error"],
  ])("maps %s to %s", async (message, reason) => {
    rpcImpl = () => ({ data: null, error: { message } });
    expect(await mergeClusters(input)).toEqual({ ok: false, reason });
  });

  it("lists every error code once", () => {
    expect(new Set(MERGE_ERROR_CODES).size).toBe(MERGE_ERROR_CODES.length);
  });

  it.each([
    [{ ...input, source: "nope" }],
    [{ ...input, target: "" }],
    [{ ...input, target: S }],
    [{ ...input, target: S.toUpperCase() }],
  ])("rejects bad or equal ids with no rpc call", async (bad) => {
    expect(await mergeClusters(bad)).toEqual({ ok: false, reason: "invalid" });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it("lowercases ids before the call", async () => {
    await mergeClusters({ ...input, source: S.toUpperCase(), target: T.toUpperCase() });
    expect(rpcSpy).toHaveBeenCalledWith(expect.objectContaining({ p_source: S, p_target: T }));
  });

  it.each([[null], ["str"], [[1]], [undefined]])("treats non-object data %j as error", async (data) => {
    rpcImpl = () => ({ data: data as never, error: null });
    expect(await mergeClusters(input)).toEqual({ ok: false, reason: "error" });
  });

  it("never throws when the client throws", async () => {
    throwOnCreate = true;
    expect(await mergeClusters(input)).toEqual({ ok: false, reason: "error" });
  });

  it("never throws when the rpc rejects", async () => {
    rpcImpl = () => Promise.reject(new Error("net"));
    expect(await mergeClusters(input)).toEqual({ ok: false, reason: "error" });
  });
});

describe("mergeRevalidationTags", () => {
  it("returns exactly the fixed tag list", () => {
    expect(mergeRevalidationTags("s", "t")).toEqual([
      "clusters",
      "clusters-politics",
      "clusters-search",
      "story-threads",
      "cluster-detail:s",
      "cluster-detail:t",
      "fact-checks:s",
      "fact-checks:t",
    ]);
  });
});
