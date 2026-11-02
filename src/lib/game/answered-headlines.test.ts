import { afterEach, describe, expect, it, vi } from "vitest";

// Module state (the in-memory answered Set) is the point under test, so every
// test imports a fresh copy of the module after resetting the registry.
type AnsweredModule = typeof import("./answered-headlines");

async function freshModule(): Promise<AnsweredModule> {
  vi.resetModules();
  return import("./answered-headlines");
}

interface FakeStorage {
  data: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function fakeSessionStorage(initial: Record<string, string> = {}): FakeStorage {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function stubWindow(sessionStorage: unknown): void {
  vi.stubGlobal("window", { sessionStorage });
}

function storedIds(storage: FakeStorage, key: string): unknown {
  const raw = storage.data.get(key);
  return raw === undefined ? undefined : JSON.parse(raw);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("constants", () => {
  it("uses the documented storage key and cap", async () => {
    const mod = await freshModule();

    expect(mod.ANSWERED_STORAGE_KEY).toBe("tayf-oyun-answered-v1");
    expect(mod.ANSWERED_CAP).toBe(500);
  });
});

describe("parseAnsweredIds", () => {
  it("null and empty input give []", async () => {
    const { parseAnsweredIds } = await freshModule();

    expect(parseAnsweredIds(null)).toEqual([]);
    expect(parseAnsweredIds("")).toEqual([]);
  });

  it("bad JSON gives []", async () => {
    const { parseAnsweredIds } = await freshModule();

    expect(parseAnsweredIds("{not json")).toEqual([]);
    expect(parseAnsweredIds("[\"a\",")).toEqual([]);
  });

  it("a JSON value that is not an array gives []", async () => {
    const { parseAnsweredIds } = await freshModule();

    expect(parseAnsweredIds("{\"a\":1}")).toEqual([]);
    expect(parseAnsweredIds("\"a\"")).toEqual([]);
    expect(parseAnsweredIds("42")).toEqual([]);
    expect(parseAnsweredIds("null")).toEqual([]);
  });

  it("drops non-string and empty items, keeps the strings in order", async () => {
    const { parseAnsweredIds } = await freshModule();

    expect(parseAnsweredIds(JSON.stringify(["a", 1, null, "b", { id: "c" }, ["d"], "", true, "e"]))).toEqual([
      "a",
      "b",
      "e",
    ]);
  });

  it("keeps only the last ANSWERED_CAP ids", async () => {
    const { parseAnsweredIds, ANSWERED_CAP } = await freshModule();
    const ids = Array.from({ length: ANSWERED_CAP + 25 }, (_, i) => `id-${i}`);

    const parsed = parseAnsweredIds(JSON.stringify(ids));

    expect(parsed).toHaveLength(ANSWERED_CAP);
    expect(parsed[0]).toBe("id-25");
    expect(parsed[parsed.length - 1]).toBe(`id-${ANSWERED_CAP + 24}`);
  });

  it("exactly ANSWERED_CAP ids are all kept", async () => {
    const { parseAnsweredIds, ANSWERED_CAP } = await freshModule();
    const ids = Array.from({ length: ANSWERED_CAP }, (_, i) => `id-${i}`);

    expect(parseAnsweredIds(JSON.stringify(ids))).toEqual(ids);
  });
});

describe("markAnswered", () => {
  it("returns true the first time an id is answered and false afterwards", async () => {
    stubWindow(fakeSessionStorage());
    const { markAnswered } = await freshModule();

    expect(markAnswered("article-1")).toBe(true);
    expect(markAnswered("article-1")).toBe(false);
    expect(markAnswered("article-1")).toBe(false);
    expect(markAnswered("article-2")).toBe(true);
  });

  it("writes the id into sessionStorage under the documented key", async () => {
    const storage = fakeSessionStorage();
    stubWindow(storage);
    const { markAnswered, ANSWERED_STORAGE_KEY } = await freshModule();

    markAnswered("article-1");
    markAnswered("article-2");
    markAnswered("article-1");

    expect(storedIds(storage, ANSWERED_STORAGE_KEY)).toEqual(["article-1", "article-2"]);
  });

  it("still dedupes through memory when sessionStorage throws on every call", async () => {
    stubWindow({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const { markAnswered, readAnsweredIds } = await freshModule();

    expect(markAnswered("article-1")).toBe(true);
    expect(markAnswered("article-1")).toBe(false);
    expect(readAnsweredIds()).toEqual(new Set(["article-1"]));
  });

  it("still dedupes through memory when merely touching window.sessionStorage throws", async () => {
    const blockedWindow = {};
    Object.defineProperty(blockedWindow, "sessionStorage", {
      get() {
        throw new Error("SecurityError");
      },
    });
    vi.stubGlobal("window", blockedWindow);
    const { markAnswered } = await freshModule();

    expect(markAnswered("article-1")).toBe(true);
    expect(markAnswered("article-1")).toBe(false);
  });

  it("still dedupes through memory when there is no window at all (server render)", async () => {
    const { markAnswered, readAnsweredIds } = await freshModule();

    expect(markAnswered("article-1")).toBe(true);
    expect(markAnswered("article-1")).toBe(false);
    expect(readAnsweredIds().has("article-1")).toBe(true);
  });

  it("an id already in sessionStorage (an earlier page load in this tab) is not answered again", async () => {
    const { ANSWERED_STORAGE_KEY } = await freshModule();
    const storage = fakeSessionStorage({ [ANSWERED_STORAGE_KEY]: JSON.stringify(["article-1"]) });
    stubWindow(storage);
    const { markAnswered } = await freshModule();

    expect(markAnswered("article-1")).toBe(false);
    expect(markAnswered("article-2")).toBe(true);
    expect(storedIds(storage, ANSWERED_STORAGE_KEY)).toEqual(["article-1", "article-2"]);
  });

  it("repairs a corrupt stored value instead of throwing", async () => {
    const { ANSWERED_STORAGE_KEY } = await freshModule();
    const storage = fakeSessionStorage({ [ANSWERED_STORAGE_KEY]: "{broken" });
    stubWindow(storage);
    const { markAnswered } = await freshModule();

    expect(markAnswered("article-1")).toBe(true);
    expect(storedIds(storage, ANSWERED_STORAGE_KEY)).toEqual(["article-1"]);
  });

  it("keeps the stored list at ANSWERED_CAP, dropping the oldest id", async () => {
    const { ANSWERED_STORAGE_KEY, ANSWERED_CAP } = await freshModule();
    const full = Array.from({ length: ANSWERED_CAP }, (_, i) => `id-${i}`);
    const storage = fakeSessionStorage({ [ANSWERED_STORAGE_KEY]: JSON.stringify(full) });
    stubWindow(storage);
    const { markAnswered } = await freshModule();

    expect(markAnswered("fresh-id")).toBe(true);

    const stored = storedIds(storage, ANSWERED_STORAGE_KEY) as string[];
    expect(stored).toHaveLength(ANSWERED_CAP);
    expect(stored[0]).toBe("id-1");
    expect(stored[stored.length - 1]).toBe("fresh-id");
  });

  it("is independent per module instance: a fresh page load starts with empty memory", async () => {
    stubWindow(fakeSessionStorage());
    const first = await freshModule();
    expect(first.markAnswered("article-1")).toBe(true);

    // New module instance, brand-new storage: nothing is remembered.
    stubWindow(fakeSessionStorage());
    const second = await freshModule();
    expect(second.markAnswered("article-1")).toBe(true);
  });
});

describe("readAnsweredIds", () => {
  it("is empty before anything is answered", async () => {
    stubWindow(fakeSessionStorage());
    const { readAnsweredIds } = await freshModule();

    expect(readAnsweredIds().size).toBe(0);
  });

  it("is the union of the in-memory ids and sessionStorage", async () => {
    const { ANSWERED_STORAGE_KEY } = await freshModule();
    const storage = fakeSessionStorage({ [ANSWERED_STORAGE_KEY]: JSON.stringify(["stored-1", "stored-2"]) });
    stubWindow(storage);
    const { markAnswered, readAnsweredIds } = await freshModule();

    markAnswered("memory-1");

    expect(readAnsweredIds()).toEqual(new Set(["stored-1", "stored-2", "memory-1"]));
  });

  it("returns a copy: mutating the result does not change what is remembered", async () => {
    stubWindow(fakeSessionStorage());
    const { markAnswered, readAnsweredIds } = await freshModule();
    markAnswered("article-1");

    const copy = readAnsweredIds();
    copy.add("injected");
    copy.delete("article-1");

    expect(readAnsweredIds()).toEqual(new Set(["article-1"]));
  });

  it("falls back to memory alone when sessionStorage throws", async () => {
    stubWindow({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const { markAnswered, readAnsweredIds } = await freshModule();
    markAnswered("article-1");

    expect(readAnsweredIds()).toEqual(new Set(["article-1"]));
  });
});

describe("nextRound", () => {
  const pool = ["a", "b", "c", "d", "e", "f"].map((articleId) => ({ articleId, title: `Başlık ${articleId}` }));

  it("keeps the pool order", async () => {
    const { nextRound } = await freshModule();

    expect(nextRound(pool, new Set(), 4).map((h) => h.articleId)).toEqual(["a", "b", "c", "d"]);
  });

  it("drops answered ids and keeps the rest in order", async () => {
    const { nextRound } = await freshModule();

    expect(nextRound(pool, new Set(["a", "c"]), 10).map((h) => h.articleId)).toEqual(["b", "d", "e", "f"]);
  });

  it("caps the result at `size` after dropping answered ids", async () => {
    const { nextRound } = await freshModule();

    expect(nextRound(pool, new Set(["a"]), 3).map((h) => h.articleId)).toEqual(["b", "c", "d"]);
  });

  it("returns [] when every headline was answered", async () => {
    const { nextRound } = await freshModule();

    expect(nextRound(pool, new Set(pool.map((h) => h.articleId)), 10)).toEqual([]);
  });

  it("returns [] for an empty pool and for a size of 0 or less", async () => {
    const { nextRound } = await freshModule();

    expect(nextRound([], new Set(), 10)).toEqual([]);
    expect(nextRound(pool, new Set(), 0)).toEqual([]);
    expect(nextRound(pool, new Set(), -3)).toEqual([]);
  });

  it("ignores answered ids that are not in the pool", async () => {
    const { nextRound } = await freshModule();

    expect(nextRound(pool, new Set(["zzz"]), 2).map((h) => h.articleId)).toEqual(["a", "b"]);
  });

  it("returns the original objects (the generic type is preserved) and leaves the pool untouched", async () => {
    const { nextRound } = await freshModule();
    const before = pool.map((h) => h.articleId);

    const round = nextRound(pool, new Set(["a"]), 2);

    expect(round[0]).toBe(pool[1]);
    expect(round[0]?.title).toBe("Başlık b");
    expect(pool.map((h) => h.articleId)).toEqual(before);
  });
});

// The Bölge flow end to end through the pure helpers: a 30-headline page
// session is three rounds of 10, no headline appears twice, a guess is only
// POSTed (markAnswered -> true) once per headline, and the fourth "Başla"
// finds nothing left.
describe("a page session of 30 headlines played round after round", () => {
  it("plays three disjoint rounds of 10, then runs out", async () => {
    stubWindow(fakeSessionStorage());
    const { markAnswered, nextRound, readAnsweredIds } = await freshModule();
    const session = Array.from({ length: 30 }, (_, i) => ({ articleId: `article-${i}` }));

    const seen: string[] = [];
    let posted = 0;
    for (let roundNo = 1; roundNo <= 3; roundNo++) {
      const round = nextRound(session, readAnsweredIds(), 10);
      expect(round, `round ${roundNo}`).toHaveLength(10);
      for (const headline of round) {
        seen.push(headline.articleId);
        if (markAnswered(headline.articleId)) posted += 1;
      }
    }

    expect(new Set(seen).size).toBe(30);
    expect(posted).toBe(30);
    expect(nextRound(session, readAnsweredIds(), 1)).toEqual([]);
    expect(nextRound(session, readAnsweredIds(), 10)).toEqual([]);
  });

  it("a round cut short by the timer leaves its unanswered headlines for the next round", async () => {
    stubWindow(fakeSessionStorage());
    const { markAnswered, nextRound, readAnsweredIds } = await freshModule();
    const session = Array.from({ length: 12 }, (_, i) => ({ articleId: `article-${i}` }));

    const first = nextRound(session, readAnsweredIds(), 10);
    for (const headline of first.slice(0, 4)) markAnswered(headline.articleId);

    const second = nextRound(session, readAnsweredIds(), 10);
    expect(second.map((h) => h.articleId)).toEqual(session.slice(4).map((h) => h.articleId));
    expect(second).toHaveLength(8);
  });

  it("a headline answered in Günün Tayf'ı is not offered to Bölge and is not POSTed twice", async () => {
    stubWindow(fakeSessionStorage());
    const { markAnswered, nextRound, readAnsweredIds } = await freshModule();
    const session = Array.from({ length: 5 }, (_, i) => ({ articleId: `article-${i}` }));

    expect(markAnswered("article-2")).toBe(true); // the daily puzzle
    expect(nextRound(session, readAnsweredIds(), 10).map((h) => h.articleId)).toEqual([
      "article-0",
      "article-1",
      "article-3",
      "article-4",
    ]);
    expect(markAnswered("article-2")).toBe(false); // the same headline in Bölge
  });
});
