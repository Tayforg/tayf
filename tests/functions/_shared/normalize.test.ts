import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { INVALID_XML_CHARS_RE } from "../../../supabase/functions/_shared/rss/entities.ts";

// ---------------------------------------------------------------------------
// Sanitisation coverage for supabase/functions/_shared/rss/normalize.ts.
//
// CodeQL flagged two patterns in the legacy normalizer that were ported into
// this Deno worker:
//
//   * js/double-escaping — `decodeEntities` chained `.replace` calls starting
//     with `&amp; -> &`, so "&amp;lt;script&gt;" double-unescaped into the
//     executable "<script>". The fix makes decoding single-pass: every entity
//     is consumed exactly once, so the "&" produced from "&amp;" can never be
//     re-read as the start of another entity.
//
//   * js/incomplete-multi-character-sanitization — `cleanDescription` stripped
//     tags ONCE and decoded AFTER, so crafted input like "<<script>script>"
//     left a live "<script" behind and decoded entities could reintroduce
//     markup. The fix decodes first, then strips tags in a loop to a fixpoint.
//
// `normalizeItem`'s title path uses the same decode-then-fixpoint-strip
// discipline, so a decoded title can't carry markup either.
//
// Imported lazily with a loud beforeAll failure rather than a silent skip,
// matching cluster.test.ts in this directory — `normalize.ts` only takes a
// runtime dependency on `../cluster/fingerprint.ts` (the `fetcher.ts` import
// is `import type`, erased at compile time), so it loads cleanly under vitest.
// ---------------------------------------------------------------------------

interface NormalizeModule {
  normalizeItem: typeof import(
    "../../../supabase/functions/_shared/rss/normalize.ts"
  )["normalizeItem"];
  isVideoUrl: typeof import(
    "../../../supabase/functions/_shared/rss/normalize.ts"
  )["isVideoUrl"];
  normalizeArticles: typeof import(
    "../../../supabase/functions/_shared/rss/normalize.ts"
  )["normalizeArticles"];
}

let mod: NormalizeModule | null = null;
let loadError: unknown = null;

beforeAll(async () => {
  try {
    const m = await import(
      "../../../supabase/functions/_shared/rss/normalize.ts"
    );
    mod = {
      normalizeItem: m.normalizeItem,
      isVideoUrl: m.isVideoUrl,
      normalizeArticles: m.normalizeArticles,
    };
  } catch (err) {
    loadError = err;
  }
});

const source = {
  id: "src-1",
  name: "Test Source",
  slug: "test",
  url: "https://example.test",
  rss_url: "https://example.test/rss",
};

describe("normalize.ts sanitisation (CodeQL js/double-escaping + js/incomplete-multi-character-sanitization)", () => {
  it("loads the normalizer without error", () => {
    if (loadError) {
      expect.fail(
        `failed to dynamic-import normalize.ts: ${String(loadError)}`,
      );
    }
    expect(mod).not.toBeNull();
  });

  it("does not double-unescape '&amp;lt;script&gt;' into executable markup", () => {
    const row = mod!.normalizeItem(source, {
      title: "&amp;lt;script&gt; haber",
      link: "/a",
    });
    expect(row).not.toBeNull();
    // The "&" only ever comes from consuming "&amp;" exactly once, so the
    // entity collapses to the literal text "&lt;script>" — never "<script>".
    expect(row!.title).toContain("&lt;script>");
    expect(row!.title).not.toContain("<script");
  });

  it("strips nested/reintroduced markup to a fixpoint in cleanDescription", () => {
    const row = mod!.normalizeItem(source, {
      title: "Başlık",
      link: "/a",
      contentSnippet: "<<script>script>alert(1)",
    });
    expect(row).not.toBeNull();
    expect(row!.description).not.toBeNull();
    expect(row!.description!).not.toContain("<script");
    expect(row!.description!).not.toContain("<");
  });

  it("preserves normal entity decoding for benign input", () => {
    const row = mod!.normalizeItem(source, {
      title: "Galatasaray &amp; Fenerbah&#231;e ma&ccedil;&#x131;",
      link: "/a",
      contentSnippet: "Y&#252;zde 50 art&#305;&#351;",
    });
    expect(row).not.toBeNull();
    // & decoded once, decimal #231 -> ç, hex #x131 -> ı; unknown named entity
    // (&ccedil;) is left untouched rather than mangled.
    expect(row!.title).toContain("Galatasaray & Fenerbahçe");
    expect(row!.title).toContain("&ccedil;");
    expect(row!.title).toContain("ı");
    // Decimal references decode: #252 -> ü, #305 -> ı, #351 -> ş.
    expect(row!.description).toContain("Yüzde 50 artış");
  });

  it("strips markup reintroduced into a decoded title", () => {
    const row = mod!.normalizeItem(source, {
      title: "&lt;b&gt;Kalın&lt;/b&gt; başlık",
      link: "/a",
    });
    expect(row).not.toBeNull();
    expect(row!.title).not.toContain("<b>");
    expect(row!.title).toContain("Kalın");
    expect(row!.title).toContain("başlık");
  });
});

// ---------------------------------------------------------------------------
// audit fix A (db-platform): image/video image_url extraction.
//
// fetcher.ts only ever captures a bare URL for media:content /
// media:thumbnail (no medium/type attribute survives the XML mapping), so a
// video posted via media:content was indistinguishable from an image one --
// extractImage returned the .mp4/.m3u8 URL verbatim as `image_url`. Detect
// video candidates by extension and skip them; also upgrade the rcman
// 150x84 default crop to 1280x720 (R3: a 25-URL live sample all returned
// 200 image/* -- see the 084 migration header).
// ---------------------------------------------------------------------------
describe("normalize.ts image extraction: video skip + rcman thumbnail upgrade", () => {
  it("isVideoUrl matches .mp4/.m3u8/.webm/.mov even with a query string or fragment", () => {
    expect(mod!.isVideoUrl("https://cdn.test/clip.mp4")).toBe(true);
    expect(mod!.isVideoUrl("https://cdn.test/clip.mp4?w=100")).toBe(true);
    expect(mod!.isVideoUrl("https://cdn.test/clip.m3u8#t=10")).toBe(true);
    expect(mod!.isVideoUrl("https://cdn.test/photo.jpg")).toBe(false);
  });

  it("prefers a jpg media:thumbnail over an .mp4 media:content", () => {
    const row = mod!.normalizeItem(source, {
      title: "Video haberi",
      link: "/v",
      mediaContent: { $: { url: "https://cdn.test/clip.mp4" } },
      mediaThumbnail: { $: { url: "https://cdn.test/poster.jpg" } },
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBe("https://cdn.test/poster.jpg");
  });

  it("returns null image_url for an .m3u8 enclosure with nothing else to fall back on", () => {
    const row = mod!.normalizeItem(source, {
      title: "Canlı yayın",
      link: "/live",
      enclosure: { url: "https://cdn.test/stream.m3u8" },
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBeNull();
  });

  it("upgrades an rcman 150x84 URL to the 1280x720 variant", () => {
    const row = mod!.normalizeItem(source, {
      title: "Ekonomi haberi",
      link: "/e",
      mediaContent: {
        $: {
          url: "https://img.aydinlik.com.tr/rcman/Cw150h84q95gc/storage/files/images/x.jpg",
        },
      },
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBe(
      "https://img.aydinlik.com.tr/rcman/Cw1280h720q95gc/storage/files/images/x.jpg",
    );
  });

  it("leaves a normal jpg URL unchanged", () => {
    const row = mod!.normalizeItem(source, {
      title: "Genel haber",
      link: "/g",
      mediaContent: { $: { url: "https://cdn.test/normal.jpg" } },
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBe("https://cdn.test/normal.jpg");
  });
});

// ---------------------------------------------------------------------------
// ingest-hygiene: image URL normalisation + legal-notice filter.
//
// haber7-style `https://h//x.jpg` image URLs have their doubled leading slash
// collapsed at ingest (shared normalizeImageUrl); protocol-relative and
// non-http(s) candidates are repaired / skipped. BİK court and official
// notices (all-caps titles ending in an institution name) are dropped
// entirely: normalizeItem returns null and normalizeArticles omits them.
// ---------------------------------------------------------------------------
describe("normalize.ts ingest-hygiene: image URL normalisation", () => {
  it("collapses a doubled leading slash in an enclosure URL", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/n1",
      enclosure: { url: "https://h//x.jpg", type: "image/jpeg" },
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBe("https://h/x.jpg");
  });

  it("upgrades a protocol-relative media:content URL to https", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/n2",
      mediaContent: { $: { url: "//cdn.test/photo.jpg" } },
    });
    expect(row!.image_url).toBe("https://cdn.test/photo.jpg");
  });

  it("skips a non-http(s) candidate and falls through to the next one", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/n3",
      enclosure: { url: "ftp://cdn.test/a.jpg" },
      mediaThumbnail: { $: { url: "https://cdn.test/b.jpg" } },
    });
    expect(row!.image_url).toBe("https://cdn.test/b.jpg");
  });

  it("normalises before the rcman thumbnail upgrade", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/n4",
      mediaContent: {
        $: { url: "https://img.test//rcman/Cw150h84q95gc/storage/x.jpg" },
      },
    });
    expect(row!.image_url).toBe(
      "https://img.test/rcman/Cw1280h720q95gc/storage/x.jpg",
    );
  });

  it("normalises the itemImage fallback", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/n5",
      itemImage: "https://cdn.test//photos/item.jpg",
    });
    expect(row!.image_url).toBe("https://cdn.test/photos/item.jpg");
  });

  it("normalises the <img src> fallback in item HTML", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/n6",
      content: '<p><img src="https://cdn.test//photos/inline.jpg" alt=""></p>',
    });
    expect(row!.image_url).toBe("https://cdn.test/photos/inline.jpg");
  });

  it("ignores a relative <img src> (cannot be rendered by the optimizer)", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/n7",
      content: '<p><img src="/photos/inline-relative.jpg" alt=""></p>',
    });
    expect(row!.image_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// posta-image-url (2026-10-22): posta's feed has no enclosure / media:* /
// <image>; the picture is the first `<img src>` in the CDATA <description>
// (mapRssItem puts it in `content`), and the publisher itself glues two Mongo
// ObjectIds together there: `<id1>.jpg<id2>.jpg`. The joined string is
// literally in the XML, so the shared normalizeImageUrl repair is the ingest
// fix and extractImage needed no logic change. The first id is a constant
// placeholder; the second is the real image (see
// tests/functions/_shared/image-url.test.ts for the HEAD evidence).
// ---------------------------------------------------------------------------
describe("normalize.ts posta-image-url: joined ObjectId <img src> in the description", () => {
  const BASE = "https://image.posta.com.tr/i/posta/90/0x0/";
  const JOINED = `${BASE}627e113be4bfdc26aca117f5.jpg6ad93ca7b65de53ef53ba8ca.jpg`;
  const HEALED = `${BASE}6ad93ca7b65de53ef53ba8ca.jpg`;

  it("stores the healed URL for a posta-shaped item (content = <description> HTML)", () => {
    const html = `<img src="${JOINED}"/><p>Aksaray’da 3 araç ile bir motosikletin karıştığı zincirleme trafik kazasında...</p>`;
    const row = mod!.normalizeItem(source, {
      title: "Yer: Aksaray! 4 araç birbirine girdi: 3 yaralı",
      link: "https://www.posta.com.tr/gundem/yer-aksaray-4-arac-birbirine-girdi-3-yarali-3055026",
      content: html,
      contentSnippet: html,
      pubDate: "Wed, 21 Oct 2026 22:28:56 Z",
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBe(HEALED);
  });

  it("heals a joined URL in the content:encoded HTML as well", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/posta-ce",
      contentEncoded: `<p><img src='${JOINED}' alt=''></p>`,
    });
    expect(row!.image_url).toBe(HEALED);
  });

  it("heals a joined URL carried by an enclosure / media candidate too", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/posta-enc",
      enclosure: { url: JOINED, type: "image/jpeg" },
    });
    expect(row!.image_url).toBe(HEALED);
    const viaMedia = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/posta-media",
      mediaContent: { $: { url: JOINED } },
    });
    expect(viaMedia!.image_url).toBe(HEALED);
  });

  it("heals the doubled-slash + joined combination in one pass", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/posta-both",
      content: `<img src="https://image.posta.com.tr//i/posta/90/0x0/627e113be4bfdc26aca117f5.jpg6ad93ca7b65de53ef53ba8ca.jpg"/>`,
    });
    expect(row!.image_url).toBe(HEALED);
  });

  it("leaves an already-clean posta image URL unchanged", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/posta-clean",
      content: `<img src="${HEALED}"/>`,
    });
    expect(row!.image_url).toBe(HEALED);
  });
});

// ---------------------------------------------------------------------------
// gif-filter (http-1): haber7 and elips-haber advertise a 22.3 MB animated
// placeholder GIF as the feed image. /_next/image passes animated GIFs through
// unmodified, so ingest stores NULL (not the .gif) and lets the next
// candidate -- or the logo-fallback tier at render time -- take over.
// ---------------------------------------------------------------------------
describe("normalize.ts gif-filter: animated GIFs are never stored as image_url", () => {
  const GIF = "https://i12.haber7.net/x/rlQtL_1579004365_7688.gif";

  it("prefers a jpg media:thumbnail over a .gif enclosure", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/gif1",
      enclosure: { url: GIF },
      mediaThumbnail: { $: { url: "https://cdn.test/poster.jpg" } },
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBe("https://cdn.test/poster.jpg");
  });

  it("returns null image_url for a .gif-only enclosure", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/gif2",
      enclosure: { url: GIF, type: "image/gif" },
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBeNull();
  });

  it("skips an image/gif enclosure even when the URL has no .gif extension", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/gif3",
      enclosure: { url: "https://cdn.test/media/12345", type: "image/gif" },
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBeNull();
  });

  it("treats the enclosure type case-insensitively", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/gif3b",
      enclosure: { url: "https://cdn.test/media/12345", type: "Image/GIF" },
      mediaThumbnail: { $: { url: "https://cdn.test/b.jpg" } },
    });
    expect(row!.image_url).toBe("https://cdn.test/b.jpg");
  });

  it("returns null for an inline <img src> that is a .gif", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/gif4",
      content: '<p><img src="https://h/a.gif" alt=""></p>',
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBeNull();
  });

  it("returns null for an itemImage that is a .gif", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/gif5",
      itemImage: "https://cdn.test/photos/item.GIF?v=1",
    });
    expect(row!.image_url).toBeNull();
  });

  it("skips a .gif media:content and uses the media:group thumbnail", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/gif6",
      mediaContent: { $: { url: GIF } },
      mediaGroup: { "media:thumbnail": { $: { url: "https://cdn.test/g.jpg" } } },
    });
    expect(row!.image_url).toBe("https://cdn.test/g.jpg");
  });

  it("still stores a jpg enclosure typed image/jpeg (regression)", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/gif7",
      enclosure: { url: "https://cdn.test/a.jpg", type: "image/jpeg" },
    });
    expect(row!.image_url).toBe("https://cdn.test/a.jpg");
  });
});

describe("normalize.ts ingest-hygiene: legal-notice filter", () => {
  it("returns null for a court notice title", () => {
    const row = mod!.normalizeItem(source, {
      title: "T.C. SAMSUN 2. SULH HUKUK MAHKEMESİNDEN",
      link: "/ilan-1",
    });
    expect(row).toBeNull();
  });

  it("returns null for an /ilan/ url regardless of title case", () => {
    const row = mod!.normalizeItem(source, {
      title: "Satılık araç",
      link: "https://example.test/ilan/12345",
    });
    expect(row).toBeNull();
  });

  it("still normalises an ordinary headline", () => {
    const row = mod!.normalizeItem(source, {
      title: "Merkez Bankası faizi sabit tuttu",
      link: "/haber/faiz",
    });
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Merkez Bankası faizi sabit tuttu");
  });

  it("still normalises real all-caps news that mentions a court mid-headline", () => {
    const row = mod!.normalizeItem(source, {
      title: "ANAYASA MAHKEMESİ CHP'NİN BAŞVURUSUNU REDDETTİ",
      link: "/haber/aym",
    });
    expect(row).not.toBeNull();
  });
});


// ---------------------------------------------------------------------------
// entity-decode: one bad numeric entity must never throw out of
// normalizeArticles (String.fromCodePoint(0x110000) is a RangeError, and one
// throw used to drop EVERY item of the source for that run), and titles /
// descriptions must contain only characters XML 1.0 allows (a `&#11;` decoded
// to a raw VT once broke the whole RSS feed for every subscriber).
// ---------------------------------------------------------------------------
describe("normalize.ts entity-decode: bad numeric references never throw and never leak illegal characters", () => {
  // NON-global copy: a /g regex keeps lastIndex between .test() calls and
  // would make this assertion flaky.
  const illegal = new RegExp(INVALID_XML_CHARS_RE.source);

  const good = { title: "Sağlam başlık", link: "/good", contentSnippet: "Sağlam özet" };

  it.each([
    ["a &#1114112; b", "a  b"],
    ["a &#x110000; b", "a  b"],
    ["a &#0; b", "a  b"],
    ["a &#11; b", "a  b"],
    ["a &#xD800; b", "a  b"],
    ["x&#99999999999999999999;", "x"],
  ])("normalizeArticles survives %j and keeps both rows", (badTitle, expected) => {
    let rows: ReturnType<NormalizeModule["normalizeArticles"]> = [];
    expect(() => {
      rows = mod!.normalizeArticles(source, [
        good,
        { title: badTitle, link: "/bad" },
      ]);
    }).not.toThrow();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.title).toBe("Sağlam başlık");
    expect(rows[1]!.title).toBe(expected);
  });

  it("also survives a bad numeric entity in the description", () => {
    const rows = mod!.normalizeArticles(source, [
      { title: "Başlık", link: "/d", contentSnippet: "özet &#1114112; sonu &#x110000;!" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe("özet  sonu !");
  });

  it("survives an entity so long that Number() overflows to Infinity", () => {
    const rows = mod!.normalizeArticles(source, [
      { title: `a &#${"9".repeat(400)}; b`, link: "/inf" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("a  b");
  });

  it("strips raw XML-illegal characters from the title and from the description", () => {
    const raw = "a\u0001b￾c\uD800d";
    const [row] = mod!.normalizeArticles(source, [
      { title: raw, link: "/raw", contentSnippet: raw },
    ]);
    expect(row!.title).toBe("abcd");
    expect(row!.description).toBe("abcd");
  });

  it("keeps a legal tab / newline inside a description", () => {
    const [row] = mod!.normalizeArticles(source, [
      { title: "Başlık", link: "/ws", contentSnippet: "bir\tiki\nüç" },
    ]);
    expect(row!.description).toBe("bir\tiki\nüç");
  });

  it("still decodes legal numeric references", () => {
    const [row] = mod!.normalizeArticles(source, [
      { title: "ba&#351;l&#x15F;k &#x1F600;", link: "/ok" },
    ]);
    expect(row!.title).toBe("başlşk 😀");
  });

  it("decodes '&#351;' and '&#x15F;' to 'ş' and '&#x1F600;' to the emoji", () => {
    const titles = ["&#351;", "&#x15F;", "&#x1F600;"].map(
      (t) => mod!.normalizeArticles(source, [{ title: t, link: "/e" }])[0]!.title,
    );
    expect(titles).toEqual(["ş", "ş", "😀"]);
  });

  it("keeps single-pass decoding: '&amp;lt;' is the literal '&lt;'", () => {
    const [row] = mod!.normalizeArticles(source, [
      { title: "a &amp;lt; b", link: "/amp" },
    ]);
    expect(row!.title).toBe("a &lt; b");
  });

  it("does not turn an entity-decoded control character back into markup-free garbage", () => {
    // &#60;b&#62; decodes to "<b>", which stripTags removes; the NUL beside it
    // must vanish too.
    const [row] = mod!.normalizeArticles(source, [
      { title: "&#60;b&#62;Kalın&#0;&#60;/b&#62;", link: "/mix" },
    ]);
    expect(row!.title).toBe("Kalın");
  });

  it("a description cut at 500 characters never ends in half an emoji", () => {
    // 496 chars + an emoji (2 UTF-16 units) puts the clamp point at 497,
    // inside the surrogate pair.
    const long = "a".repeat(496) + "😀" + "b".repeat(50);
    const [row] = mod!.normalizeArticles(source, [
      { title: "Başlık", link: "/long", contentSnippet: long },
    ]);
    expect(row!.description!.endsWith("...")).toBe(true);
    expect(illegal.test(row!.description!)).toBe(false);
    expect(row!.description!.length).toBeLessThanOrEqual(500);
  });

  it("no returned title or description contains an XML-illegal character", () => {
    const nasty = [
      "a &#1114112; b",
      "a &#0; b &#11; c &#xD800; d &#xDFFF; e &#xFFFE; f &#xFFFF;",
      "raw \u0000\u0001\u0008\u000B\u000C\u001F￾￿\uD800 \uDC00 end",
      "&#x1F600; 😀 \uD83D",
    ];
    const items = nasty.map((t, i) => ({
      title: t,
      link: `/n${i}`,
      contentSnippet: t,
    }));
    const rows = mod!.normalizeArticles(source, items);
    expect(rows).toHaveLength(nasty.length);
    for (const r of rows) {
      expect(illegal.test(r.title), `title ${JSON.stringify(r.title)}`).toBe(false);
      expect(
        illegal.test(r.description ?? ""),
        `description ${JSON.stringify(r.description)}`,
      ).toBe(false);
    }
  });
});

describe("normalize.ts normalizeArticles: one throwing item is skipped on its own", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips an item whose title is not a string, keeps the good row, logs once", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = mod!.normalizeArticles(source, [
      { title: "Önce", link: "/first" },
      { title: {} as unknown as string, link: "/bad" },
      { title: "Sonra", link: "/last" },
    ]);
    expect(rows.map((r) => r.title)).toEqual(["Önce", "Sonra"]);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    expect(line).toContain(source.slug);
    expect(line).toContain("skipped 1");
  });

  it("logs ONE line per call however many items threw, with the count", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = { title: {} as unknown as string, link: "/bad" };
    const rows = mod!.normalizeArticles(source, [
      bad,
      { title: "İyi", link: "/ok" },
      { ...bad, link: "/bad2" },
      { ...bad, link: "/bad3" },
    ]);
    expect(rows).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain("skipped 3");
  });

  it("does not log when nothing threw", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mod!.normalizeArticles(source, [
      { title: "İyi", link: "/ok" },
      { title: "", link: "/no-title" }, // filtered out, not an error
    ]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("never logs a title or a URL, and truncates the message to 200 characters", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const long = "x".repeat(500);
    const throwing = {
      get title(): string {
        throw new Error(`boom https://secret.example/path?token=1 ${long}`);
      },
      link: "https://secret.example/article",
    } as unknown as { title: string; link: string };
    mod!.normalizeArticles(source, [
      { title: "Gizli başlık", link: "https://secret.example/ok" },
      throwing,
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    expect(line).not.toContain("Gizli başlık");
    expect(line).not.toContain("secret.example");
    expect(line).toContain("skipped 1");
    const message = line.split("that threw: ")[1]!;
    expect(message.length).toBeLessThanOrEqual(200);
  });

  it("keeps the return shape and order for a clean batch", () => {
    const rows = mod!.normalizeArticles(source, [
      { title: "Bir", link: "/1" },
      { title: "İki", link: "/2" },
    ]);
    expect(rows.map((r) => r.title)).toEqual(["Bir", "İki"]);
    expect(rows[0]).toMatchObject({
      source_id: "src-1",
      url: "https://example.test/1",
    });
  });
});
