import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as { message: string } | null,
  throwOnFrom: false,
  last: null as import("../../../tests/_helpers/supabase-fake").BuilderState | null,
}));

const fake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      api_key_webhooks: (st) => {
        state.last = st;
        return { data: state.rows, error: state.error };
      },
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => {
    if (state.throwOnFrom) throw new Error("no env");
    return fake.client;
  },
}));

import { getApiWebhooksStatus } from "@/lib/admin/api-webhooks-status";

beforeEach(() => {
  state.rows = [];
  state.error = null;
  state.throwOnFrom = false;
  state.last = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const row = (over: Record<string, unknown> = {}) => ({
  key_id: 7,
  url: "https://hooks.example.com/private-token-path?x=1",
  enabled: true,
  fail_streak: 2,
  last_success_at: "2026-09-28T10:00:00.000Z",
  last_failure_at: null,
  last_status: 200,
  disabled_reason: null,
  ...over,
});

describe("getApiWebhooksStatus", () => {
  it("never selects the secret column", async () => {
    await getApiWebhooksStatus();
    const sel = String(state.last!.selectArgs[0]);
    expect(sel).not.toMatch(/secret/);
    expect(sel).not.toContain("*");
  });

  it("maps url to host only and drops the url and path", async () => {
    state.rows = [row()];
    const out = await getApiWebhooksStatus();
    expect(out).toEqual([
      {
        key_id: 7,
        host: "hooks.example.com",
        enabled: true,
        fail_streak: 2,
        last_success_at: "2026-09-28T10:00:00.000Z",
        last_failure_at: null,
        last_status: 200,
        disabled_reason: null,
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("private-token-path");
    expect(Object.keys(out![0]!)).not.toContain("url");
    expect(Object.keys(out![0]!)).not.toContain("secret");
  });

  it("returns an empty list for no rows and tolerates a garbage url", async () => {
    expect(await getApiWebhooksStatus()).toEqual([]);
    state.rows = [row({ url: "not a url" })];
    const out = await getApiWebhooksStatus();
    expect(out![0]!.host).toBeNull();
  });

  it("coerces numeric strings and null-ish columns safely", async () => {
    state.rows = [row({ key_id: "9", fail_streak: null, enabled: null })];
    const out = await getApiWebhooksStatus();
    expect(out![0]).toMatchObject({ key_id: 9, fail_streak: 0, enabled: false });
  });

  it("returns null (never throws) on a query error or a thrown client", async () => {
    state.error = { message: "relation does not exist" };
    expect(await getApiWebhooksStatus()).toBeNull();
    state.error = null;
    state.throwOnFrom = true;
    expect(await getApiWebhooksStatus()).toBeNull();
  });
});
