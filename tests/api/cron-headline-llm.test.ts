import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HEADLINE_PROMPT_VERSION } from "@/lib/headline/prompt";
import { EXTRACTIVE_MODEL_ID } from "@/lib/clusters/neutral-title";
import { estimateCallUsd, utcDay } from "@/lib/headline/budget";

// ---------------------------------------------------------------------------
// Contract tests for the B7 LLM eligibility pre-gate + daily USD budget
// added to GET /api/cron/headline by migration 069 (Pack E, W1).
//
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts)
// per tests/api/sources-json.test.ts / tests/api/cron/headline.test.ts
// convention: `vi.mock("@supabase/supabase-js", ...)`, `vi.mock("next/server",
// ...)` to stub `connection`, env vars set in beforeEach, `vi.resetModules()`
// in afterEach. Each test that would otherwise share a rate-limit bucket
// with another uses a distinct clientKey IP where relevant (this route's
// bucket refills slowly, so tests reuse one IP per file deliberately EXCEPT
// where a test intentionally floods it — none here do).
// ---------------------------------------------------------------------------

const { revalidateTagMock } = vi.hoisted(() => ({ revalidateTagMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag: revalidateTagMock }));

const { captureServerExceptionMock } = vi.hoisted(() => ({
  captureServerExceptionMock: vi.fn(),
}));
vi.mock("@/lib/sentry/server", () => ({ captureServerException: captureServerExceptionMock }));

interface ClusterRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  summary_tr: string;
  article_count: number;
  title_neutral_prompt_version?: string | null;
}

interface MemberTitle {
  title: string;
  published_at: string;
}

const dbState = vi.hoisted(() => ({
  clusters: [] as ClusterRow[],
  membersByCluster: {} as Record<string, MemberTitle[]>,
  eligibilityByCluster: {} as Record<
    string,
    { eligible: boolean; politics_n: number; clickbait_share: number }
  >,
  forceEligibilityError: false,
  budgetAddReturns: null as number | null,
  llmBudgetDailyRow: null as { day: string; usd: number; eligible_n?: number; ineligible_n?: number } | null,
  // Set to a cluster id to make the `.eq("id", <id>).update(...)` write
  // resolve as a PostgREST error (the `.select()` picker query never
  // filters by `id`, so this only ever hits the write path).
  forceClusterUpdateErrorFor: null as string | null,
  // The `.or(...)` filter strings of every pick query (the select that never
  // filters by id), in call order.
  pickOrFilters: [] as string[][],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        const idEq = state.eq.find((e) => e.col === "id");
        if (idEq && dbState.forceClusterUpdateErrorFor === idEq.val) {
          return { data: null, error: { message: "update failed" } };
        }
        // The pick query. Emulate the one filter the route sends that matters
        // here: `title_neutral_prompt_version.neq."<mark>"` (or null) hides a
        // cluster the gate already rejected under this prompt version.
        dbState.pickOrFilters.push([...state.or]);
        const excluded = /title_neutral_prompt_version\.neq\."([^"]+)"/.exec(state.or.join(","));
        const rows = dbState.clusters.filter(
          (c) => !(excluded && c.title_neutral_prompt_version === excluded[1]),
        );
        return { data: rows, error: null };
      },
      cluster_articles: (state) => {
        const clusterIdEq = state.eq.find((e) => e.col === "cluster_id");
        const id = clusterIdEq?.val as string | undefined;
        const members = (id ? dbState.membersByCluster[id] : undefined) ?? [];
        return {
          data: members.map((m) => ({ articles: { title: m.title, published_at: m.published_at } })),
          error: null,
        };
      },
      llm_budget_daily: (state) => {
        const dayEq = state.eq.find((e) => e.col === "day");
        if (dbState.llmBudgetDailyRow && dayEq?.val === dbState.llmBudgetDailyRow.day) {
          return {
            data: {
              day: dbState.llmBudgetDailyRow.day,
              calls: 1,
              input_tokens: 100,
              output_tokens: 10,
              usd: dbState.llmBudgetDailyRow.usd,
              eligible_n: dbState.llmBudgetDailyRow.eligible_n ?? 0,
              ineligible_n: dbState.llmBudgetDailyRow.ineligible_n ?? 0,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    },
    rpc: {
      headline_llm_eligible: (args: unknown) => {
        if (dbState.forceEligibilityError) {
          return { data: null, error: { message: "eligibility rpc boom" } };
        }
        const { p_cluster_ids } = args as { p_cluster_ids: string[] };
        const rows = p_cluster_ids
          .filter((id) => id in dbState.eligibilityByCluster)
          .map((id) => ({ cluster_id: id, ...dbState.eligibilityByCluster[id]! }));
        return { data: rows, error: null };
      },
      llm_budget_add: () => {
        return { data: dbState.budgetAddReturns, error: null };
      },
      llm_budget_gate: () => ({ data: null, error: null }),
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

// What the route stamps into title_neutral_prompt_version when the gate rejects a rewrite.
const REJECTED_MARK = `${HEADLINE_PROMPT_VERSION}:rejected`;

const LLM_API_URL = "https://api.anthropic.com/v1/messages";
const originalFetch = globalThis.fetch;
let llmFetchSpy: ReturnType<typeof vi.spyOn> | null = null;
let llmUsage = { input_tokens: 400, output_tokens: 20 };
let llmText = "Tarafsız toplu başlık";

function installLlmFetchSpy(): void {
  llmFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(LLM_API_URL)) {
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: llmText }], usage: llmUsage }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.CRON_SECRET = "shhh";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  delete process.env.HEADLINE_PAUSED;
  delete process.env.HEADLINE_LLM_DAILY_USD_CAP;

  dbState.clusters = [];
  dbState.membersByCluster = {};
  dbState.eligibilityByCluster = {};
  dbState.forceEligibilityError = false;
  dbState.budgetAddReturns = 0.001;
  dbState.llmBudgetDailyRow = null;
  dbState.forceClusterUpdateErrorFor = null;
  dbState.pickOrFilters = [];

  llmUsage = { input_tokens: 400, output_tokens: 20 };
  llmText = "Tarafsız toplu başlık";

  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;

  revalidateTagMock.mockClear();
  captureServerExceptionMock.mockClear();
  installLlmFetchSpy();
});

afterEach(() => {
  if (llmFetchSpy) {
    llmFetchSpy.mockRestore();
    llmFetchSpy = null;
  }
  globalThis.fetch = originalFetch;
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CRON_SECRET",
    "ANTHROPIC_API_KEY",
    "HEADLINE_PAUSED",
    "HEADLINE_LLM_DAILY_USD_CAP",
  ]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

function cluster(id: string, overrides: Partial<ClusterRow> = {}): ClusterRow {
  return {
    id,
    title_tr: `Original ${id}`,
    title_tr_neutral: null,
    summary_tr: "summary",
    article_count: 4,
    ...overrides,
  };
}

function members(id: string, titles: string[]): void {
  dbState.membersByCluster[id] = titles.map((t, i) => ({
    title: t,
    published_at: new Date(2026, 0, i + 1).toISOString(),
  }));
}

function eligible(id: string, extra: Partial<{ politics_n: number; clickbait_share: number }> = {}): void {
  dbState.eligibilityByCluster[id] = {
    eligible: true,
    politics_n: extra.politics_n ?? 2,
    clickbait_share: extra.clickbait_share ?? 0,
  };
}

function ineligible(id: string): void {
  dbState.eligibilityByCluster[id] = { eligible: false, politics_n: 0, clickbait_share: 0 };
}

async function getHandler() {
  const mod = await import("@/app/api/cron/headline/route");
  return mod.GET;
}

function req(ip = "203.0.113.30"): Request {
  return new Request("http://example.com/api/cron/headline", {
    headers: { Authorization: "Bearer shhh", "x-forwarded-for": ip },
  });
}

describe("GET /api/cron/headline — llm mode (B7 eligibility + budget gate)", () => {
  it("calls headline_llm_eligible once with the candidate ids and never calls the LLM for an ineligible cluster", async () => {
    dbState.clusters = [cluster("c1")];
    members("c1", ["Başlık A", "Başlık B"]);
    ineligible("c1");

    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);

    const eligibilityCalls = supabaseFake.calls.rpc.filter((c) => c.name === "headline_llm_eligible");
    expect(eligibilityCalls).toHaveLength(1);
    expect(eligibilityCalls[0]!.args).toEqual({ p_cluster_ids: ["c1"] });
    expect(llmFetchSpy).not.toHaveBeenCalled();
  });

  it("an ineligible cluster with a null title_tr_neutral gets an extractive title and status 'extractive'", async () => {
    dbState.clusters = [cluster("c1", { title_tr_neutral: null })];
    members("c1", ["Şok! Bomba açıklama geldi!", "Açıklama yapıldı, detaylar netleşti"]);
    ineligible("c1");

    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clusters: Record<string, { status: string }> };
    expect(body.clusters.c1!.status).toBe("extractive");

    const update = supabaseFake.calls.update("clusters").find((u) => u.state.eq.some((e) => e.val === "c1"));
    expect(update).toBeDefined();
    const patch = update!.patch as {
      title_tr_neutral?: unknown;
      title_neutral_at?: unknown;
      title_neutral_model?: unknown;
    };
    expect(typeof patch.title_tr_neutral).toBe("string");
    expect((patch.title_tr_neutral as string).length).toBeGreaterThan(0);
    expect(patch.title_neutral_model).toBe(EXTRACTIVE_MODEL_ID);
    expect(patch.title_neutral_at).toBeUndefined();
    expect(llmFetchSpy).not.toHaveBeenCalled();
  });

  it("an ineligible cluster that already has title_tr_neutral is left untouched with status 'ineligible'", async () => {
    dbState.clusters = [cluster("c1", { title_tr_neutral: "Zaten var olan başlık" })];
    members("c1", ["Başlık A"]);
    ineligible("c1");

    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clusters: Record<string, { status: string }> };
    expect(body.clusters.c1!.status).toBe("ineligible");

    const update = supabaseFake.calls.update("clusters").find((u) => u.state.eq.some((e) => e.val === "c1"));
    expect(update).toBeUndefined();
    expect(llmFetchSpy).not.toHaveBeenCalled();
  });

  it("an eligible cluster gets the LLM title plus title_neutral_at, title_neutral_model and title_neutral_prompt_version", async () => {
    dbState.clusters = [cluster("c1")];
    members("c1", ["Başlık A", "Başlık B"]);
    eligible("c1");

    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clusters: Record<string, { status: string }>; rewrote: number };
    expect(body.clusters.c1!.status).toBe("rewrote");
    expect(body.rewrote).toBe(1);

    const update = supabaseFake.calls.update("clusters").find((u) => u.state.eq.some((e) => e.val === "c1"));
    expect(update).toBeDefined();
    const patch = update!.patch as {
      title_tr_neutral?: unknown;
      title_neutral_at?: unknown;
      title_neutral_model?: unknown;
      title_neutral_prompt_version?: unknown;
    };
    expect(patch.title_tr_neutral).toBe(llmText);
    expect(typeof patch.title_neutral_at).toBe("string");
    expect(patch.title_neutral_model).toBe(process.env.LLM_MODEL ?? "claude-haiku-4-5-20251001");
    expect(patch.title_neutral_prompt_version).toBe(HEADLINE_PROMPT_VERSION);
    expect(llmFetchSpy).toHaveBeenCalledTimes(1);
  });

  it("records the call in llm_budget_add with the vendor's usage.input_tokens and usage.output_tokens", async () => {
    dbState.clusters = [cluster("c1")];
    members("c1", ["Başlık A"]);
    eligible("c1");
    llmUsage = { input_tokens: 777, output_tokens: 33 };

    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);

    const addCalls = supabaseFake.calls.rpc.filter((c) => c.name === "llm_budget_add");
    expect(addCalls).toHaveLength(1);
    const args = addCalls[0]!.args as {
      p_day: string;
      p_calls: number;
      p_in: number;
      p_out: number;
      p_usd: number;
    };
    expect(args.p_calls).toBe(1);
    expect(args.p_in).toBe(777);
    expect(args.p_out).toBe(33);
    expect(args.p_usd).toBeCloseTo(estimateCallUsd(777, 33), 10);
    expect(args.p_day).toBe(utcDay());
  });

  it("stops calling the LLM and tags 'budgeted_out' once the day's usd reaches the cap", async () => {
    process.env.HEADLINE_LLM_DAILY_USD_CAP = "1.00";
    dbState.clusters = [cluster("c1"), cluster("c2")];
    members("c1", ["Başlık A"]);
    members("c2", ["Başlık B"]);
    eligible("c1");
    eligible("c2");
    // First call's recorded total already meets/exceeds the cap, so the
    // SECOND cluster in the loop must be budgeted_out without a fetch call.
    dbState.budgetAddReturns = 2.5;

    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clusters: Record<string, { status: string }>;
      budgetedOut: number;
    };
    expect(body.clusters.c1!.status).toBe("rewrote");
    expect(body.clusters.c2!.status).toBe("budgeted_out");
    expect(body.budgetedOut).toBe(1);
    expect(llmFetchSpy).toHaveBeenCalledTimes(1);
  });

  it("makes zero LLM calls when the day is already over cap before the first cluster", async () => {
    process.env.HEADLINE_LLM_DAILY_USD_CAP = "1.00";
    const day = utcDay();
    dbState.llmBudgetDailyRow = { day, usd: 5, eligible_n: 0, ineligible_n: 0 };
    dbState.clusters = [cluster("c1")];
    members("c1", ["Başlık A"]);
    eligible("c1");

    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clusters: Record<string, { status: string }>;
      budgetedOut: number;
    };
    expect(body.clusters.c1!.status).toBe("budgeted_out");
    expect(body.budgetedOut).toBe(1);
    expect(llmFetchSpy).not.toHaveBeenCalled();
  });

  it("writes the cycle's eligible/ineligible counts via llm_budget_gate exactly once", async () => {
    dbState.clusters = [cluster("c1"), cluster("c2"), cluster("c3")];
    members("c1", ["A"]);
    members("c2", ["B"]);
    members("c3", ["C"]);
    eligible("c1");
    ineligible("c2");
    ineligible("c3");

    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);

    const gateCalls = supabaseFake.calls.rpc.filter((c) => c.name === "llm_budget_gate");
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0]!.args).toEqual({
      p_day: utcDay(),
      p_eligible: 1,
      p_ineligible: 2,
    });
  });

  it("still calls llm_budget_add exactly once when the clusters UPDATE returns an error (E1-BUDGET-LEAK)", async () => {
    dbState.clusters = [cluster("c1")];
    members("c1", ["Başlık A"]);
    eligible("c1");
    dbState.forceClusterUpdateErrorFor = "c1";

    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clusters: Record<string, { status: string }> };
    expect(body.clusters.c1!.status).toBe("errored");
    expect(body.clusters.c1!.error).toBe("write-failed");

    // The vendor call was already billed by the time the write fails, so
    // the budget RPC must still have fired exactly once.
    const addCalls = supabaseFake.calls.rpc.filter((c) => c.name === "llm_budget_add");
    expect(addCalls).toHaveLength(1);
    expect(llmFetchSpy).toHaveBeenCalledTimes(1);
  });

  it("bills a vendor 200 with empty content instead of leaking budget (E2-BUDGET-LEAK)", async () => {
    dbState.clusters = [cluster("c1")];
    members("c1", ["Başlık A"]);
    eligible("c1");
    llmFetchSpy?.mockRestore();
    llmFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ content: [], usage: { input_tokens: 10, output_tokens: 5 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clusters: Record<string, { status: string; error?: string }>;
    };
    expect(body.clusters.c1!.status).toBe("errored");
    expect(body.clusters.c1!.error).toBe("empty rewrite");

    const addCalls = supabaseFake.calls.rpc.filter((c) => c.name === "llm_budget_add");
    expect(addCalls).toHaveLength(1);
    const args = addCalls[0]!.args as { p_in: number; p_out: number };
    expect(args.p_in).toBe(10);
    expect(args.p_out).toBe(5);
  });

  it("an eligibility rpc failure makes every cluster take the extractive path and never 500s", async () => {
    dbState.forceEligibilityError = true;
    dbState.clusters = [cluster("c1", { title_tr_neutral: null })];
    members("c1", ["Meclis'te bütçe görüşmeleri başladı", "Meclis'te bütçe görüşmelerinin ilk günü tamamlandı"]);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clusters: Record<string, { status: string }> };
    expect(body.clusters.c1!.status).toBe("extractive");
    expect(llmFetchSpy).not.toHaveBeenCalled();
    expect(
      supabaseFake.calls.rpc.filter((c) => c.name === "llm_budget_add"),
    ).toHaveLength(0);
    errorSpy.mockRestore();
  });
});

describe("GET /api/cron/headline — llm mode, acceptance gate on the rewrite", () => {
  const MEMBERS = [
    "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı",
    "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı",
    "Bakırköy Belediyesine yönelik soruşturmada 39 şüpheli tutuklandı",
  ];

  const REJECTED: Array<[string, string]> = [
    ["a question", "Bakırköy soruşturması neden başladı, kim tutuklandı?"],
    ["shouting", "BAKIRKÖY BELEDİYESİ SORUŞTURMASINDA 39 TUTUKLAMA"],
    ["English", "Bakirkoy municipality probe ends with 39 arrests in the city"],
    ["too short", "Bakırköy tutuklama"],
    ["a leading 'İşte'", "İşte Bakırköy soruşturmasında tutuklanan 39 kişi"],
    ["a placeholder", "Cumhurbaşkanı Erdoğan konuşuyor"],
  ];

  it.each(REJECTED)("rejects %s: errored 'rejected rewrite', still metered, the text is never written", async (_label, text) => {
    llmText = text;
    dbState.clusters = [cluster("c1", { title_tr_neutral: "Zaten var olan başlık" })];
    members("c1", MEMBERS);
    eligible("c1");

    const GET = await getHandler();
    const res = await GET(req("203.0.113.31"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rewrote: number;
      errored: number;
      clusters: Record<string, { status: string; error?: string }>;
    };
    expect(body.clusters.c1).toEqual({ status: "errored", error: "rejected rewrite" });
    expect(body.rewrote).toBe(0);
    expect(body.errored).toBe(1);

    // The vendor call was billed: the budget is metered exactly once.
    expect(supabaseFake.calls.rpc.filter((c) => c.name === "llm_budget_add")).toHaveLength(1);
    // The text is never written and the cluster keeps its title; the only
    // write is the mark that keeps it out of the next LLM pick.
    const updates = supabaseFake.calls.update("clusters");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch).toEqual({ title_neutral_prompt_version: REJECTED_MARK });
    expect(updates[0]!.state.is).toContainEqual({ col: "title_neutral_at", val: null });
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("a rejected rewrite for a cluster with NO neutral title writes the extractive pick instead (status 'extractive')", async () => {
    llmText = "Bakırköy soruşturması neden başladı, kim tutuklandı?";
    dbState.clusters = [cluster("c1", { title_tr_neutral: null, article_count: 3 })];
    members("c1", MEMBERS);
    eligible("c1");

    const GET = await getHandler();
    const res = await GET(req("203.0.113.32"));
    const body = (await res.json()) as {
      rewrote: number;
      errored: number;
      clusters: Record<string, { status: string }>;
    };
    expect(body.clusters.c1!.status).toBe("extractive");
    expect(body.rewrote).toBe(0);
    expect(body.errored).toBe(0);
    expect(llmFetchSpy).toHaveBeenCalledTimes(1);
    expect(supabaseFake.calls.rpc.filter((c) => c.name === "llm_budget_add")).toHaveLength(1);

    const updates = supabaseFake.calls.update("clusters");
    expect(updates).toHaveLength(1);
    const patch = updates[0]!.patch as Record<string, unknown>;
    expect(patch).toEqual({
      title_tr_neutral: "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı",
      title_neutral_model: EXTRACTIVE_MODEL_ID,
      title_neutral_member_count: 3,
      title_neutral_prompt_version: REJECTED_MARK,
    });
    expect(JSON.stringify(supabaseFake.calls.mutations)).not.toContain("kim tutuklandı");
    // Not an AI neutralization: no title_neutral_at.
    expect("title_neutral_at" in patch).toBe(false);
    expect(revalidateTagMock).toHaveBeenCalledWith("cluster-detail:c1", "max");
  });

  it("a rejected rewrite with no neutral title and only placeholder members is errored 'rejected rewrite', mark only", async () => {
    llmText = "Bakırköy soruşturması neden başladı, kim tutuklandı?";
    dbState.clusters = [cluster("c1", { title_tr_neutral: null })];
    members("c1", ["Kısa haberler", "Son dakika"]);
    eligible("c1");

    const GET = await getHandler();
    const res = await GET(req("203.0.113.33"));
    const body = (await res.json()) as { clusters: Record<string, { status: string; error?: string }> };
    expect(body.clusters.c1).toEqual({ status: "errored", error: "rejected rewrite" });
    const updates = supabaseFake.calls.update("clusters");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch).toEqual({ title_neutral_prompt_version: REJECTED_MARK });
  });

  it("a rejected rewrite with no neutral title and only question members gets the cleaned floor pick (never the raw title)", async () => {
    llmText = "Bakırköy soruşturması neden başladı, kim tutuklandı?";
    dbState.clusters = [cluster("c1", { title_tr_neutral: null })];
    members("c1", ["Son dakika depremler! Deprem mi oldu? 1 Kasım 2026 nerede, ne zaman deprem oldu?", "Kısa haberler"]);
    eligible("c1");

    const GET = await getHandler();
    const res = await GET(req("203.0.113.37"));
    const body = (await res.json()) as { clusters: Record<string, { status: string }> };
    expect(body.clusters.c1!.status).toBe("extractive");
    const patch = supabaseFake.calls.update("clusters")[0]!.patch as Record<string, unknown>;
    expect(patch.title_tr_neutral).toBe("Depremler. Deprem mi oldu? 1 Kasım 2026 nerede, ne zaman deprem oldu?");
    expect(patch.title_neutral_prompt_version).toBe(REJECTED_MARK);
  });

  it("the ineligible extractive fallback of a question-only cluster writes the cleaned floor pick", async () => {
    dbState.clusters = [cluster("c1", { title_tr_neutral: null, article_count: 2 })];
    members("c1", ["Son dakika depremler! Deprem mi oldu? 1 Kasım 2026 nerede, ne zaman deprem oldu?"]);
    ineligible("c1");

    const GET = await getHandler();
    const res = await GET(req("203.0.113.38"));
    const body = (await res.json()) as { clusters: Record<string, { status: string }> };
    expect(body.clusters.c1!.status).toBe("extractive");
    const patch = supabaseFake.calls.update("clusters")[0]!.patch as Record<string, unknown>;
    expect(patch.title_tr_neutral).toBe("Depremler. Deprem mi oldu? 1 Kasım 2026 nerede, ne zaman deprem oldu?");
  });

  it("does not judge model output by the feed-cut heuristic: a title ending in a short word is written", async () => {
    // 'Ankar' is a prefix of 'Ankara' in another member, which the gate treats
    // as a feed cut in COPIED text; a model did not truncate anything.
    llmText = "Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankar";
    dbState.clusters = [cluster("c1")];
    members("c1", [
      "Erdoğan, Türk Devletleri Teşkilatı zirvesi için Ankara'ya geliyor",
      "Türk Devletleri Teşkilatı zirvesi Ankara'da toplanıyor",
    ]);
    eligible("c1");

    const GET = await getHandler();
    const res = await GET(req("203.0.113.39"));
    const body = (await res.json()) as { rewrote: number; clusters: Record<string, { status: string }> };
    expect(body.clusters.c1!.status).toBe("rewrote");
    expect(body.rewrote).toBe(1);
  });

  it("a rejected cluster is not sent to the LLM again on the next run, and is not billed twice", async () => {
    llmText = "Bakırköy soruşturması neden başladı, kim tutuklandı?";
    dbState.clusters = [cluster("c1", { title_tr_neutral: "Zaten var olan başlık" })];
    members("c1", MEMBERS);
    eligible("c1");

    const GET = await getHandler();
    await GET(req("203.0.113.42"));
    expect(llmFetchSpy).toHaveBeenCalledTimes(1);
    expect(supabaseFake.calls.rpc.filter((c) => c.name === "llm_budget_add")).toHaveLength(1);

    // The database now holds what the route wrote.
    const patch = supabaseFake.calls.update("clusters")[0]!.patch as { title_neutral_prompt_version: string };
    dbState.clusters[0]!.title_neutral_prompt_version = patch.title_neutral_prompt_version;

    const second = await GET(req("203.0.113.43"));
    expect(second.status).toBe(200);
    expect(llmFetchSpy).toHaveBeenCalledTimes(1);
    expect(supabaseFake.calls.rpc.filter((c) => c.name === "llm_budget_add")).toHaveLength(1);
  });

  it("the pick query excludes a cluster rejected under the CURRENT prompt version only, and keeps null versions", async () => {
    dbState.clusters = [];
    const GET = await getHandler();
    await GET(req("203.0.113.44"));
    expect(dbState.pickOrFilters).toHaveLength(1);
    const filter = dbState.pickOrFilters[0]!.join(",");
    // NULL must stay in the set: `col <> 'x'` alone drops it in SQL.
    expect(filter).toContain("title_neutral_prompt_version.is.null");
    expect(filter).toContain(`title_neutral_prompt_version.neq."${HEADLINE_PROMPT_VERSION}:rejected"`);
  });

  it("an older prompt version's rejection mark does not hide the cluster", async () => {
    llmText = "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı";
    dbState.clusters = [cluster("c1", { title_neutral_prompt_version: "2020-01-01.1:rejected" })];
    members("c1", MEMBERS);
    eligible("c1");

    const GET = await getHandler();
    await GET(req("203.0.113.45"));
    expect(llmFetchSpy).toHaveBeenCalledTimes(1);
  });

  it("an acceptable rewrite is still written as before (no stamp, title_neutral_at set)", async () => {
    llmText = "Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı";
    dbState.clusters = [cluster("c1")];
    members("c1", MEMBERS);
    eligible("c1");

    const GET = await getHandler();
    const res = await GET(req("203.0.113.34"));
    const body = (await res.json()) as { rewrote: number; clusters: Record<string, { status: string }> };
    expect(body.rewrote).toBe(1);
    expect(body.clusters.c1!.status).toBe("rewrote");
    const patch = supabaseFake.calls.update("clusters")[0]!.patch as Record<string, unknown>;
    expect(patch.title_tr_neutral).toBe(llmText);
    expect(typeof patch.title_neutral_at).toBe("string");
    expect("title_neutral_member_count" in patch).toBe(false);
  });

  it("the extractive fallback of an ineligible cluster stamps title_neutral_member_count with its article_count", async () => {
    dbState.clusters = [cluster("c1", { title_tr_neutral: null, article_count: 40 })];
    members("c1", MEMBERS);
    ineligible("c1");

    const GET = await getHandler();
    await GET(req("203.0.113.35"));
    const patch = supabaseFake.calls.update("clusters")[0]!.patch as Record<string, unknown>;
    expect(patch.title_neutral_member_count).toBe(40);
    expect(patch.title_neutral_model).toBe(EXTRACTIVE_MODEL_ID);
  });

  it("no update payload in llm mode contains updated_at", async () => {
    dbState.clusters = [cluster("c1"), cluster("c2"), cluster("c3", { title_tr_neutral: null })];
    members("c1", MEMBERS);
    members("c2", MEMBERS);
    members("c3", MEMBERS);
    eligible("c1");
    eligible("c2");
    ineligible("c3");
    llmText = "Bakırköy soruşturması neden başladı, kim tutuklandı?";

    const GET = await getHandler();
    await GET(req("203.0.113.36"));
    const updates = supabaseFake.calls.update("clusters");
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(Object.keys(u.patch as object)).not.toContain("updated_at");
  });
});

describe("GET /api/cron/headline — llm mode, zero candidates (E10-GATE-MISSED)", () => {
  it("still writes llm_budget_gate once with eligible:0, ineligible:0 when there are no candidates", async () => {
    dbState.clusters = [];

    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toBe("no candidates");

    const gateCalls = supabaseFake.calls.rpc.filter((c) => c.name === "llm_budget_gate");
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0]!.args).toEqual({
      p_day: utcDay(),
      p_eligible: 0,
      p_ineligible: 0,
    });
  });
});

describe("GET /api/cron/headline — extractive mode", () => {
  it("never calls headline_llm_eligible, llm_budget_add or llm_budget_gate", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    dbState.clusters = [cluster("c1", { title_tr_neutral: null, article_count: 2 })];
    members("c1", ["Şok! Bomba açıklama!", "Açıklama netleşti, detaylar geldi"]);

    const GET = await getHandler();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("extractive");

    const names = supabaseFake.calls.rpc.map((c) => c.name);
    expect(names).not.toContain("headline_llm_eligible");
    expect(names).not.toContain("llm_budget_add");
    expect(names).not.toContain("llm_budget_gate");
    expect(llmFetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/headline — auth (B7 gate must never run before auth)", () => {
  it("still 503s with no CRON_SECRET and 401s on a bad bearer before any gate work", async () => {
    delete process.env.CRON_SECRET;
    const GET = await getHandler();
    const res503 = await GET(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer anything", "x-forwarded-for": "203.0.113.40" },
      }),
    );
    expect(res503.status).toBe(503);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
    expect(supabaseFake.calls.mutations).toHaveLength(0);

    process.env.CRON_SECRET = "shhh";
    const res401 = await GET(
      new Request("http://example.com/api/cron/headline", {
        headers: { Authorization: "Bearer wrong-token", "x-forwarded-for": "203.0.113.41" },
      }),
    );
    expect(res401.status).toBe(401);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
  });
});
