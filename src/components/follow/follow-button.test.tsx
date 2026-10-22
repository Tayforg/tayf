import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { FollowButton, FollowButtonView } from "./follow-button";
import { FOLLOWS_CHANGE_EVENT, FOLLOWS_KEY, MAX_FOLLOWS } from "@/lib/follows/follows";
import { HomeFeed } from "@/app/page";
import TopicHubPage from "@/app/konu/[slug]/page";
import type { PoliticsClustersResult } from "@/lib/clusters/politics-query";

// Entry-point wiring (home search + /konu/[slug]) is checked against the page
// trees, with the same readers mocked as src/app/page.test.tsx and
// src/app/konu/[slug]/page.test.tsx.
vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));
const readers = vi.hoisted(() => ({
  getPoliticsClusters: vi.fn(),
  searchClusters: vi.fn(),
}));
vi.mock("@/lib/clusters/politics-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/politics-query")>();
  return { ...actual, getPoliticsClusters: () => readers.getPoliticsClusters() };
});
vi.mock("@/lib/clusters/search-query", () => ({
  searchClusters: (q: string) => readers.searchClusters(q),
}));
vi.mock("@/lib/clusters/topic-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/topic-query")>();
  return { ...actual, getTopicClusters: () => Promise.resolve(null) };
});

// ---------------------------------------------------------------------------
// The vitest environment is "node" (no DOM), so the component is covered two
// ways: renderToStaticMarkup for what SSR / first paint emits, and a stubbed
// window + localStorage for the external store behind useFollows (the part
// that matters: cross-tab sync, no lost writes, no write on read).
// ---------------------------------------------------------------------------

describe("FollowButton -- server render", () => {
  it("renders 'Takip et' for a topic without touching window", () => {
    expect(typeof window).toBe("undefined");
    const markup = renderToStaticMarkup(<FollowButton kind="konu" value="ekonomi" />);
    expect(markup).toContain("Takip et");
    expect(markup).not.toContain("Takip ediliyor");
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('type="button"');
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain('href="/takip"');
  });

  it("renders for a valid keyword and escapes nothing it should not render", () => {
    const markup = renderToStaticMarkup(<FollowButton kind="q" value="  Seçim " />);
    expect(markup).toContain("Takip et");
    // The keyword is never written into the markup (it is only a button label).
    expect(markup).not.toContain("seçim");
  });

  it.each([
    ["q", "a"],
    ["q", ""],
    ["q", "   "],
    ["q", "x".repeat(41)],
    ["q", "\u0000ab"],
    ["konu", "politika"],
    ["konu", "../x"],
    ["konu", "Ekonomi"],
  ] as const)("renders nothing for an invalid %s value %j", (kind, value) => {
    expect(renderToStaticMarkup(<FollowButton kind={kind} value={value} />)).toBe("");
  });

  it("renders nothing for a non-string value instead of throwing", () => {
    expect(
      renderToStaticMarkup(
        <FollowButton kind="q" value={123 as unknown as string} />,
      ),
    ).toBe("");
  });

  it("passes className through to the button", () => {
    const markup = renderToStaticMarkup(
      <FollowButton kind="konu" value="spor" className="extra-class" />,
    );
    expect(markup).toContain("extra-class");
  });
});

describe("FollowButtonView -- states", () => {
  it("not followed: 'Takip et', pressed=false, no companion link", () => {
    const markup = renderToStaticMarkup(
      <FollowButtonView followed={false} full={false} onToggle={() => {}} />,
    );
    expect(markup).toContain("Takip et");
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain("Takip ettiklerim");
    expect(markup).not.toContain('disabled=""');
  });

  it("followed: 'Takip ediliyor', pressed=true, plus a /takip companion link", () => {
    const markup = renderToStaticMarkup(
      <FollowButtonView followed full={false} onToggle={() => {}} />,
    );
    expect(markup).toContain("Takip ediliyor");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('href="/takip"');
    expect(markup).toContain("Takip ettiklerim");
  });

  it("full and not followed: disabled with the explanatory title", () => {
    const markup = renderToStaticMarkup(
      <FollowButtonView followed={false} full onToggle={() => {}} />,
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain(
      "En fazla 20 takip; /takip sayfasından birini çıkarın.",
    );
    expect(MAX_FOLLOWS).toBe(20);
  });

  it("full but followed: stays enabled so the reader can unfollow", () => {
    const markup = renderToStaticMarkup(
      <FollowButtonView followed full onToggle={() => {}} />,
    );
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain("En fazla 20 takip");
  });
});

describe("use-client boundaries", () => {
  const read = (name: string) =>
    readFileSync(resolve(__dirname, name), "utf8").trimStart();

  it.each(["follow-button.tsx", "use-follows.ts", "follow-feed.tsx"])(
    "%s is a client module",
    (name) => {
      expect(read(name).startsWith('"use client"')).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// followsStore -- the external store behind useFollows
// ---------------------------------------------------------------------------

type Listener = (ev: { type: string; key?: string | null }) => void;

interface Harness {
  storage: Map<string, string>;
  setItem: ReturnType<typeof vi.fn>;
  getItem: ReturnType<typeof vi.fn>;
  fire: (type: string, key?: string | null) => void;
  listenerCount: () => number;
  failWrites: (on: boolean) => void;
}

function installBrowser(): Harness {
  const storage = new Map<string, string>();
  const listeners = new Map<string, Set<Listener>>();
  let failWrites = false;

  const getItem = vi.fn((k: string) => (storage.has(k) ? storage.get(k)! : null));
  const setItem = vi.fn((k: string, v: string) => {
    if (failWrites) throw new Error("QuotaExceededError");
    storage.set(k, v);
  });

  const win = {
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (ev: { type: string }) => {
      for (const fn of [...(listeners.get(ev.type) ?? [])]) fn(ev);
      return true;
    },
  };

  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", { getItem, setItem, removeItem: (k: string) => storage.delete(k) });

  return {
    storage,
    setItem,
    getItem,
    fire: (type, key) => win.dispatchEvent({ type, key } as { type: string }),
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    failWrites: (on) => {
      failWrites = on;
    },
  };
}

async function loadStore() {
  vi.resetModules();
  const mod = await import("./use-follows");
  return mod.followsStore;
}

describe("followsStore", () => {
  let h: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T09:00:00.000Z"));
    h = installBrowser();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts empty, with a frozen, stable server snapshot", async () => {
    const store = await loadStore();
    expect(store.read()).toEqual([]);
    const server = store.getServerSnapshot();
    expect(server).toEqual([]);
    expect(Object.isFrozen(server)).toBe(true);
    expect(store.getServerSnapshot()).toBe(server);
  });

  it("returns the SAME reference while storage is unchanged (useSyncExternalStore contract)", async () => {
    h.storage.set(FOLLOWS_KEY, JSON.stringify([{ kind: "q", value: "seçim", addedAt: null, seenAt: null }]));
    const store = await loadStore();
    const a = store.read();
    const b = store.read();
    expect(a).toBe(b);
    expect(a).toHaveLength(1);
  });

  it("never writes while reading, even for legacy or corrupt data", async () => {
    h.storage.set(FOLLOWS_KEY, '["Seçim"]');
    const store = await loadStore();
    store.read();
    expect(h.setItem).not.toHaveBeenCalled();
    h.storage.set(FOLLOWS_KEY, "{oops");
    expect(store.read()).toEqual([]);
    expect(h.setItem).not.toHaveBeenCalled();
  });

  it("toggle adds, persists, stamps addedAt = seenAt = now, and notifies subscribers", async () => {
    const store = await loadStore();
    const onChange = vi.fn();
    store.subscribe(onChange);

    expect(store.toggle("konu", "ekonomi")).toBe("added");

    expect(onChange).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(h.storage.get(FOLLOWS_KEY)!) as unknown[];
    expect(saved).toEqual([
      {
        kind: "konu",
        value: "ekonomi",
        addedAt: "2026-10-22T09:00:00.000Z",
        seenAt: "2026-10-22T09:00:00.000Z",
      },
    ]);
    expect(store.read()).toHaveLength(1);
  });

  it("toggle on an existing follow removes it", async () => {
    const store = await loadStore();
    store.toggle("q", "Seçim");
    expect(store.toggle("q", "  SEÇİM ")).toBe("removed");
    expect(h.storage.get(FOLLOWS_KEY)).toBe("[]");
    expect(store.read()).toEqual([]);
  });

  it("rapid back-to-back toggles never lose a write (mutations re-read storage)", async () => {
    const store = await loadStore();
    store.toggle("q", "birinci");
    store.toggle("q", "ikinci");
    store.toggle("konu", "spor");
    const saved = JSON.parse(h.storage.get(FOLLOWS_KEY)!) as Array<{ value: string }>;
    expect(saved.map((f) => f.value)).toEqual(["birinci", "ikinci", "spor"]);
  });

  it("picks up a write from another tab before applying its own change", async () => {
    const store = await loadStore();
    store.toggle("q", "bu sekme");
    // Another tab writes while this tab's cached list is stale.
    h.storage.set(
      FOLLOWS_KEY,
      JSON.stringify([
        { kind: "q", value: "bu sekme", addedAt: null, seenAt: null },
        { kind: "q", value: "diger sekme", addedAt: null, seenAt: null },
      ]),
    );
    store.toggle("konu", "dunya");
    const saved = JSON.parse(h.storage.get(FOLLOWS_KEY)!) as Array<{ value: string }>;
    expect(saved.map((f) => f.value)).toEqual(["bu sekme", "diger sekme", "dunya"]);
  });

  it("does not write or notify for invalid input", async () => {
    const store = await loadStore();
    const onChange = vi.fn();
    store.subscribe(onChange);
    expect(store.toggle("q", "a")).toBe("invalid");
    expect(store.toggle("konu", "politika")).toBe("invalid");
    expect(h.setItem).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("refuses the 21st follow with 'full' and writes nothing", async () => {
    const store = await loadStore();
    for (let i = 0; i < MAX_FOLLOWS; i++) {
      expect(store.toggle("q", `kelime ${i}`)).toBe("added");
    }
    h.setItem.mockClear();
    expect(store.toggle("q", "fazla kelime")).toBe("full");
    expect(h.setItem).not.toHaveBeenCalled();
    expect(store.read()).toHaveLength(MAX_FOLLOWS);
    // ... but an already-followed entry can still be toggled off when full.
    expect(store.toggle("q", "kelime 3")).toBe("removed");
    expect(store.read()).toHaveLength(MAX_FOLLOWS - 1);
  });

  it("remove(key) drops one entry; an unknown key is a silent no-op", async () => {
    const store = await loadStore();
    store.toggle("q", "bir iki");
    store.toggle("konu", "spor");
    store.remove("q:bir iki");
    expect(store.read().map((f) => `${f.kind}:${f.value}`)).toEqual(["konu:spor"]);
    h.setItem.mockClear();
    store.remove("q:yok boyle");
    expect(h.setItem).not.toHaveBeenCalled();
  });

  it("markSeen updates only the given keys", async () => {
    const store = await loadStore();
    store.toggle("q", "bir iki");
    store.toggle("konu", "spor");
    vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
    store.markSeen(new Set(["konu:spor"]));
    const [first, second] = store.read();
    expect(first?.seenAt).toBe("2026-10-22T09:00:00.000Z");
    expect(second?.seenAt).toBe("2026-10-22T12:00:00.000Z");
    // keys that do not exist change nothing and do not write
    h.setItem.mockClear();
    store.markSeen(new Set(["q:yok boyle"]));
    store.markSeen(new Set());
    expect(h.setItem).not.toHaveBeenCalled();
  });

  it("syncs across tabs: a storage event for our key notifies, other keys do not", async () => {
    const store = await loadStore();
    const onChange = vi.fn();
    store.subscribe(onChange);

    h.storage.set(
      FOLLOWS_KEY,
      JSON.stringify([{ kind: "konu", value: "spor", addedAt: null, seenAt: null }]),
    );
    h.fire("storage", "tayf:bookmarks");
    expect(onChange).not.toHaveBeenCalled();
    h.fire("storage", FOLLOWS_KEY);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(store.read().map((f) => f.value)).toEqual(["spor"]);

    // localStorage.clear() in another tab arrives with key === null
    h.storage.set(FOLLOWS_KEY, "[]");
    h.fire("storage", null);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(store.read()).toEqual([]);

    // removal in the other tab arrives the same way
    h.storage.set(FOLLOWS_KEY, "[]");
    h.fire("storage", FOLLOWS_KEY);
    expect(store.read()).toEqual([]);
  });

  it("listens for the in-tab change event and unsubscribes cleanly", async () => {
    const store = await loadStore();
    const onChange = vi.fn();
    const unsubscribe = store.subscribe(onChange);
    expect(h.listenerCount()).toBe(2);
    h.fire(FOLLOWS_CHANGE_EVENT);
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(h.listenerCount()).toBe(0);
    h.fire(FOLLOWS_CHANGE_EVENT);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps working for the session when storage writes fail (private mode / quota)", async () => {
    const store = await loadStore();
    h.failWrites(true);
    expect(() => store.toggle("konu", "spor")).not.toThrow();
    expect(store.read().map((f) => f.value)).toEqual(["spor"]);
    expect(store.toggle("q", "ikinci")).toBe("added");
    expect(store.read()).toHaveLength(2);
    // Once storage recovers, the next mutation persists the full list.
    h.failWrites(false);
    store.toggle("q", "ucuncu");
    const saved = JSON.parse(h.storage.get(FOLLOWS_KEY)!) as Array<{ value: string }>;
    expect(saved.map((f) => f.value)).toEqual(["spor", "ikinci", "ucuncu"]);
  });

  it("survives a localStorage that throws on read", async () => {
    const store = await loadStore();
    h.getItem.mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => store.read()).not.toThrow();
    expect(store.read()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

type El = { type?: unknown; props?: Record<string, unknown> };

function collect(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as El;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) collect(el.props.children, out);
  }
  return out;
}

function followButtonProps(tree: unknown) {
  return collect(tree)
    .filter((el) => el.type === FollowButton)
    .map((el) => ({ kind: el.props?.kind, value: el.props?.value }));
}

function textOf(tree: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown) => {
    if (typeof node === "string") parts.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") {
      visit((node as El).props?.children);
    }
  };
  visit(tree);
  return parts.join("");
}

describe("entry points", () => {
  beforeEach(() => {
    readers.getPoliticsClusters.mockReset();
    readers.searchClusters.mockReset();
    readers.getPoliticsClusters.mockResolvedValue({
      bundles: [],
      breakingBundles: [],
    } as unknown as PoliticsClustersResult);
    readers.searchClusters.mockResolvedValue({ ok: true, bundles: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("home search with q >= 2 chars offers a keyword follow next to the result note", async () => {
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "  seçim " }) });
    expect(followButtonProps(tree)).toEqual([{ kind: "q", value: "seçim" }]);
    expect(textOf(tree)).toContain("“seçim” için sonuçlar");
  });

  it("passes a hostile q through as plain data (React escapes it; nothing is injected as HTML)", async () => {
    const q = "<img src=x onerror=alert(1)>";
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q }) });
    expect(followButtonProps(tree)).toEqual([{ kind: "q", value: q }]);
    const serialised = JSON.stringify(tree, (_k, v) => (typeof v === "function" ? undefined : v));
    expect(serialised).not.toContain("dangerouslySetInnerHTML");
  });

  it.each([[undefined], [""], ["   "], ["a"], [" a "]])(
    "home without a usable query (%j) renders no follow button",
    async (q) => {
      const tree = await HomeFeed({ searchParams: Promise.resolve({ q }) });
      expect(followButtonProps(tree)).toEqual([]);
    },
  );

  it("/konu/[slug] offers a topic follow even when the topic read failed", async () => {
    const tree = await TopicHubPage({
      params: Promise.resolve({ slug: "ekonomi" }),
      searchParams: Promise.resolve({}),
    });
    expect(followButtonProps(tree)).toEqual([{ kind: "konu", value: "ekonomi" }]);
  });

  it("/saved links to /takip next to Haber diyetim", () => {
    const src = readFileSync(resolve(__dirname, "../../app/saved/page.tsx"), "utf8");
    expect(src).toMatch(/href="\/diyetim"[\s\S]*Haber diyetim[\s\S]*href="\/takip"[\s\S]*Takip ettiklerim/);
  });
});

describe("/takip page shell", () => {
  it("is noindex, canonical and carries the privacy note", async () => {
    const mod = await import("@/app/takip/page");
    expect(mod.metadata).toMatchObject({
      title: "Takip ettiklerim",
      description: "Takip ettiğiniz konu ve anahtar kelimelerle eşleşen hikâyeler.",
      alternates: { canonical: "/takip" },
      robots: { index: false, follow: false },
    });
    const tree = mod.default();
    const text = textOf(tree);
    expect(text).toContain("Takip ettiklerim");
    // The list lives on the device, but every followed keyword / topic is sent
    // to the server on each visit (GET /api/takip?q=...) -- the note must say so.
    expect(text).toContain("Takip listeniz bu cihazda saklanır");
    expect(text).toContain("Tayf sunucusuna gönderilir");
    expect(text).toContain("Veritabanına yazılmaz, bir hesapla ilişkilendirilmez.");
    expect(text).not.toContain("yalnızca bu cihazda");
    expect(text).toContain("Kaydedilenler");
    const hrefs = collect(tree).map((el) => el.props?.href);
    expect(hrefs).toContain("/saved");
  });
});
