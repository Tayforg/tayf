import { beforeEach, describe, expect, it, vi } from "vitest";

// h153: loadSearchIntent decides from the query text alone which lookups it
// needs, so an ordinary search costs no read, and it never throws: a failed
// lookup is "no link", never a failed page.

const getActiveSourceNames = vi.hoisted(() => vi.fn());
const getTradedTickers = vi.hoisted(() => vi.fn());

vi.mock("@/lib/sources/registry-query", () => ({
  getActiveSourceNames: () => getActiveSourceNames(),
}));
vi.mock("@/lib/finance/traded-tickers", () => ({
  getTradedTickers: () => getTradedTickers(),
}));

import { loadSearchIntent } from "./search-intent-query";

const SOURCES = [
  { slug: "halk-tv", name: "Halk TV" },
  { slug: "hurriyet", name: "Hürriyet" },
  { slug: "sabah", name: "Sabah" },
];

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getActiveSourceNames.mockReset();
  getTradedTickers.mockReset();
  getActiveSourceNames.mockResolvedValue(SOURCES);
  getTradedTickers.mockResolvedValue(["KCHOL", "THYAO"]);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("loadSearchIntent: which lookups run", () => {
  it("runs neither lookup for an ordinary multi-word search", async () => {
    const q = "asgari ücret zammı ne zaman açıklanacak";
    await expect(loadSearchIntent(q)).resolves.toBeNull();
    expect(getActiveSourceNames).not.toHaveBeenCalled();
    expect(getTradedTickers).not.toHaveBeenCalled();
  });

  it("runs neither lookup for an operator query", async () => {
    await expect(loadSearchIntent("-thyao")).resolves.toBeNull();
    await expect(loadSearchIntent('"halk tv"')).resolves.toBeNull();
    expect(getActiveSourceNames).not.toHaveBeenCalled();
    expect(getTradedTickers).not.toHaveBeenCalled();
  });

  it("runs only the outlet lookup for a two-word outlet name", async () => {
    await expect(loadSearchIntent("halk tv")).resolves.toEqual({
      kind: "source",
      slug: "halk-tv",
      name: "Halk TV",
    });
    expect(getActiveSourceNames).toHaveBeenCalledTimes(1);
    expect(getTradedTickers).not.toHaveBeenCalled();
  });

  it("runs both lookups for a ticker-shaped word and gives the ticker when no outlet matches", async () => {
    await expect(loadSearchIntent("thyao")).resolves.toEqual({ kind: "ticker", ticker: "THYAO" });
    expect(getActiveSourceNames).toHaveBeenCalledTimes(1);
    expect(getTradedTickers).toHaveBeenCalledTimes(1);
  });

  it("never reads the traded tickers for a denied word", async () => {
    await expect(loadSearchIntent("deva")).resolves.toBeNull();
    expect(getTradedTickers).not.toHaveBeenCalled();
  });

  it("never reads the traded tickers for a word that is too long or too short to be a code", async () => {
    await expect(loadSearchIntent("THY")).resolves.toBeNull();
    await expect(loadSearchIntent("THYAOXX")).resolves.toBeNull();
    await expect(loadSearchIntent("ASELS2")).resolves.toBeNull();
    expect(getTradedTickers).not.toHaveBeenCalled();
  });

  it("reads the traded tickers for any ticker-shaped word, and the set decides (no link for 'seçim')", async () => {
    // 'seçim' folds to the five letters SECIM: shaped like a code, so the set is asked, and it is not in it.
    await expect(loadSearchIntent("seçim")).resolves.toBeNull();
    expect(getTradedTickers).toHaveBeenCalledTimes(1);
  });

  it("passes no argument to either getter (a unique query can never create a cache key)", async () => {
    await loadSearchIntent("thyao");
    expect(getActiveSourceNames).toHaveBeenCalledWith();
    expect(getTradedTickers).toHaveBeenCalledWith();
  });
});

describe("loadSearchIntent: results", () => {
  it("gives the outlet when both lookups run and an outlet matches (outlet first)", async () => {
    getActiveSourceNames.mockResolvedValue([{ slug: "thyao-haber", name: "THYAO" }]);
    await expect(loadSearchIntent("thyao")).resolves.toEqual({
      kind: "source",
      slug: "thyao-haber",
      name: "THYAO",
    });
  });

  it("gives null for a ticker that is not traded", async () => {
    await expect(loadSearchIntent("garan")).resolves.toBeNull();
  });

  it("still allows the ticker when the registry read came back null", async () => {
    getActiveSourceNames.mockResolvedValue(null);
    await expect(loadSearchIntent("thyao")).resolves.toEqual({ kind: "ticker", ticker: "THYAO" });
  });

  it("still allows the outlet when the traded set came back null", async () => {
    getTradedTickers.mockResolvedValue(null);
    await expect(loadSearchIntent("hürriyet")).resolves.toEqual({
      kind: "source",
      slug: "hurriyet",
      name: "Hürriyet",
    });
  });

  it("gives null for a ticker when the traded set came back null", async () => {
    getTradedTickers.mockResolvedValue(null);
    await expect(loadSearchIntent("thyao")).resolves.toBeNull();
  });

  it("does not link an ordinary-word outlet name", async () => {
    await expect(loadSearchIntent("sabah")).resolves.toBeNull();
    await expect(loadSearchIntent("sabah gazetesi")).resolves.toEqual({
      kind: "source",
      slug: "sabah",
      name: "Sabah",
    });
  });
});

describe("loadSearchIntent: failures", () => {
  it("resolves null and warns without the query when the traded read rejects", async () => {
    getTradedTickers.mockRejectedValue(new Error("traded read exploded"));

    await expect(loadSearchIntent("thyao")).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    const text = warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(text).toContain("[search] intent lookup failed");
    expect(text).toContain("traded read exploded");
    expect(text.toLowerCase()).not.toContain("thyao");
  });

  it("resolves null when the registry read rejects", async () => {
    getActiveSourceNames.mockRejectedValue(new Error("registry exploded"));
    await expect(loadSearchIntent("halk tv")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("copes with a rejection that is not an Error", async () => {
    getActiveSourceNames.mockRejectedValue("plain string");
    await expect(loadSearchIntent("halk tv")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0]).toLowerCase()).not.toContain("halk");
  });

  it("does not warn when nothing went wrong", async () => {
    await loadSearchIntent("thyao");
    await loadSearchIntent("asgari ücret");
    expect(warn).not.toHaveBeenCalled();
  });
});
