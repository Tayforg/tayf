import { describe, it, expect } from "vitest";
import {
  isAllOpinion,
  isOpinionUrl,
  OPINION_HOST_SEGMENTS,
  OPINION_PATH_SEGMENTS,
} from "./opinion-url";

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
      [
        "column",
        "columns",
        "gorus",
        "gunun-yazilari",
        "kose-yazilari",
        "kose-yazisi",
        "koseyazilari",
        "koseyazisi",
        "opinion",
        "yazar",
        "yazarlar",
      ].sort(),
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

// h58-postship-3: four column sections the first hunt missed (30 days, 2026-11-07):
//   aydinlik   /koseyazisi/      181 articles
//   serbestiyet /gunun-yazilari/  55
//   agos       /tr/yazi/          36   (its news is under /tr/haber/)
//   halktv     /makale/           24   (its news is under /turkiye/, /siyaset/ ...)
// 'koseyazisi' and 'gunun-yazilari' are column-only names, so they are global. 'yazi' and
// 'makale' are generic: BirGün /makale/ (324) mixes news and columns and Bianet /yazi/ (60)
// is left to the known Bianet item, so those two segments count on their own host only.
const AYDINLIK_COLUMN = "https://www.aydinlik.com.tr/koseyazisi/trumpin-tahti-sallanirken-turkiye-597831";
const SERBESTIYET_COLUMN = "https://serbestiyet.com/gunun-yazilari/1-milyon-dolarlik-bilmece-baba-ogul-fon-252135/";
const AGOS_COLUMN = "https://www.agos.com.tr/tr/yazi/anam-yayam-usulu-musakka-42322";
const HALKTV_COLUMN = "https://halktv.com.tr/makale/lekelenmeme-hakki-1061559";

describe("isOpinionUrl: the four sections added by h58-postship-3", () => {
  it.each([
    ["aydinlik /koseyazisi/", AYDINLIK_COLUMN],
    ["serbestiyet /gunun-yazilari/", SERBESTIYET_COLUMN],
    ["agos www /tr/yazi/", AGOS_COLUMN],
    ["agos bare host /tr/yazi/", "https://agos.com.tr/tr/yazi/x-1"],
    ["halktv bare host /makale/", HALKTV_COLUMN],
    ["halktv www /makale/", "https://www.halktv.com.tr/makale/x-1"],
  ])("%s is opinion", (_label, url) => {
    expect(isOpinionUrl(url)).toBe(true);
  });

  it.each([
    ["agos news (/tr/haber/)", "https://www.agos.com.tr/tr/haber/x-1"],
    [
      "birgun /makale/ mixes news and columns",
      "https://www.birgun.net/makale/14-uluslararasi-izmir-tiyatro-festivali-basliyor-adalet-bu-kez-sahnede-744854",
    ],
    [
      "bianet /yazi/ is left to the known Bianet item",
      "https://bianet.org/yazi/feminist-damarinizi-guclendirecek-dizi-onerileri-325148",
    ],
    ["/yazi/ on any other host", "https://example.com/yazi/x"],
    ["/makale/ on any other host", "https://example.com/makale/x"],
    ["halktv news (/siyaset/)", "https://halktv.com.tr/siyaset/x-1"],
    ["a look-alike host that starts with agos.com.tr", "https://agos.com.tr.evil.example/tr/yazi/x"],
    ["a look-alike host that ends with halktv.com.tr", "https://evilhalktv.com.tr/makale/x-1"],
    ["a subdomain of a scoped host", "https://news.halktv.com.tr/makale/x-1"],
    ["the segment only in the query string", "https://www.aydinlik.com.tr/haber/x?ref=koseyazisi"],
    ["the segment only in the fragment", "https://www.aydinlik.com.tr/haber/x#koseyazisi"],
    ["a host label, not a path segment", "https://x.com/koseyazisi-arsivi/"],
    ["the scoped host only in the userinfo", "https://agos.com.tr@evil.example/tr/yazi/x"],
    ["the scoped host only in the path", "https://evil.example/agos.com.tr/tr/yazi/x"],
  ])("%s is not opinion", (_label, url) => {
    expect(isOpinionUrl(url)).toBe(false);
  });

  it("'koseyazisi' and 'gunun-yazilari' are global, like the other column-only names", () => {
    expect(OPINION_PATH_SEGMENTS.has("koseyazisi")).toBe(true);
    expect(OPINION_PATH_SEGMENTS.has("gunun-yazilari")).toBe(true);
    expect(isOpinionUrl("https://example.com/koseyazisi/x-1")).toBe(true);
    expect(isOpinionUrl("https://example.com/haber/gunun-yazilari/x-1")).toBe(true);
  });

  it("'yazi' and 'makale' are NOT global", () => {
    expect(OPINION_PATH_SEGMENTS.has("yazi")).toBe(false);
    expect(OPINION_PATH_SEGMENTS.has("makale")).toBe(false);
  });

  it("the host table is exactly agos.com.tr -> yazi and halktv.com.tr -> makale", () => {
    expect([...OPINION_HOST_SEGMENTS.keys()].sort()).toEqual(["agos.com.tr", "halktv.com.tr"]);
    expect([...(OPINION_HOST_SEGMENTS.get("agos.com.tr") ?? [])]).toEqual(["yazi"]);
    expect([...(OPINION_HOST_SEGMENTS.get("halktv.com.tr") ?? [])]).toEqual(["makale"]);
  });

  it("a host-scoped segment counts only on its own host, not on the other scoped host", () => {
    expect(isOpinionUrl("https://halktv.com.tr/tr/yazi/x-1")).toBe(false);
    expect(isOpinionUrl("https://agos.com.tr/makale/x-1")).toBe(false);
  });

  it("the host is compared lower-cased, with exactly one leading 'www.' stripped, and no suffix matching", () => {
    expect(isOpinionUrl("https://WWW.AGOS.COM.TR/tr/yazi/x-1")).toBe(true);
    expect(isOpinionUrl("https://Halktv.Com.Tr/makale/x-1")).toBe(true);
    expect(isOpinionUrl("https://www.www.agos.com.tr/tr/yazi/x-1")).toBe(false);
    expect(isOpinionUrl("https://wwwagos.com.tr/tr/yazi/x-1")).toBe(false);
    expect(isOpinionUrl("https://m.agos.com.tr/tr/yazi/x-1")).toBe(false);
  });

  it("a port, a query and a fragment on a scoped host change nothing", () => {
    expect(isOpinionUrl("https://www.agos.com.tr:443/tr/yazi/x-1?utm_source=x#top")).toBe(true);
    expect(isOpinionUrl("https://halktv.com.tr/makale/x-1?ref=siyaset")).toBe(true);
    expect(isOpinionUrl("https://halktv.com.tr/siyaset/x-1?ref=makale")).toBe(false);
  });

  it("the host-scoped segment is a whole segment, case-insensitive, and counts at any depth on its host", () => {
    expect(isOpinionUrl("https://www.agos.com.tr/tr/YAZI/x-1")).toBe(true);
    expect(isOpinionUrl("https://halktv.com.tr/makale")).toBe(true);
    expect(isOpinionUrl("https://halktv.com.tr/makaleler/x-1")).toBe(false);
    expect(isOpinionUrl("https://www.agos.com.tr/tr/yazi-arsivi/x-1")).toBe(false);
    expect(isOpinionUrl("https://www.agos.com.tr/tr/haber/yazi-x-1")).toBe(false);
  });

  it("isAllOpinion is true for members that are all new-section columns, false once a news URL joins", () => {
    const col = (url: string) => ({ article: { url } });
    expect(isAllOpinion([col(AYDINLIK_COLUMN)])).toBe(true);
    expect(isAllOpinion([col(AGOS_COLUMN), col(HALKTV_COLUMN), col(SERBESTIYET_COLUMN)])).toBe(true);
    expect(isAllOpinion([col(AYDINLIK_COLUMN), col("https://www.agos.com.tr/tr/haber/x-1")])).toBe(false);
    expect(isAllOpinion([col(HALKTV_COLUMN), col("https://halktv.com.tr/siyaset/x-1")])).toBe(false);
  });

  it("a long segment of 14 characters is still read (the longest-segment shortcut covers gunun-yazilari)", () => {
    expect("gunun-yazilari").toHaveLength(14);
    expect(isOpinionUrl("https://example.com/gunun-yazilari")).toBe(true);
    expect(isOpinionUrl("https://example.com/gunun-yazilarii")).toBe(false);
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
