import { describe, it, expect } from "vitest";
import { isAllOpinion, isOpinionUrl, OPINION_PATH_SEGMENTS } from "./opinion-url";

// h54-editorial-3: opinion columns cluster with news and reach the page as news.
// There is no opinion column anywhere in the schema; the only signal is the URL
// path the outlet itself chose (/yazarlar/<columnist>/...). The fixtures are the
// live URLs of the 539e6666 and 4555a9bd clusters (4 Nov 2026).

const HURRIYET_COLUMN =
  "https://www.hurriyet.com.tr/yazarlar/nedim-sener/utanmazlik-abidesi-sarigul-ozgur-ozeli-tehdit-mi-etti-43365220";
const SABAH_COLUMN = "https://www.sabah.com.tr/yazarlar/salih-tuna/2026/11/04/anladiysaniz-bana-da-anlatin";
const AHABER_COLUMN = "https://www.ahaber.com.tr/yazarlar/mahmut-ovur/2026/11/05/riskli-adaylar-ureten-parti";
const YENI_AKIT_NEWS =
  "https://www.yeniakit.com.tr/haber/nedim-sener-sarigulun-sozlerinin-pesine-dustu-utanmazlik-abidesi-sarigul-ozgur-ozeli-tehdit-mi-etti-2031769.html";
const CUMHURIYET_NEWS =
  "https://www.cumhuriyet.com.tr/turkiye/37-yillik-santralde-uretim-durdu-yaklasik-bin-isci-izne-cikarildi-2554029";

describe("isOpinionUrl: the outlet's own column paths", () => {
  it.each([
    ["hurriyet /yazarlar/", HURRIYET_COLUMN],
    ["sabah /yazarlar/", SABAH_COLUMN],
    ["ahaber /yazarlar/", AHABER_COLUMN],
  ])("%s is opinion", (_label, url) => {
    expect(isOpinionUrl(url)).toBe(true);
  });

  it.each([
    ["yeni akit news rewrite of the same column", YENI_AKIT_NEWS],
    ["a cumhuriyet news URL", CUMHURIYET_NEWS],
    ["a bare home page", "https://www.hurriyet.com.tr/"],
    ["an empty path", "https://www.hurriyet.com.tr"],
  ])("%s is not opinion", (_label, url) => {
    expect(isOpinionUrl(url)).toBe(false);
  });

  it("matches each listed path segment", () => {
    expect([...OPINION_PATH_SEGMENTS].sort()).toEqual(
      ["column", "columns", "gorus", "kose-yazilari", "kose-yazisi", "koseyazilari", "opinion", "yazar", "yazarlar"].sort(),
    );
    for (const seg of OPINION_PATH_SEGMENTS) {
      expect(isOpinionUrl(`https://example.com/${seg}/x/y-123`), seg).toBe(true);
    }
  });

  it("matches the segment anywhere in the path, not only first (Daily Sabah /opinion/columns/...)", () => {
    expect(isOpinionUrl("https://www.dailysabah.com/opinion/columns/the-week-ahead")).toBe(true);
    expect(isOpinionUrl("https://example.com/haber/kose-yazilari/bir-yazi")).toBe(true);
    expect(isOpinionUrl("https://example.com/yazarlar")).toBe(true);
    expect(isOpinionUrl("https://example.com/yazarlar/")).toBe(true);
  });

  it("is case-insensitive on the segment", () => {
    expect(isOpinionUrl("https://example.com/YAZARLAR/Ali-Veli/x")).toBe(true);
    expect(isOpinionUrl("https://example.com/Kose-Yazilari/x")).toBe(true);
    expect(isOpinionUrl("https://example.com/Opinion/x")).toBe(true);
  });

  it("only a WHOLE segment counts: a longer word, a slug that contains the word, or a prefix does not", () => {
    expect(isOpinionUrl("https://example.com/haber/yazarlarin-tepkisi-123")).toBe(false);
    expect(isOpinionUrl("https://example.com/haber/opinion-poll-sonuclari")).toBe(false);
    expect(isOpinionUrl("https://example.com/yazarlar-kurulu/x")).toBe(false);
    expect(isOpinionUrl("https://example.com/columnist/x")).toBe(false);
    expect(isOpinionUrl("https://example.com/gorusme/x")).toBe(false);
    expect(isOpinionUrl("https://example.com/haber/yazar-adayi-oldu-1")).toBe(false);
  });

  it("ignores the query string, the fragment and the host", () => {
    expect(isOpinionUrl("https://www.hurriyet.com.tr/haber/x-1?ref=yazarlar")).toBe(false);
    expect(isOpinionUrl("https://www.hurriyet.com.tr/haber/x-1?section=/yazarlar/")).toBe(false);
    expect(isOpinionUrl("https://www.hurriyet.com.tr/haber/x-1#yazarlar")).toBe(false);
    expect(isOpinionUrl("https://yazarlar.example.com/haber/x-1")).toBe(false);
    expect(isOpinionUrl("https://opinion.example.com/")).toBe(false);
    // The query is not looked at on a column either.
    expect(isOpinionUrl(`${SABAH_COLUMN}?utm_source=x`)).toBe(true);
  });

  it("returns false for malformed input and non-strings, and never throws", () => {
    for (const bad of ["", "   ", "not a url", "/yazarlar/x", "//example.com/yazarlar/x", "yazarlar", "https://", "http://[::1"]) {
      expect(isOpinionUrl(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [null, undefined, 0, 12, {}, [], true]) {
      expect(isOpinionUrl(bad as unknown as string)).toBe(false);
    }
  });

  it("a very long hostile URL is read in one bounded pass", () => {
    const long = `https://example.com/${"a/".repeat(50_000)}yazarlar/x`;
    const start = Date.now();
    expect(typeof isOpinionUrl(long)).toBe("boolean");
    expect(isOpinionUrl(`https://example.com/${"a".repeat(200_000)}`)).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("isAllOpinion: every member is a column", () => {
  const col = (url: string) => ({ article: { url } });

  it("is true when every member's URL is an opinion URL", () => {
    expect(isAllOpinion([col(SABAH_COLUMN), col(AHABER_COLUMN)])).toBe(true);
    expect(isAllOpinion([col(HURRIYET_COLUMN)])).toBe(true);
  });

  it("is false for a mixed cluster (539e6666: a Hürriyet column and a Yeni Akit news rewrite)", () => {
    expect(isAllOpinion([col(HURRIYET_COLUMN), col(YENI_AKIT_NEWS)])).toBe(false);
  });

  it("is false for an empty roster and for members without a URL (nothing says it is a column)", () => {
    expect(isAllOpinion([])).toBe(false);
    expect(isAllOpinion([col(SABAH_COLUMN), { article: {} }])).toBe(false);
    expect(isAllOpinion([{ article: { url: null } }])).toBe(false);
  });

  it("never throws on a non-array", () => {
    expect(isAllOpinion(undefined as unknown as [])).toBe(false);
    expect(isAllOpinion(null as unknown as [])).toBe(false);
  });
});
