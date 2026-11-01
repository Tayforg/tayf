import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EXTRACTIVE_MODEL_ID } from "@/lib/clusters/neutral-title";

// ---------------------------------------------------------------------------
// Extractive mode of GET /api/cron/headline: the unchanged IS NULL pick plus
// the bounded re-pick of older extractive titles (migration 141,
// neutral_title_repick_candidates). The re-pick:
//   * runs only in extractive mode, only after the IS NULL pass, only while
//     the run is younger than 40 s, and only with what is left of the
//     50-write budget (at most 20),
//   * stamps title_neutral_member_count with the cluster's article_count,
//   * writes title_tr_neutral only when the new pick differs, and the pick is
//     conservative (hunt 16, extractive-v3): the stored title is passed as the
//     incumbent and is kept unless it fails the acceptance gate or the best
//     member title beats it by REPICK_MARGIN (under 45 characters) or
//     REPICK_MARGIN_FULL_LENGTH (45 and up). A kept title stamps the model and
//     the member count only,
//   * never writes updated_at (it orders the home feed) and never touches a
//     row whose title_neutral_at is set (an LLM title).
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
}

interface MemberTitle {
  title: string;
  published_at: string | null;
}

interface RepickRow {
  id: string;
  title_tr_neutral: string;
  article_count: number;
  title_neutral_member_count: number | null;
}

const dbState = vi.hoisted(() => ({
  clusters: [] as ClusterRow[],
  membersByCluster: {} as Record<string, MemberTitle[]>,
  repickRows: [] as RepickRow[],
  repickError: false,
  memberFetchErrorFor: new Set<string>(),
  updateErrorFor: new Map<string, { message: string; code?: string }>(),
  /** Reject any update whose patch carries the stamp column (migration 141 not applied). */
  stampColumnMissing: false,
  memberFetchLimits: [] as Array<number | null>,
  /** Added to Date.now() once the IS NULL pick resolved (simulates a slow run). */
  clockOffsetMs: 0,
  slowAfterPick: false,
  clockOffsetActive: false,
}));

const holder = vi.hoisted(() => ({ calls: null as null | { mutations: Array<{ table: string; op: string; patch: unknown; state: { eq: Array<{ col: string; val: unknown }>; is: Array<{ col: string; val: unknown }> } }> } }));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  const fake = helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        const idEq = state.eq.find((e) => e.col === "id");
        if (idEq) {
          // An update (the IS NULL pick never filters by id).
          const last = holder.calls?.mutations.at(-1);
          const patch = (last?.patch ?? {}) as Record<string, unknown>;
          if (dbState.stampColumnMissing && "title_neutral_member_count" in patch) {
            return { data: null, error: { message: "Could not find the column", code: "PGRST204" } };
          }
          const forced = dbState.updateErrorFor.get(idEq.val as string);
          if (forced) return { data: null, error: forced };
          return { data: null, error: null };
        }
        if (dbState.slowAfterPick) dbState.clockOffsetActive = true;
        return { data: dbState.clusters, error: null };
      },
      cluster_articles: (state) => {
        dbState.memberFetchLimits.push(state.limit);
        const clusterIdEq = state.eq.find((e) => e.col === "cluster_id");
        const id = clusterIdEq?.val as string | undefined;
        if (id && dbState.memberFetchErrorFor.has(id)) {
          return { data: null, error: { message: "member fetch failed" } };
        }
        const members = (id ? dbState.membersByCluster[id] : undefined) ?? [];
        return {
          data: members.map((m) => ({ articles: { title: m.title, published_at: m.published_at } })),
          error: null,
        };
      },
    },
    rpc: {
      neutral_title_repick_candidates: () => {
        if (dbState.repickError) return { data: null, error: { message: "rpc boom" } };
        return { data: dbState.repickRows, error: null };
      },
    },
  });
  holder.calls = fake.calls as unknown as typeof holder.calls;
  return fake;
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

const ORIGINAL_ENV = { ...process.env };
const realNow = Date.now.bind(Date);

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.CRON_SECRET = "shhh";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.HEADLINE_PAUSED;

  dbState.clusters = [];
  dbState.membersByCluster = {};
  dbState.repickRows = [];
  dbState.repickError = false;
  dbState.memberFetchErrorFor = new Set();
  dbState.updateErrorFor = new Map();
  dbState.stampColumnMissing = false;
  dbState.memberFetchLimits = [];
  dbState.clockOffsetMs = 0;
  dbState.slowAfterPick = false;
  dbState.clockOffsetActive = false;

  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  revalidateTagMock.mockClear();
  captureServerExceptionMock.mockClear();
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + (dbState.clockOffsetActive ? dbState.clockOffsetMs : 0));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CRON_SECRET",
    "ANTHROPIC_API_KEY",
    "HEADLINE_PAUSED",
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
    article_count: 3,
    ...overrides,
  };
}

function members(id: string, titles: string[]): void {
  dbState.membersByCluster[id] = titles.map((t, i) => ({
    title: t,
    published_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
  }));
}

const TWO_GOOD = [
  "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı",
  "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı",
  "Bakırköy Belediyesine yönelik soruşturmada 39 şüpheli tutuklandı",
];
const BEST_OF_TWO_GOOD = "Bakırköy Belediyesi soruşturmasında 39 şüpheli tutuklandı";

function repickRow(id: string, overrides: Partial<RepickRow> = {}): RepickRow {
  return {
    id,
    title_tr_neutral: "Eski başlık",
    article_count: 8,
    title_neutral_member_count: null,
    ...overrides,
  };
}

async function getHandler() {
  const mod = await import("@/app/api/cron/headline/route");
  return mod.GET;
}

function req(ip = "203.0.113.50"): Request {
  return new Request("http://example.com/api/cron/headline", {
    headers: { Authorization: "Bearer shhh", "x-forwarded-for": ip },
  });
}

interface Body {
  success: boolean;
  mode: string;
  rewrote: number;
  errored: number;
  repicked?: number;
  repickKept?: number;
  reason?: string;
  clusters?: Record<string, { status: string; error?: string }>;
}

async function run(ip?: string): Promise<{ res: Response; body: Body }> {
  const GET = await getHandler();
  const res = await GET(req(ip));
  return { res, body: (await res.json()) as Body };
}

const clusterUpdates = () => supabaseFake.calls.update("clusters");
const repickCalls = () => supabaseFake.calls.rpc.filter((c) => c.name === "neutral_title_repick_candidates");
const patchOf = (u: { patch: unknown }) => u.patch as Record<string, unknown>;
const updateFor = (id: string) => clusterUpdates().find((u) => u.state.eq.some((e) => e.col === "id" && e.val === id));

describe("extractive re-pick: the rpc call", () => {
  it("calls neutral_title_repick_candidates once with the current model id and the default batch of 20", async () => {
    dbState.clusters = [cluster("c1", { article_count: 3 })];
    members("c1", TWO_GOOD);

    const { res } = await run("203.0.113.51");
    expect(res.status).toBe(200);
    expect(repickCalls()).toHaveLength(1);
    expect(repickCalls()[0]!.args).toEqual({ p_model: EXTRACTIVE_MODEL_ID, p_limit: 20 });
    expect(EXTRACTIVE_MODEL_ID).toBe("extractive-v3");
  });

  it("never calls it in llm mode", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    dbState.clusters = [];
    const { res } = await run("203.0.113.52");
    expect(res.status).toBe(200);
    expect(repickCalls()).toHaveLength(0);
  });

  it("runs even when the IS NULL pick found nothing", async () => {
    dbState.clusters = [];
    dbState.repickRows = [repickRow("r1")];
    members("r1", TWO_GOOD);

    const { res, body } = await run("203.0.113.53");
    expect(res.status).toBe(200);
    expect(repickCalls()).toHaveLength(1);
    expect(body.repicked).toBe(1);
    expect(body.reason).toBeUndefined();
  });

  it("returns the exact 'no candidates' body when both passes are empty", async () => {
    dbState.clusters = [];
    dbState.repickRows = [];
    const { res, body } = await run("203.0.113.54");
    expect(res.status).toBe(200);
    expect(repickCalls()).toHaveLength(1);
    expect(Object.keys(body).sort()).toEqual(
      ["budgetedOut", "eligible", "errored", "ineligible", "mode", "reason", "rewrote", "skipped", "success", "timestamp"].sort(),
    );
    expect(body).toMatchObject({
      success: true,
      mode: "extractive",
      rewrote: 0,
      skipped: 0,
      errored: 0,
      eligible: 0,
      ineligible: 0,
      budgetedOut: 0,
      reason: "no candidates",
    });
    expect(clusterUpdates()).toHaveLength(0);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("an rpc error is logged and captured, the run stays 200 and the IS NULL writes are intact", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    dbState.clusters = [cluster("c1")];
    members("c1", TWO_GOOD);
    dbState.repickError = true;

    const { res, body } = await run("203.0.113.55");
    expect(res.status).toBe(200);
    expect(body.rewrote).toBe(1);
    expect(body.errored).toBe(0);
    expect(patchOf(updateFor("c1")!).title_tr_neutral).toBe(BEST_OF_TWO_GOOD);
    expect(errorSpy).toHaveBeenCalled();
    expect(captureServerExceptionMock).toHaveBeenCalledTimes(1);
    expect(revalidateTagMock).toHaveBeenCalledWith("cluster-detail:c1", "max");
  });

  it("an rpc error with nothing else to do still answers 200 with the 'no candidates' body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbState.clusters = [];
    dbState.repickError = true;
    const { res, body } = await run("203.0.113.56");
    expect(res.status).toBe(200);
    expect(body.reason).toBe("no candidates");
  });

  it("skips the re-pick once the run is older than 40 s", async () => {
    dbState.clusters = [cluster("c1")];
    members("c1", TWO_GOOD);
    dbState.slowAfterPick = true;
    dbState.clockOffsetMs = 41_000;

    const { res } = await run("203.0.113.57");
    expect(res.status).toBe(200);
    expect(repickCalls()).toHaveLength(0);
    expect(updateFor("c1")).toBeDefined();
  });
});

describe("extractive re-pick: the write budget (at most 50 writes per run)", () => {
  function nClusters(n: number): void {
    dbState.clusters = Array.from({ length: n }, (_, i) => cluster(`c${i}`));
    for (const c of dbState.clusters) members(c.id, TWO_GOOD);
  }

  it("45 IS NULL writes leave a re-pick budget of 5", async () => {
    nClusters(45);
    const { body } = await run("203.0.113.58");
    expect(body.rewrote).toBe(45);
    expect(repickCalls()).toHaveLength(1);
    expect(repickCalls()[0]!.args).toEqual({ p_model: EXTRACTIVE_MODEL_ID, p_limit: 5 });
  });

  it("50 IS NULL writes leave no budget: the rpc is not called", async () => {
    nClusters(50);
    const { body } = await run("203.0.113.59");
    expect(body.rewrote).toBe(50);
    expect(repickCalls()).toHaveLength(0);
    expect(clusterUpdates()).toHaveLength(50);
  });

  it("never writes more than 50 rows in a run, whatever the rpc returns", async () => {
    nClusters(40);
    dbState.repickRows = Array.from({ length: 30 }, (_, i) => repickRow(`r${i}`));
    for (const r of dbState.repickRows) members(r.id, TWO_GOOD);

    const { body } = await run("203.0.113.60");
    // 40 IS NULL writes -> budget 10; the fake returns 30 rows regardless, but the
    // route asked for 10 and the function is what limits it. The route must
    // not exceed its own budget even if the function returned more.
    expect(repickCalls()[0]!.args).toEqual({ p_model: EXTRACTIVE_MODEL_ID, p_limit: 10 });
    expect(clusterUpdates().length).toBeLessThanOrEqual(50);
    expect((body.repicked ?? 0) + (body.repickKept ?? 0)).toBeLessThanOrEqual(10);
  });
});

describe("extractive re-pick: what is written", () => {
  it("a changed title writes the title, the model and the stamp, and revalidates", async () => {
    dbState.repickRows = [repickRow("r1", { title_tr_neutral: "Eski başlık", article_count: 3 })];
    members("r1", TWO_GOOD);

    const { res, body } = await run("203.0.113.61");
    expect(res.status).toBe(200);
    expect(body.repicked).toBe(1);
    expect(body.repickKept).toBe(0);
    expect(body.clusters!.r1!.status).toBe("repicked");

    const u = updateFor("r1")!;
    expect(patchOf(u)).toEqual({
      title_tr_neutral: BEST_OF_TWO_GOOD,
      title_neutral_model: EXTRACTIVE_MODEL_ID,
      title_neutral_member_count: 3,
    });
    expect(revalidateTagMock).toHaveBeenCalledWith("cluster-detail:r1", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("clusters-politics", "max");
    expect(revalidateTagMock).toHaveBeenCalledTimes(2);
  });

  it("an unchanged title writes only the model and the stamp, and revalidates nothing", async () => {
    dbState.repickRows = [repickRow("r1", { title_tr_neutral: BEST_OF_TWO_GOOD, article_count: 3 })];
    members("r1", TWO_GOOD);

    const { body } = await run("203.0.113.62");
    expect(body.repicked).toBe(0);
    expect(body.repickKept).toBe(1);
    expect(body.clusters!.r1!.status).toBe("repick-kept");

    const patch = patchOf(updateFor("r1")!);
    expect(patch).toEqual({ title_neutral_model: EXTRACTIVE_MODEL_ID, title_neutral_member_count: 3 });
    expect("title_tr_neutral" in patch).toBe(false);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("a null pick (nothing acceptable) stamps only and keeps the stored title", async () => {
    dbState.repickRows = [repickRow("r1", { title_tr_neutral: "Kısa haberler", article_count: 2 })];
    members("r1", ["100 il olacak mı, hangi ilçeler il olacak?", "POLİS BİLE ŞAŞKINA DÖNDÜ"]);

    const { body } = await run("203.0.113.63");
    expect(body.repickKept).toBe(1);
    const patch = patchOf(updateFor("r1")!);
    expect(patch).toEqual({ title_neutral_model: EXTRACTIVE_MODEL_ID, title_neutral_member_count: 2 });
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("a cluster with no members stamps only", async () => {
    dbState.repickRows = [repickRow("r1", { article_count: 4 })];
    members("r1", []);

    const { body } = await run("203.0.113.64");
    expect(body.repickKept).toBe(1);
    expect(patchOf(updateFor("r1")!)).toEqual({
      title_neutral_model: EXTRACTIVE_MODEL_ID,
      title_neutral_member_count: 4,
    });
  });

  it("stamps the cluster's article_count, not the number of titles used: 40 articles, 16 titles", async () => {
    dbState.repickRows = [repickRow("r1", { article_count: 40 })];
    members(
      "r1",
      Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? TWO_GOOD[0]! : TWO_GOOD[1]!)),
    );

    await run("203.0.113.65");
    expect(patchOf(updateFor("r1")!).title_neutral_member_count).toBe(40);
  });

  it("clamps the stamp to the smallint maximum", async () => {
    dbState.repickRows = [repickRow("r1", { article_count: 99_999 })];
    members("r1", TWO_GOOD);
    dbState.clusters = [cluster("c1", { article_count: 70_000 })];
    members("c1", TWO_GOOD);

    await run("203.0.113.66");
    expect(patchOf(updateFor("r1")!).title_neutral_member_count).toBe(32767);
    expect(patchOf(updateFor("c1")!).title_neutral_member_count).toBe(32767);
  });

  it("guards every re-pick write with title_neutral_at IS NULL (never an LLM title)", async () => {
    dbState.repickRows = [repickRow("r1"), repickRow("r2", { title_tr_neutral: BEST_OF_TWO_GOOD })];
    members("r1", TWO_GOOD);
    members("r2", TWO_GOOD);

    await run("203.0.113.67");
    const writes = clusterUpdates().filter((u) => ["r1", "r2"].includes(String(u.state.eq.find((e) => e.col === "id")?.val)));
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.state.is).toContainEqual({ col: "title_neutral_at", val: null });
    }
  });

  it("a failed member fetch marks the row errored and writes no stamp", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbState.repickRows = [repickRow("r1"), repickRow("r2")];
    members("r1", TWO_GOOD);
    members("r2", TWO_GOOD);
    dbState.memberFetchErrorFor.add("r1");

    const { res, body } = await run("203.0.113.68");
    expect(res.status).toBe(200);
    expect(body.clusters!.r1).toEqual({ status: "errored", error: "member-fetch-failed" });
    expect(updateFor("r1")).toBeUndefined();
    expect(body.clusters!.r2!.status).toBe("repicked");
    expect(captureServerExceptionMock).toHaveBeenCalledTimes(1);
  });

  it("a failed re-pick write is errored, and the other rows still run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbState.repickRows = [repickRow("r1"), repickRow("r2")];
    members("r1", TWO_GOOD);
    members("r2", TWO_GOOD);
    dbState.updateErrorFor.set("r1", { message: "update failed" });

    const { body } = await run("203.0.113.69");
    expect(body.clusters!.r1).toEqual({ status: "errored", error: "write-failed" });
    expect(body.clusters!.r2!.status).toBe("repicked");
    expect(body.repicked).toBe(1);
    expect(body.errored).toBe(1);
    expect(revalidateTagMock).not.toHaveBeenCalledWith("cluster-detail:r1", "max");
  });
});

// Hunt 16 (h16-an-1): the #156 re-pick replaced ~48% of the stored titles with
// vague fragments. The member titles are the real prod headlines of two of the
// damaged clusters, in published order.
const BEDELLI = [
  "Bedelli askerlikte yeni dönem",
  "Bedelli askerlik ve hac için bireysel emeklilik birikimi çekilebilecek",
  "Bedelli askerlik yapacaklara BES kolaylığı: Birikimden para çekilebilecek",
  "Bedelli askerliğe de hak tanındı: BES’ten para çekebilecekler",
  "Bedelli askerlikte yeni dönem",
  "Bedelli askerlik için BES birikimlerinden kısmi ödeme imkânı geliyor",
];

const ALTIN_PORTAKAL = [
  "63. Altın Portakal Film Festivali'nde En İyi Film ödülünü Taş ve Tüy kazandı",
  "Altın Portakal'da gecenin kazananı 'Taş ve Tüy' oldu, Mert Fırat ile Mehmet Günsür ödülü paylaştı",
  "Taş ve Tüy, Altın Portakal’da altı ödül kazandı",
  "Altın Portakal’da ödüller sahiplerini buldu: 'Taş ve Tüy' 6 ödülle zirvede",
  "Altın Portakal 'Taş ve Tüy'e",
  "Altın Portakal’da ödüller sahiplerini buldu: Altın Portakal’da 'Taş ve Tüy' zaferi",
  "Öykü Karayel'in ödülü alırken yaptığı bu konuşma geceye damga vurdu",
  "Altın Portakal'a \"Taş ve Tüy\" damgası! İşte tüm ödül kazananlar",
  "Altın Portakal Film Festivali'nde ödüller sahiplerini buldu!",
  "Altın Portakal sahiplerini buldu: ‘Taş ve Tüy’e 6 ödül birden",
  "63. Altın Portakal’da En İyi Film 'Taş ve Tüy' seçildi",
];

const BEDELLI_FRAGMENT = "Bedelli askerlikte yeni dönem";
const ALTIN_V1_INCUMBENT = "Taş ve Tüy, Altın Portakal’da altı ödül kazandı";
const ALTIN_FRAGMENT = "Altın Portakal 'Taş ve Tüy'e";

describe("extractive re-pick (hunt 16): the stored title is the incumbent", () => {
  it("keeps a good v1 title: only the model and the stamp are written, nothing is revalidated", async () => {
    dbState.repickRows = [repickRow("ec900023", { title_tr_neutral: ALTIN_V1_INCUMBENT, article_count: 11 })];
    members("ec900023", ALTIN_PORTAKAL);

    const { res, body } = await run("203.0.113.91");
    expect(res.status).toBe(200);
    expect(body.clusters!.ec900023!.status).toBe("repick-kept");
    expect(body.repicked).toBe(0);
    expect(body.repickKept).toBe(1);

    const patch = patchOf(updateFor("ec900023")!);
    expect(patch).toEqual({ title_neutral_model: EXTRACTIVE_MODEL_ID, title_neutral_member_count: 11 });
    expect("title_tr_neutral" in patch).toBe(false);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("replaces the #156 fragment 'Bedelli askerlikte yeni dönem' with the BES title", async () => {
    dbState.repickRows = [repickRow("97575687", { title_tr_neutral: BEDELLI_FRAGMENT, article_count: 6 })];
    members("97575687", BEDELLI);

    const { body } = await run("203.0.113.92");
    expect(body.clusters!["97575687"]!.status).toBe("repicked");
    const patch = patchOf(updateFor("97575687")!);
    expect(patch.title_tr_neutral).toMatch(/BES|birikim/i);
    expect(patch.title_tr_neutral).not.toBe(BEDELLI_FRAGMENT);
    expect(patch.title_neutral_model).toBe("extractive-v3");
    expect(patch.title_neutral_member_count).toBe(6);
    expect(revalidateTagMock).toHaveBeenCalledWith("cluster-detail:97575687", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("clusters-politics", "max");
  });

  it("replaces the #156 fragment \"Altın Portakal 'Taş ve Tüy'e\" with a >= 40-character title", async () => {
    dbState.repickRows = [repickRow("ec900023", { title_tr_neutral: ALTIN_FRAGMENT, article_count: 11 })];
    members("ec900023", ALTIN_PORTAKAL);

    const { body } = await run("203.0.113.93");
    expect(body.clusters!.ec900023!.status).toBe("repicked");
    const title = patchOf(updateFor("ec900023")!).title_tr_neutral as string;
    expect(title.length).toBeGreaterThanOrEqual(40);
    expect(title).toContain("Taş ve Tüy");
    expect(title).not.toBe(ALTIN_FRAGMENT);
  });

  it("writes no updated_at in any of these runs", async () => {
    dbState.repickRows = [
      repickRow("97575687", { title_tr_neutral: BEDELLI_FRAGMENT, article_count: 6 }),
      repickRow("ec900023", { title_tr_neutral: ALTIN_V1_INCUMBENT, article_count: 11 }),
      repickRow("ec900024", { title_tr_neutral: ALTIN_FRAGMENT, article_count: 11 }),
    ];
    members("97575687", BEDELLI);
    members("ec900023", ALTIN_PORTAKAL);
    members("ec900024", ALTIN_PORTAKAL);

    const { body } = await run("203.0.113.94");
    expect(body.repicked).toBe(2);
    expect(body.repickKept).toBe(1);
    const updates = clusterUpdates();
    expect(updates).toHaveLength(3);
    for (const u of updates) {
      expect(Object.keys(patchOf(u)), JSON.stringify(u.patch)).not.toContain("updated_at");
    }
  });

  it("keeps the stored title when its members are all unacceptable and the title itself passes the gate", async () => {
    dbState.repickRows = [repickRow("r1", { title_tr_neutral: "Eski başlık burada duruyor", article_count: 2 })];
    members("r1", ["Masterchef kim elendi, kim gitti?", "MasterChef'te kim elendi? Kim kazandı, kim gitti?"]);

    const { body } = await run("203.0.113.95");
    expect(body.clusters!.r1).toEqual({ status: "repick-kept" });
    expect("title_tr_neutral" in patchOf(updateFor("r1")!)).toBe(false);
  });

  it("the first pick passes no incumbent: an IS NULL cluster takes the best member title", async () => {
    dbState.clusters = [cluster("c1", { article_count: 6 })];
    members("c1", BEDELLI);

    const { body } = await run("203.0.113.96");
    expect(body.clusters!.c1).toEqual({ status: "rewrote" });
    expect(patchOf(updateFor("c1")!)).toEqual({
      title_tr_neutral: "Bedelli askerlik yapacaklara BES kolaylığı: Birikimden para çekilebilecek",
      title_neutral_model: EXTRACTIVE_MODEL_ID,
      title_neutral_member_count: 6,
    });
  });
});

describe("extractive IS NULL pass", () => {
  it("writes the pick, the model and the stamp, and never title_neutral_at", async () => {
    dbState.clusters = [cluster("c1", { article_count: 3 })];
    members("c1", TWO_GOOD);

    const { body } = await run("203.0.113.70");
    expect(body.rewrote).toBe(1);
    expect(patchOf(updateFor("c1")!)).toEqual({
      title_tr_neutral: BEST_OF_TWO_GOOD,
      title_neutral_model: EXTRACTIVE_MODEL_ID,
      title_neutral_member_count: 3,
    });
    // The IS NULL write keeps its old shape: filtered by id only.
    expect(updateFor("c1")!.state.is).toEqual([]);
  });

  it("a cluster whose every member fails the acceptance gate still gets the cleaned floor title, not the raw one", async () => {
    // Prod cluster 76d709e7: two SEO question headlines. Left NULL, every
    // surface shows title_tr ('Son dakika depremler! ...') and the row is
    // fetched again on every tick.
    dbState.clusters = [cluster("c1", { article_count: 2 })];
    members("c1", [
      "SON DAKİKA DEPREM 1 KASIM! Bugün deprem mi oldu, nerede, kaç şiddetinde? 1 Kasım 2026 AFAD ve Kandilli Rasathanesi son depremler listesi",
      "Son dakika depremler! Deprem mi oldu? 1 Kasım 2026 nerede, ne zaman deprem oldu?",
    ]);

    const { body } = await run("203.0.113.71");
    expect(body.clusters!.c1).toEqual({ status: "rewrote" });
    expect(patchOf(updateFor("c1")!)).toEqual({
      title_tr_neutral: "Depremler. Deprem mi oldu? 1 Kasım 2026 nerede, ne zaman deprem oldu?",
      title_neutral_model: EXTRACTIVE_MODEL_ID,
      title_neutral_member_count: 2,
    });
    expect(revalidateTagMock).toHaveBeenCalledWith("cluster-detail:c1", "max");
  });

  it("a cluster with only placeholder members has no usable title and stays an errored 'empty rewrite'", async () => {
    dbState.clusters = [cluster("c1", { article_count: 2 })];
    members("c1", ["Kısa haberler", "Son dakika"]);

    const { body } = await run("203.0.113.81");
    expect(body.clusters!.c1).toEqual({ status: "errored", error: "empty rewrite" });
    expect(updateFor("c1")).toBeUndefined();
  });

  it("the re-pick stays strict: a row that already has a title keeps it when no member is acceptable", async () => {
    dbState.repickRows = [repickRow("r1", { title_tr_neutral: "Eski başlık burada duruyor" })];
    members("r1", ["100 il olacak mı, hangi ilçeler il olacak?", "Bakırköy soruşturması neden başladı, kim tutuklandı?"]);

    const { body } = await run("203.0.113.82");
    expect(body.clusters!.r1).toEqual({ status: "repick-kept" });
    const patch = patchOf(updateFor("r1")!);
    expect("title_tr_neutral" in patch).toBe(false);
  });

  it("retries once without the stamp column on PGRST204 (141 not applied yet)", async () => {
    dbState.stampColumnMissing = true;
    dbState.clusters = [cluster("c1", { article_count: 3 })];
    members("c1", TWO_GOOD);

    const { res, body } = await run("203.0.113.72");
    expect(res.status).toBe(200);
    expect(body.rewrote).toBe(1);
    const writes = clusterUpdates().filter((u) => u.state.eq.some((e) => e.col === "id" && e.val === "c1"));
    expect(writes).toHaveLength(2);
    expect("title_neutral_member_count" in patchOf(writes[0]!)).toBe(true);
    expect(patchOf(writes[1]!)).toEqual({
      title_tr_neutral: BEST_OF_TWO_GOOD,
      title_neutral_model: EXTRACTIVE_MODEL_ID,
    });
  });

  it("does not retry on any other error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbState.clusters = [cluster("c1")];
    members("c1", TWO_GOOD);
    dbState.updateErrorFor.set("c1", { message: "boom", code: "23505" });

    const { body } = await run("203.0.113.73");
    expect(body.clusters!.c1).toEqual({ status: "errored", error: "write-failed" });
    expect(clusterUpdates().filter((u) => u.state.eq.some((e) => e.val === "c1"))).toHaveLength(1);
  });
});

describe("member fetch", () => {
  it("asks for up to 200 members in both passes", async () => {
    dbState.clusters = [cluster("c1")];
    members("c1", TWO_GOOD);
    dbState.repickRows = [repickRow("r1")];
    members("r1", TWO_GOOD);

    await run("203.0.113.74");
    expect(dbState.memberFetchLimits).toEqual([200, 200]);
  });

  it("passes every fetched member to the picker, not just the newest 16", async () => {
    // 17 unacceptable (question) titles, newer than the one acceptable title:
    // a pool cut to 16 would never see it.
    dbState.clusters = [cluster("c1", { article_count: 18 })];
    const titles = [
      BEST_OF_TWO_GOOD,
      ...Array.from({ length: 17 }, (_, i) => `Bu karar neden alındı, ${i + 1} numaralı soru yanıtsız mı?`),
    ];
    members("c1", titles); // published_at grows with the index: the acceptable title is the oldest
    await run("203.0.113.75");
    expect(patchOf(updateFor("c1")!).title_tr_neutral).toBe(BEST_OF_TWO_GOOD);
  });

  it("is deterministic: the same members in any order, with equal timestamps, give the same pick", async () => {
    const tied = [
      "Meclis'te bütçe görüşmeleri başladı bugün",
      "Meclis'te bütçe görüşmeleri başladı yarın",
      "Meclis'te bütçe görüşmeleri başladı dün",
    ];
    const pick = async (order: string[], ip: string) => {
      supabaseFake.calls.mutations.length = 0;
      dbState.clusters = [cluster("c1", { article_count: 3 })];
      dbState.membersByCluster["c1"] = order.map((title) => ({ title, published_at: "2026-01-01T00:00:00Z" }));
      await run(ip);
      return patchOf(updateFor("c1")!).title_tr_neutral;
    };
    const a = await pick(tied, "203.0.113.76");
    const b = await pick([...tied].reverse(), "203.0.113.77");
    const c = await pick([tied[1]!, tied[2]!, tied[0]!], "203.0.113.78");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("updated_at is never written", () => {
  it("no clusters update payload in a run with IS NULL, re-pick, retry and kept rows contains updated_at", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbState.clusters = [cluster("c1"), cluster("c2", { article_count: 2 })];
    members("c1", TWO_GOOD);
    members("c2", TWO_GOOD);
    dbState.repickRows = [
      repickRow("r1"),
      repickRow("r2", { title_tr_neutral: BEST_OF_TWO_GOOD }),
      repickRow("r3", { article_count: 2 }),
    ];
    members("r1", TWO_GOOD);
    members("r2", TWO_GOOD);
    members("r3", []);
    dbState.stampColumnMissing = true;

    await run("203.0.113.79");
    const updates = clusterUpdates();
    expect(updates.length).toBeGreaterThanOrEqual(5);
    for (const u of updates) {
      expect(Object.keys(patchOf(u)), JSON.stringify(u.patch)).not.toContain("updated_at");
    }
  });

  it("nor in llm mode (ineligible cluster, extractive fallback write)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    dbState.clusters = [cluster("c1")];
    members("c1", TWO_GOOD);

    const { res } = await run("203.0.113.80");
    expect(res.status).toBe(200);
    expect(clusterUpdates()).toHaveLength(1);
    expect(patchOf(clusterUpdates()[0]!)).toEqual({
      title_tr_neutral: BEST_OF_TWO_GOOD,
      title_neutral_model: EXTRACTIVE_MODEL_ID,
      title_neutral_member_count: 3,
    });
  });
});
