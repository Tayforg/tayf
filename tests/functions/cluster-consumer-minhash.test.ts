import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Tests for the minhash-persist + once-per-context TF-IDF change to
// cluster-consumer. Scaffolding mirrors tests/functions/cluster-consumer.test.ts
// (Deno polyfill, authedRequest, pgmq mock, shared Supabase fake); see that
// file for the rationale behind each piece. What's different here:
//
//   * Every test starts from a COLD module (vi.resetModules() + re-import)
//     so the module-level clusterContextCache (60s TTL) never leaks state
//     from a previous test.
//   * fingerprint.ts is mocked as a passthrough-with-spy so we can assert
//     `fingerprint` was (or wasn't) called for a given article — the whole
//     point of the persisted-signature reuse path. (minhashSignature is NOT
//     spied: it's a module-local binding inside fingerprint.ts that its own
//     `fingerprint()` calls directly, which ESM mocking cannot intercept —
//     a spy on the named export would always read 0 calls regardless of
//     reuse, so `fingerprint`'s own call count is the only reliable signal.)
//   * tfidf.ts is mocked with a counting subclass so we can assert the
//     context's TfidfIndex is constructed once per context load and
//     queried once per incoming article, not rebuilt per message.
// ---------------------------------------------------------------------------

(globalThis as unknown as { Deno?: unknown }).Deno = {
  env: {
    get: (k: string) => process.env[k],
  },
  serve: (handler: (req: Request) => Promise<Response> | Response) => {
    (globalThis as unknown as { __registeredHandler?: unknown }).__registeredHandler = handler;
    return { finished: Promise.resolve() };
  },
};

const TEST_SERVICE_ROLE_KEY = "test-service-role-key";

function authedRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${TEST_SERVICE_ROLE_KEY}`,
    },
  });
}

interface PgmqMessage {
  msg_id: number;
  read_ct: number;
  message: { article_id: string };
}

const pgmqState: {
  pending: PgmqMessage[];
  archived: number[];
  deleted: number[];
} = { pending: [], archived: [], deleted: [] };

function resetPgmqState() {
  pgmqState.pending = [];
  pgmqState.archived = [];
  pgmqState.deleted = [];
}

vi.mock("../../supabase/functions/_shared/pgmq.ts", () => ({
  readBatch: vi.fn(
    async (_client: unknown, _queue: string, _vt: number, qty: number) => {
      const batch = pgmqState.pending.slice(0, qty);
      pgmqState.pending = pgmqState.pending.slice(qty);
      return batch;
    },
  ),
  archive: vi.fn(
    async (_client: unknown, _queue: string, msgId: number) => {
      pgmqState.archived.push(msgId);
      return true;
    },
  ),
  deleteMessage: vi.fn(
    async (_client: unknown, _queue: string, msgId: number) => {
      pgmqState.deleted.push(msgId);
      return true;
    },
  ),
  send: vi.fn(
    async (_client: unknown, _queue: string, _payload: unknown) => 1,
  ),
  queueDepth: vi.fn(
    async (_client: unknown, _queue: string) => ({
      depth: pgmqState.pending.length,
      oldest_msg_age_sec: null,
    }),
  ),
}));

// Shared counters for the TfidfIndex counting subclass below. vi.hoisted so
// the value exists before the vi.mock factory that references it runs.
const counters = vi.hoisted(() => ({ ctor: 0, query: 0 }));

// Fixtures + the shared chainable Supabase fake, built once at module-hoist
// time (same pre-import phase vi.mock factories run in). SEED/INCOMING/
// INCOMING2 are plain objects tests mutate in place (e.g. SEED.minhash_sig)
// before populating fakeArticles and draining.
const {
  fakeArticles,
  supabaseFakeClient,
  supabaseFakeCalls,
  SEED,
  INCOMING,
  INCOMING2,
} = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  const now = new Date().toISOString();
  const articles: Record<string, unknown> = {};

  const seed = {
    id: "art-seed",
    source_id: "src-outlet",
    title: "Diyanet Cuma hutbesinde Ramazan açıklaması yaptı",
    description:
      "Diyanet İşleri Başkanlığı camide okunan hutbede Ramazan ayına değindi",
    category: "politika",
    published_at: now,
    // Non-null so the strict-fingerprint fast path can never hit — every
    // test in this file must route through the ensemble/candidate path.
    fingerprint: "seed-fp-placeholder",
    entities: [] as string[],
    minhash_sig: null as number[] | null,
    minhash_version: null as number | null,
  };

  const incoming = {
    id: "art-in",
    source_id: "src-wire",
    title: "MHP İstanbul'da il teşkilatını feshetti",
    description:
      "MHP Genel Başkanı Bahçeli İstanbul il teşkilatının feshedildiğini açıkladı",
    category: "politika",
    published_at: now,
  };

  const incoming2 = {
    id: "art-in2",
    source_id: "src-agg",
    title: "TCMB faiz kararını 2024 yılında açıkladı",
    description:
      "Merkez Bankası yüzde 47 seviyesindeki politika faizini sabit tuttu",
    category: "politika",
    published_at: now,
  };

  const clusters = [
    { id: "c1", title_tr: seed.title, first_published: now, updated_at: now, article_count: 1 },
  ];
  const cluster_articles = [{ cluster_id: "c1", article_id: "art-seed" }];

  const fake = helper.createSupabaseFake({
    tables: {
      articles: (state) => {
        const eqId = state.eq.find((p) => p.col === "id")?.val as
          | string
          | undefined;
        if (eqId !== undefined) {
          const row = articles[eqId] ?? null;
          return { data: row, error: null, count: row ? 1 : 0 };
        }
        const inIds = state.in.find((p) => p.col === "id")?.vals as
          | string[]
          | undefined;
        if (inIds && inIds.length > 0) {
          const rows = inIds
            .map((id) => articles[id])
            .filter((r): r is unknown => r !== undefined);
          return { data: rows, error: null, count: rows.length };
        }
        return {
          data: Object.values(articles),
          error: null,
          count: Object.keys(articles).length,
        };
      },
      clusters,
      cluster_articles,
      sources: [
        { id: "src-outlet", bias: "pro_government", name: "Outlet", slug: "outlet", kind: "outlet" },
        { id: "src-agg", bias: "center", name: "Aggregator", slug: "agg", kind: "aggregator" },
        { id: "src-wire", bias: "state_media", name: "Wire", slug: "wire", kind: "wire" },
      ],
    },
  });

  return {
    fakeArticles: articles,
    supabaseFakeClient: fake.client,
    supabaseFakeCalls: fake.calls,
    SEED: seed,
    INCOMING: incoming,
    INCOMING2: incoming2,
  };
});

vi.mock("../../supabase/functions/_shared/supabase.ts", () => ({
  createServiceClient: () => supabaseFakeClient,
}));

// Passthrough-with-spies: keep every real export (deserializeSignature,
// serializeSignature, MINHASH_VERSION, strictFingerprint, titleTokens, ...)
// but wrap `fingerprint` and `minhashSignature` so tests can assert whether
// the consumer recomputed a signature or reused a stored one.
vi.mock(
  "../../supabase/functions/_shared/cluster/fingerprint.ts",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../supabase/functions/_shared/cluster/fingerprint.ts")
    >();
    return {
      ...actual,
      fingerprint: vi.fn(actual.fingerprint),
    };
  },
);

// Counting subclass: real behaviour (extends the actual TfidfIndex, calls
// super for both the constructor and query()) plus a shared tally so tests
// can assert the context builds the index once and queries it per message.
vi.mock(
  "../../supabase/functions/_shared/cluster/tfidf.ts",
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import("../../supabase/functions/_shared/cluster/tfidf.ts")
    >();
    class CountingTfidfIndex extends actual.TfidfIndex {
      constructor() {
        super();
        counters.ctor++;
      }
      override query(text: string | null | undefined, selfId?: string) {
        counters.query++;
        return super.query(text, selfId);
      }
    }
    return { ...actual, TfidfIndex: CountingTfidfIndex };
  },
);

vi.mock("../../supabase/functions/_shared/cluster/ensemble.ts", () => ({
  score: vi.fn((_a: unknown, _b: unknown) => ({
    score: 0.82,
    components: { cosine: 0.8, entityJaccard: 0.7, fingerprintMatch: true },
    isMatch: true,
  })),
  isMatch: (s: number | { score: number } | null | undefined): boolean => {
    if (s == null) return false;
    return typeof s === "number" ? s >= 0.5 : s.score >= 0.5;
  },
}));

beforeEach(() => {
  // Cold module every test: the SUT's module-level clusterContextCache must
  // not survive from a previous test, or the "signature reuse" / "built
  // once" assertions would be exercising a warm cache instead of a fresh
  // loadClusterContext() call.
  vi.resetModules();
  counters.ctor = 0;
  counters.query = 0;
  resetPgmqState();
  for (const k of Object.keys(fakeArticles)) delete fakeArticles[k];
  supabaseFakeCalls.mutations.length = 0;
  supabaseFakeCalls.rpc.length = 0;
  SEED.minhash_sig = null;
  SEED.minhash_version = null;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SERVICE_ROLE_KEY;
  delete process.env.REVALIDATE_URL;
  delete process.env.CRON_SECRET;
});

async function importHandler(): Promise<((req: Request) => Promise<Response>) | null> {
  await import("../../supabase/functions/cluster-consumer/index.ts");
  const reg = (globalThis as unknown as {
    __registeredHandler?: (req: Request) => Promise<Response>;
  }).__registeredHandler;
  return reg ?? null;
}

// Grabs the LIVE fingerprint.ts module instance for the module graph the
// most recent importHandler() call resolved — must be called after
// importHandler() (not hoisted to a top-level import) because
// vi.resetModules() gives each test's SUT import a fresh module instance
// with fresh vi.fn() spies.
async function fingerprintModule() {
  return await import("../../supabase/functions/_shared/cluster/fingerprint.ts");
}

describe("cluster-consumer minhash persistence + once-per-context TF-IDF", () => {
  it("persistEnrichment writes minhash_sig + minhash_version", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const fp = await fingerprintModule();
    const expectedSig = fp.fingerprint(INCOMING.title, INCOMING.description).signature;

    fakeArticles[SEED.id] = { ...SEED };
    fakeArticles[INCOMING.id] = { ...INCOMING };

    // Fixture-time fingerprint() calls above must not pollute the
    // assertions below.
    vi.clearAllMocks();

    pgmqState.pending = [
      { msg_id: 1, read_ct: 1, message: { article_id: INCOMING.id } },
    ];

    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

    const updateCall = supabaseFakeCalls
      .update("articles")
      .find((c) => c.state.eq.some((p) => p.col === "id" && p.val === INCOMING.id));
    expect(updateCall).toBeDefined();

    const patch = updateCall!.patch as { minhash_sig: number[]; minhash_version: number };
    expect(patch.minhash_version).toBe(fp.MINHASH_VERSION);
    expect(Array.isArray(patch.minhash_sig)).toBe(true);
    expect(patch.minhash_sig.length).toBe(64);
    for (const v of patch.minhash_sig) {
      expect(Number.isInteger(v)).toBe(true);
    }

    const roundTripped = fp.deserializeSignature(patch.minhash_sig, patch.minhash_version);
    expect(roundTripped).not.toBeNull();
    expect(Array.from(roundTripped as Uint32Array)).toEqual(Array.from(expectedSig));
  });

  it("a stored valid signature is reused for the seed (no recompute)", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const fp = await fingerprintModule();
    // Deliberately the INCOMING text's signature, not SEED's own — a match
    // is only reachable if the consumer actually reuses the stored value
    // instead of recomputing SEED's real (unrelated) signature.
    const incomingSig = fp.fingerprint(INCOMING.title, INCOMING.description).signature;
    SEED.minhash_sig = fp.serializeSignature(incomingSig);
    SEED.minhash_version = fp.MINHASH_VERSION;

    fakeArticles[SEED.id] = { ...SEED };
    fakeArticles[INCOMING.id] = { ...INCOMING };

    vi.clearAllMocks();

    pgmqState.pending = [
      { msg_id: 2, read_ct: 1, message: { article_id: INCOMING.id } },
    ];

    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

    const linkCalls = supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_link_atomic");
    expect(linkCalls.length).toBeGreaterThan(0);
    expect(
      (linkCalls[linkCalls.length - 1].args as { p_cluster_id?: string }).p_cluster_id,
    ).toBe("c1");

    const fingerprintSpy = fp.fingerprint as unknown as { mock: { calls: unknown[][] } };
    // Exactly one recompute (INCOMING) — SEED's stored signature must be
    // reused, not just "SEED wasn't the only call": pin the full call list
    // so a second, unexpected recompute of SEED would also fail this.
    expect(fingerprintSpy.mock.calls.map((args) => args[0])).toEqual([INCOMING.title]);

    expect(pgmqState.archived).toContain(2);
  });

  it("a stale-version stored signature is ignored and recomputed", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const fp = await fingerprintModule();
    const incomingSig = fp.fingerprint(INCOMING.title, INCOMING.description).signature;
    SEED.minhash_sig = fp.serializeSignature(incomingSig);
    SEED.minhash_version = 0; // stale — MINHASH_VERSION is 1

    fakeArticles[SEED.id] = { ...SEED };
    fakeArticles[INCOMING.id] = { ...INCOMING };

    vi.clearAllMocks();

    pgmqState.pending = [
      { msg_id: 3, read_ct: 1, message: { article_id: INCOMING.id } },
    ];

    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

    const fingerprintSpy = fp.fingerprint as unknown as { mock: { calls: unknown[][] } };
    // Both SEED (stale version → ignored, recomputed) and INCOMING (always
    // recomputed) go through fingerprint() — order matches drainQueue's
    // upfront getClusterContext() (attachSignature on SEED) running before
    // enrichArticleInMemory on the dequeued INCOMING message.
    expect(fingerprintSpy.mock.calls.map((args) => args[0])).toEqual([
      SEED.title,
      INCOMING.title,
    ]);

    const linkCalls = supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_link_atomic");
    expect(linkCalls.length).toBe(0);
    expect(supabaseFakeCalls.insert("clusters").length).toBe(1);
  });

  it("TF-IDF index is built once per context for two processed messages", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const fp = await fingerprintModule();
    // Seed carries a stored signature of its OWN text so attachSignature
    // takes the reuse path (this test isn't about matching — it's about the
    // TfidfIndex construction/query counts).
    const ownSig = fp.fingerprint(SEED.title, SEED.description).signature;
    SEED.minhash_sig = fp.serializeSignature(ownSig);
    SEED.minhash_version = fp.MINHASH_VERSION;

    fakeArticles[SEED.id] = { ...SEED };
    fakeArticles[INCOMING.id] = { ...INCOMING };
    fakeArticles[INCOMING2.id] = { ...INCOMING2 };

    vi.clearAllMocks();
    counters.ctor = 0;
    counters.query = 0;

    // BATCH_SIZE is 2, so both messages come back in a single readBatch.
    pgmqState.pending = [
      { msg_id: 4, read_ct: 1, message: { article_id: INCOMING.id } },
      { msg_id: 5, read_ct: 1, message: { article_id: INCOMING2.id } },
    ];

    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

    expect(counters.ctor).toBe(1);
    expect(counters.query).toBe(2);
    expect(pgmqState.archived).toEqual(expect.arrayContaining([4, 5]));
  });
});
