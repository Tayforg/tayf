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
  prepareItem: typeof import(
    "../../../supabase/functions/_shared/rss/normalize.ts"
  )["prepareItem"];
  completeItem: typeof import(
    "../../../supabase/functions/_shared/rss/normalize.ts"
  )["completeItem"];
  prepareArticles: typeof import(
    "../../../supabase/functions/_shared/rss/normalize.ts"
  )["prepareArticles"];
  completeArticles: typeof import(
    "../../../supabase/functions/_shared/rss/normalize.ts"
  )["completeArticles"];
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
      prepareItem: m.prepareItem,
      completeItem: m.completeItem,
      prepareArticles: m.prepareArticles,
      completeArticles: m.completeArticles,
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
    // & decoded once, decimal #231 -> ç, hex #x131 -> ı. The named &ccedil; is
    // a plain-text residue entity (entities.ts RESIDUAL_NAMED_ENTITIES), so it
    // decodes to ç as well instead of reaching readers as literal "&ccedil;".
    expect(row!.title).toContain("Galatasaray & Fenerbahçe");
    expect(row!.title).toContain("maçı");
    expect(row!.title).not.toContain("&ccedil;");
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

// ---------------------------------------------------------------------------
// db-4 ingest half: publisher logo cards and 'son dakika' stand-ins are never
// stored as articles.image_url. A NULL image_url is what queues the og:image
// backfill (articles_image_enqueue trigger), so nulling here is enough for the
// real photo to be found later. Fixture URLs are the verified prod rows already
// used by tests/functions/_shared/image-url.test.ts.
// ---------------------------------------------------------------------------
describe("normalize.ts db-4 ingest half: placeholder images are never stored as image_url", () => {
  const CNN =
    "https://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg";
  const YENI_SAFAK =
    "https://img.piri.net/resim/imagecrop/2026/04/01/09/50/tr_son_dakika_530x530.jpg";
  const ISCI_HABER =
    "https://www.iscihaber.net/cropImages/1280x720/uploads/haberler/default_news_photo.jpg";
  const HABERLER_COM = "https://foto.haberler.com/haber/2026/07/03/son-dakika_o.jpg";
  const A_HABER =
    "https://iaahbr.tmgrup.com.tr/c18248/1200/675/0/0/1200/675?u=https://iahbr.tmgrup.com.tr/Defaults/Upload/ahbr-default-1754911102530.png";

  it("returns null image_url for a cnn-turk placeholder enclosure", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/ph1",
      enclosure: { url: CNN, type: "image/jpeg" },
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBeNull();
  });

  it("skips a placeholder enclosure and uses the real media:thumbnail", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/ph2",
      enclosure: { url: CNN, type: "image/jpeg" },
      mediaThumbnail: { $: { url: "https://cdn.test/real-photo.jpg" } },
    });
    expect(row!.image_url).toBe("https://cdn.test/real-photo.jpg");
  });

  it("skips a placeholder media:content and uses the media:group thumbnail", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/ph3",
      mediaContent: { $: { url: HABERLER_COM } },
      mediaGroup: { "media:thumbnail": { $: { url: "https://cdn.test/g.jpg" } } },
    });
    expect(row!.image_url).toBe("https://cdn.test/g.jpg");
  });

  it("returns null for a yeni-safak tr_son_dakika itemImage", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/ph4",
      itemImage: YENI_SAFAK,
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBeNull();
  });

  it("returns null for an inline <img src> that is the isci-haber default photo", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/ph5",
      content: `<p><img src="${ISCI_HABER}" alt=""></p>`,
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBeNull();
  });

  it("returns null for an a-haber resizer URL wrapping the default image in u=", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/ph6",
      enclosure: { url: A_HABER, type: "image/jpeg" },
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBeNull();
  });

  it("returns null when every candidate on every path is a placeholder", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/ph7",
      enclosure: { url: CNN },
      mediaThumbnail: { $: { url: HABERLER_COM } },
      itemImage: YENI_SAFAK,
      content: `<img src="${ISCI_HABER}">`,
    });
    expect(row!.image_url).toBeNull();
  });

  it("falls through a placeholder itemImage to a real inline <img>", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/ph8",
      itemImage: YENI_SAFAK,
      content: '<p><img src="https://cdn.test/inline-photo.jpg" alt=""></p>',
    });
    expect(row!.image_url).toBe("https://cdn.test/inline-photo.jpg");
  });

  it("leaves a normal article photo unchanged", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/ph9",
      enclosure: { url: "https://cdn.test/photos/2026/10/24/erdogan-konusma.jpg", type: "image/jpeg" },
    });
    expect(row!.image_url).toBe("https://cdn.test/photos/2026/10/24/erdogan-konusma.jpg");
  });

  it("does not reject an article slug that merely contains son-dakika", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/ph10",
      enclosure: {
        url: "https://cdn.test/img/son-dakika-erdogan-aciklama-18123456.jpg",
        type: "image/jpeg",
      },
    });
    expect(row!.image_url).toBe(
      "https://cdn.test/img/son-dakika-erdogan-aciklama-18123456.jpg",
    );
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
    // The emoji sits next to a word: a title that is ONLY an emoji has no
    // letter or digit and is dropped as headline-less (see the contentless
    // titles block at the end of this file).
    const titles = ["&#351;", "&#x15F;", "&#x1F600; gol"].map(
      (t) => mod!.normalizeArticles(source, [{ title: t, link: "/e" }])[0]!.title,
    );
    expect(titles).toEqual(["ş", "ş", "😀 gol"]);
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
      "&#x1F600; 😀 gol \uD83D",
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

// ---------------------------------------------------------------------------
// Entity residue (double-encoded feeds). `decodeEntities` is single-pass by
// design, so "&amp;quot;" used to be stored as the literal text "&quot;" and
// readers saw it. One bounded extra pass (decodeResidualEntities) now runs
// AFTER stripTags, so it fixes one extra level of encoding but can never
// reintroduce markup: it never emits '<' or '>'.
// ---------------------------------------------------------------------------
describe("normalize.ts entity residue: one bounded extra decode pass", () => {
  function descOf(contentSnippet: string) {
    const row = mod!.normalizeItem(source, {
      title: "Başlık",
      link: "/a",
      contentSnippet,
    });
    expect(row).not.toBeNull();
    return row!.description;
  }

  function titled(title: string) {
    const row = mod!.normalizeItem(source, { title, link: "/a" });
    expect(row).not.toBeNull();
    return row!.title;
  }

  it("decodes a double-encoded quote pair in the description", () => {
    expect(
      descOf("Bakan, &amp;quot;kimden gelirse gelsin&amp;quot; dedi"),
    ).toBe('Bakan, "kimden gelirse gelsin" dedi');
  });

  it.each([
    ["&amp;#39;", "'"],
    ["&amp;#8217;", "’"],
    ["&amp;amp;", "&"],
  ])("decodes the double-encoded %j in the description to %j", (raw, expected) => {
    expect(descOf(`a ${raw} b`)).toBe(`a ${expected} b`);
  });

  it("decodes a double-encoded apostrophe in the title", () => {
    expect(titled("Erdoğan&amp;#39;dan açıklama")).toBe("Erdoğan'dan açıklama");
  });

  it("decodes a double-encoded quote in the title", () => {
    expect(titled("&amp;quot;Son dakika&amp;quot; iddiası")).toBe(
      '"Son dakika" iddiası',
    );
  });

  it("leaves a single-encoded quote exactly as before (decoded once, not twice)", () => {
    expect(descOf("&quot;tek&quot; seviye")).toBe('"tek" seviye');
    expect(titled("&#39;tek&#39; seviye")).toBe("'tek' seviye");
  });

  it("decodes a double-encoded named entity: '&amp;nbsp;', '&amp;uuml;', '&amp;hellip;'", () => {
    expect(descOf("a&amp;nbsp;b")).toBe("a b");
    expect(descOf("T&amp;uuml;rkiye bekliyor&amp;hellip;")).toBe(
      "Türkiye bekliyor…",
    );
    expect(titled("Bakan&amp;rsquo;dan &amp;ldquo;a&amp;rdquo;")).toBe(
      "Bakan’dan “a”",
    );
  });

  it("decodes single-encoded named entities the first pass does not know", () => {
    expect(descOf("T&uuml;rkiye &Ccedil;ok bekliyor&hellip;")).toBe(
      "Türkiye Çok bekliyor…",
    );
    expect(titled("Bakan&rsquo;dan")).toBe("Bakan’dan");
  });

  it("leaves an unknown named entity, including an Object.prototype name, untouched", () => {
    expect(titled("a &Foo; b")).toBe("a &Foo; b");
    expect(titled("a &constructor; b")).toBe("a &constructor; b");
    expect(descOf("a &toString; b")).toBe("a &toString; b");
  });

  it("is bounded: '&amp;amp;quot;' decodes exactly one extra level, to '&quot;'", () => {
    expect(descOf("&amp;amp;quot;")).toBe("&quot;");
    expect(titled("&amp;amp;quot; x")).toBe("&quot; x");
  });

  describe("safety: the extra pass never reintroduces markup", () => {
    it("'&amp;amp;lt;script&amp;amp;gt;alert(1)' stays inert text in description and title", () => {
      const raw = "&amp;amp;lt;script&amp;amp;gt;alert(1)";
      const desc = descOf(raw);
      const title = titled(raw);
      expect(desc).toBe("&lt;script&gt;alert(1)");
      expect(title).toBe("&lt;script&gt;alert(1)");
      for (const out of [desc!, title]) {
        expect(out).not.toContain("<");
        expect(out).not.toContain(">");
      }
    });

    it("'&amp;lt;script&amp;gt;' keeps the entity form and has no angle bracket", () => {
      const desc = descOf("&amp;lt;script&amp;gt;");
      const title = titled("&amp;lt;script&amp;gt;");
      for (const out of [desc!, title]) {
        expect(out).toContain("&lt;script&gt;");
        expect(out).not.toContain("<");
        expect(out).not.toContain(">");
      }
    });

    it("'&amp;#60;b&amp;#62;' has no angle bracket", () => {
      const desc = descOf("&amp;#60;b&amp;#62;");
      const title = titled("&amp;#60;b&amp;#62;");
      for (const out of [desc!, title]) {
        expect(out).not.toContain("<");
        expect(out).not.toContain(">");
      }
    });

    it("hex and zero-padded angle-bracket references stay inert once double-encoded or deeper", () => {
      // A SINGLE-encoded "&#x3C;" already decodes to a lone '<' in the
      // pre-existing first pass; the extra pass must add nothing to that.
      for (const ref of ["#x3C;", "#X3e;", "#0060;", "#62;"]) {
        for (const prefix of ["&amp;", "&amp;amp;", "&amp;amp;amp;"]) {
          const raw = `a ${prefix}${ref} b`;
          for (const out of [descOf(raw)!, titled(raw)]) {
            expect(out, raw).not.toContain("<");
            expect(out, raw).not.toContain(">");
          }
        }
      }
    });

    it("decodes a single-encoded named letter and still keeps '&lt;script>' inert", () => {
      expect(titled("ma&ccedil;")).toBe("maç");
      expect(titled("&amp;lt;script&gt; x")).toContain("&lt;script>");
    });

    it("never turns '&amp;lt;' next to a decodable named entity into a bracket", () => {
      for (const out of [
        descOf("&amp;lt;b&amp;gt;T&uuml;rkiye&amp;lt;/b&amp;gt;"),
        titled("&amp;lt;b&amp;gt;T&uuml;rkiye&amp;lt;/b&amp;gt;"),
      ]) {
        expect(out).toBe("&lt;b&gt;Türkiye&lt;/b&gt;");
      }
    });

    it("an illegal numeric reference revealed by the extra pass is dropped, not thrown", () => {
      expect(() => descOf("a &amp;#1114112; b &amp;#0; c")).not.toThrow();
      expect(descOf("a &amp;#1114112; b &amp;#0; c")).toBe("a  b  c");
    });
  });

  it("clamps to 500 characters AFTER the extra pass", () => {
    const desc = descOf("&amp;quot;" + "x".repeat(600));
    expect(desc).not.toBeNull();
    expect(desc!.length).toBe(500);
    expect(desc!.endsWith("...")).toBe(true);
    expect(desc!.startsWith('"')).toBe(true);
  });

  it("does not shift the clamp by the encoded length: 490 residue-quotes fit untruncated", () => {
    // 490 x '&amp;quot;' is 5 000 raw characters but 490 after decoding.
    const desc = descOf("&amp;quot;".repeat(490));
    expect(desc).toBe('"'.repeat(490));
  });
});

// ---------------------------------------------------------------------------
// Headline-less items (hunt-10 C-entity-only-titles). An item whose title is
// only entity residue, punctuation or invisible filler ('&nbsp', '&amp;nbsp',
// '-', '…', U+3164) is not a story: prod rendered one as
// "<title>&amp;nbsp — Tayf</title>", indexable. normalizeItem drops it BEFORE
// the legal-notice check and, when the caller passes a counters object, counts
// it, so the ingest cycle can report how many it threw away.
// ---------------------------------------------------------------------------
describe("normalize.ts contentless titles: dropped and counted", () => {
  const link = "https://example.test/haber/1";

  it.each([
    ["a double-encoded &amp;nbsp (the prod case)", "&amp;nbsp"],
    ["a bare &nbsp", "&nbsp"],
    ["a terminated &nbsp;", "&nbsp;"],
    ["a numeric nbsp", "&#160;"],
    ["a hyphen", "-"],
    ["an ellipsis", "…"],
    ["three dots", "..."],
    ["a HANGUL FILLER (benguturk /reklam/)", "\u3164"],
    ["markup with no text", "<b></b>"],
  ])("returns null and counts %s", (_label, title) => {
    const counters = { contentlessTitles: 0 };
    expect(mod!.normalizeItem(source, { title, link }, 0, counters)).toBeNull();
    expect(counters.contentlessTitles).toBe(1);
  });

  it("an emoji-only title has no letter or digit: dropped and counted", () => {
    const counters = { contentlessTitles: 0 };
    expect(mod!.normalizeItem(source, { title: "&#x1F600; 😀", link }, 0, counters)).toBeNull();
    expect(counters.contentlessTitles).toBe(1);
  });

  it("counts a whitespace-only raw title when the item has a link", () => {
    const counters = { contentlessTitles: 0 };
    expect(mod!.normalizeItem(source, { title: "   ", link }, 0, counters)).toBeNull();
    expect(counters.contentlessTitles).toBe(1);
  });

  it("counts an empty and a missing raw title when the item has a link", () => {
    const counters = { contentlessTitles: 0 };
    expect(mod!.normalizeItem(source, { title: "", link }, 0, counters)).toBeNull();
    expect(mod!.normalizeItem(source, { link }, 0, counters)).toBeNull();
    expect(counters.contentlessTitles).toBe(2);
  });

  it("does not count an item that has no link (nothing to ingest anyway)", () => {
    const counters = { contentlessTitles: 0 };
    expect(mod!.normalizeItem(source, { title: "&nbsp" }, 0, counters)).toBeNull();
    expect(mod!.normalizeItem(source, { title: "Başlık" }, 0, counters)).toBeNull();
    expect(mod!.normalizeItem(source, { title: "", link: "  " }, 0, counters)).toBeNull();
    expect(counters.contentlessTitles).toBe(0);
  });

  it("leaves a normal title unchanged and uncounted", () => {
    const counters = { contentlessTitles: 0 };
    const row = mod!.normalizeItem(
      source,
      { title: "Merkez Bankası faizi sabit tuttu", link },
      0,
      counters,
    );
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Merkez Bankası faizi sabit tuttu");
    expect(counters.contentlessTitles).toBe(0);
  });

  it.each(["AT&T hisseleri yükseldi", "R&D yatırımı", "2025", "a", "Gol!", "%50 zam"])(
    "keeps the short or ampersand-bearing real headline %j",
    (title) => {
      const counters = { contentlessTitles: 0 };
      const row = mod!.normalizeItem(source, { title, link }, 0, counters);
      expect(row).not.toBeNull();
      expect(counters.contentlessTitles).toBe(0);
    },
  );

  it("a BİK legal notice still returns null but is NOT counted as contentless", () => {
    const counters = { contentlessTitles: 0 };
    const row = mod!.normalizeItem(
      source,
      { title: "T.C. SAMSUN 2. SULH HUKUK MAHKEMESİNDEN", link: "/ilan-1" },
      0,
      counters,
    );
    expect(row).toBeNull();
    expect(counters.contentlessTitles).toBe(0);
  });

  it("the contentless check runs before the legal-notice check (an /ilan/ url with no headline is contentless)", () => {
    const counters = { contentlessTitles: 0 };
    const row = mod!.normalizeItem(
      source,
      { title: "&nbsp", link: "https://example.test/ilan/12345" },
      0,
      counters,
    );
    expect(row).toBeNull();
    expect(counters.contentlessTitles).toBe(1);
  });

  it("works without a counters object: the old 2- and 3-argument calls behave as before", () => {
    expect(mod!.normalizeItem(source, { title: "&amp;nbsp", link })).toBeNull();
    expect(mod!.normalizeItem(source, { title: "-", link }, 0)).toBeNull();
    const row = mod!.normalizeItem(source, { title: "Normal başlık", link }, 0);
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Normal başlık");
  });

  it("adds to a counters object that already holds a count", () => {
    const counters = { contentlessTitles: 5 };
    mod!.normalizeItem(source, { title: "…", link }, 0, counters);
    expect(counters.contentlessTitles).toBe(6);
  });

  describe("normalizeArticles", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const batch = [
      { title: "Önce gerçek bir başlık", link: "/1" },
      { title: "&amp;nbsp", link: "/2" },
      { title: "-", link: "/3" },
      { title: "   ", link: "/4" },
      { title: "T.C. ANKARA 3. İCRA DAİRESİNDEN", link: "/5" },
      { title: "Sonra başka bir başlık", link: "/6" },
      { title: "Bağlantısız başlık" }, // no link: dropped, not counted
    ];

    it("totals the contentless items across the batch and returns only the real rows", () => {
      const counters = { contentlessTitles: 0 };
      const rows = mod!.normalizeArticles(source, batch, 0, counters);
      expect(rows.map((r) => r.title)).toEqual([
        "Önce gerçek bir başlık",
        "Sonra başka bir başlık",
      ]);
      expect(counters.contentlessTitles).toBe(3);
    });

    it("the existing 3-argument call returns the same rows and logs nothing extra", () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const rows = mod!.normalizeArticles(source, batch, 0);
      expect(rows.map((r) => r.title)).toEqual([
        "Önce gerçek bir başlık",
        "Sonra başka bir başlık",
      ]);
      expect(errSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("a throwing item is skipped on its own and is not counted as contentless", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const counters = { contentlessTitles: 0 };
      const rows = mod!.normalizeArticles(
        source,
        [
          { title: {} as unknown as string, link: "/bad" },
          { title: "&nbsp", link: "/empty" },
          { title: "İyi", link: "/ok" },
        ],
        0,
        counters,
      );
      expect(rows.map((r) => r.title)).toEqual(["İyi"]);
      expect(counters.contentlessTitles).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// A-ingest-cpu (hunt-11): the normaliser is split into a cheap prepare phase
// (link, title cleanup, contentless check, absolute url) and a heavy complete
// phase (legal notice, canonical url, description, image, date, hash,
// category). Ingest runs the first, looks up which urls are already stored,
// and completes only the rest. normalizeItem / normalizeArticles are the same
// two phases back to back and must behave exactly as before.
// ---------------------------------------------------------------------------

describe("normalize.ts prepare / complete split [A-ingest-cpu]", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const NOW = Date.parse("2026-10-26T07:33:20Z");

  it("prepareItem derives the cleaned title and the absolute url, and keeps the raw item", () => {
    const item = { title: "  Bir &amp; <b>iki</b> &#305;  ", link: " /haber/1 ", contentSnippet: "x" };
    const prepared = mod!.prepareItem(source, item);
    expect(prepared).not.toBeNull();
    expect(prepared!.title).toBe("Bir & iki ı");
    expect(prepared!.url).toBe("https://example.test/haber/1");
    expect(prepared!.item).toBe(item);
    // The same strings the full normaliser stores.
    const full = mod!.normalizeItem(source, item, NOW)!;
    expect(prepared!.title).toBe(full.title);
    expect(prepared!.url).toBe(full.url);
  });

  it("prepareItem does NOT decide the legal-notice drop: that is the heavy phase", () => {
    const item = { title: "T.C. ANKARA 3. SULH HUKUK MAHKEMESİNDEN", link: "https://example.test/x" };
    const prepared = mod!.prepareItem(source, item);
    expect(prepared).not.toBeNull();
    expect(mod!.completeItem(source, prepared!, NOW)).toBeNull();
    expect(mod!.normalizeItem(source, item, NOW)).toBeNull();
  });

  it("a legal notice is not counted as contentless in either phase", () => {
    const counters = { contentlessTitles: 0 };
    const prepared = mod!.prepareItem(
      source,
      { title: "İLAN", link: "https://example.test/x" },
      counters,
    );
    expect(prepared).not.toBeNull();
    mod!.completeItem(source, prepared!, NOW);
    expect(counters.contentlessTitles).toBe(0);
  });

  it("prepareArticles: drops link-less items silently, counts contentless titles, keeps order", () => {
    const counters = { contentlessTitles: 0 };
    const prepared = mod!.prepareArticles(
      source,
      [
        { title: "Bir", link: "/1" },
        { title: "Link yok", link: "" },
        { title: "&nbsp", link: "/2" },
        { title: "   ", link: "/3" },
        { title: "Üç", link: "https://example.test/3" },
      ],
      counters,
    );
    expect(prepared.map((p) => p.title)).toEqual(["Bir", "Üç"]);
    expect(prepared.map((p) => p.url)).toEqual(["https://example.test/1", "https://example.test/3"]);
    expect(counters.contentlessTitles).toBe(2);
  });

  it("prepareArticles: a throwing item is skipped alone, logged once with no title or url", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = {
      get title(): string {
        throw new Error(`boom https://secret.example/path?token=1 ${"x".repeat(500)}`);
      },
      link: "https://secret.example/article",
    } as unknown as { title: string; link: string };
    const prepared = mod!.prepareArticles(source, [
      { title: "Gizli başlık", link: "https://secret.example/ok" },
      throwing,
      { title: {} as unknown as string, link: "/bad" },
      { title: "Sonra", link: "/last" },
    ]);
    expect(prepared.map((p) => p.title)).toEqual(["Gizli başlık", "Sonra"]);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    expect(line).toContain(`[normalize] ${source.slug}: skipped 2 item(s) that threw`);
    expect(line).not.toContain("Gizli başlık");
    expect(line).not.toContain("secret.example");
    expect(line.split("that threw: ")[1]!.length).toBeLessThanOrEqual(200);
  });

  it("prepareArticles logs nothing when nothing threw", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mod!.prepareArticles(source, [{ title: "İyi", link: "/ok" }, { title: "", link: "/no-title" }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("completeArticles: one result per prepared item, null for a legal notice, order kept", () => {
    const prepared = mod!.prepareArticles(source, [
      { title: "Önce", link: "/first" },
      { title: "BARTIN 2. ASLİYE HUKUK MAHKEMESİ", link: "/notice" },
      { title: "Sonra", link: "/last", contentSnippet: "<p>Özet</p>" },
    ]);
    expect(prepared).toHaveLength(3);
    const rows = mod!.completeArticles(source, prepared, NOW);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.title).toBe("Önce");
    expect(rows[1]).toBeNull();
    expect(rows[2]).toMatchObject({ title: "Sonra", description: "Özet", url: "https://example.test/last" });
  });

  it("completeArticles: a throwing item becomes null alone and is logged once without a title or url", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prepared = mod!.prepareArticles(source, [
      { title: "Önce", link: "/first" },
      {
        title: "Gizli başlık",
        link: "https://secret.example/article",
        get contentSnippet(): string {
          throw new Error("boom https://secret.example/path?token=1");
        },
      } as unknown as { title: string; link: string },
      { title: "Sonra", link: "/last" },
    ]);
    expect(prepared).toHaveLength(3);
    const rows = mod!.completeArticles(source, prepared, NOW);
    expect(rows.map((r) => r?.title ?? null)).toEqual(["Önce", null, "Sonra"]);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    expect(line).toContain(`[normalize] ${source.slug}: skipped 1 item(s) that threw`);
    expect(line).not.toContain("secret.example");
    expect(line).not.toContain("Gizli başlık");
  });

  it("prepareArticles + completeArticles produce exactly normalizeArticles' rows", () => {
    const items = [
      { title: "Bir", link: "/1", contentSnippet: "<p>a &amp; b</p>", pubDate: "Mon, 26 Oct 2026 08:30:00 +0300" },
      { title: "İLAN", link: "/2" },
      { title: "", link: "/3" },
      { title: "Üç", link: "" },
      { title: "Dört", link: "https://example.test/4?utm_source=x", pubDate: "garbage" },
    ];
    const whole = { contentlessTitles: 0 };
    const expected = mod!.normalizeArticles(source, items, NOW, whole);
    const split = { contentlessTitles: 0 };
    const rows = mod!
      .completeArticles(source, mod!.prepareArticles(source, items, split), NOW)
      .filter((r): r is NonNullable<typeof r> => r !== null);
    expect(rows).toEqual(expected);
    expect(split).toEqual(whole);
  });
});

// ---------------------------------------------------------------------------
// hunt-15 / A-image-url-hygiene: ingest stores a good image URL. Aksam's feed
// puts a 404 spelling in the enclosure, Oksijen and BBC ship 150/240 px
// variants, mfa.gov.tr advertises its logo as the enclosure, and a few CMSs
// store a host root or a YouTube embed page. The shared normalizeImageUrl does
// the repair; the extractor only adds the icon/logo filter on enclosure and
// media candidates. content_hash never sees any of it.
// ---------------------------------------------------------------------------
describe("normalize.ts hunt-15 A-image-url-hygiene: stored image_url", () => {
  const AKSAM_BROKEN = "https://img3.aksam.com.tr/imgsdisk2026/11/01/halk-tercihini-yapti-bulg-592_2.jpg";
  const AKSAM_GOOD = "https://img3.aksam.com.tr/imgsdisk/2026/11/01/halk-tercihini-yapti-bulg-592_2.jpg";

  it("stores the good aksam spelling when the enclosure is broken and media:content is good", () => {
    const row = mod!.normalizeItem(source, {
      title: "Halk tercihini yaptı",
      link: "/ak1",
      enclosure: { url: AKSAM_BROKEN, type: "image/jpeg" },
      mediaContent: { $: { url: AKSAM_GOOD } },
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBe(AKSAM_GOOD);
  });

  it("stores the repaired aksam spelling when the broken enclosure is the only candidate", () => {
    const row = mod!.normalizeItem(source, {
      title: "Halk tercihini yaptı",
      link: "/ak2",
      enclosure: { url: AKSAM_BROKEN, type: "image/jpeg" },
    });
    expect(row!.image_url).toBe(AKSAM_GOOD);
  });

  it("drops the aksam stand-in photo in either spelling", () => {
    for (const url of [
      "https://img3.aksam.com.tr/imgsdisk2026/01/01/210220191220255418101_2.jpg",
      "https://img3.aksam.com.tr/imgsdisk/2026/01/01/210220191220255418101_2.jpg",
    ]) {
      const row = mod!.normalizeItem(source, {
        title: "Haber başlığı",
        link: "/ak3",
        enclosure: { url, type: "image/jpeg" },
      });
      expect(row!.image_url).toBeNull();
    }
  });

  it("stores an Oksijen 150/84 media image as 1280/720", () => {
    const row = mod!.normalizeItem(source, {
      title: "Bulgaristan'da seçim",
      link: "/ok1",
      mediaContent: {
        $: { url: "https://i.gazeteoksijen.com/2/150/84/storage/files/images/2026/11/01/x-b1mn.jpg" },
      },
    });
    expect(row!.image_url).toBe(
      "https://i.gazeteoksijen.com/2/1280/720/storage/files/images/2026/11/01/x-b1mn.jpg",
    );
  });

  it("stores a BBC ws/240 media image as standard/976", () => {
    const row = mod!.normalizeItem(source, {
      title: "BBC haberi",
      link: "/bbc1",
      mediaThumbnail: {
        $: { url: "https://ichef.bbci.co.uk/ace/ws/240/cpsprodpb/abcd/live/x.jpg.webp" },
      },
    });
    expect(row!.image_url).toBe(
      "https://ichef.bbci.co.uk/ace/standard/976/cpsprodpb/abcd/live/x.jpg.webp",
    );
  });

  it("upgrades the itemImage and inline <img> fallbacks too (via normalizeImageUrl)", () => {
    const viaItem = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/ok2",
      itemImage: "https://i.gazeteoksijen.com/2/150/84/storage/a.jpg",
    });
    expect(viaItem!.image_url).toBe("https://i.gazeteoksijen.com/2/1280/720/storage/a.jpg");
    const viaInline = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/ok3",
      content: '<img src="https://i.gazeteoksijen.com/2/150/84/storage/b.jpg">',
    });
    expect(viaInline!.image_url).toBe("https://i.gazeteoksijen.com/2/1280/720/storage/b.jpg");
  });

  it("keeps upgradeThumbnailUrl exported and delegating (rcman, Oksijen, BBC)", async () => {
    const m = await import("../../../supabase/functions/_shared/rss/normalize.ts");
    expect(m.upgradeThumbnailUrl("https://img.x/rcman/Cw150h84q95gc/s/a.jpg")).toBe(
      "https://img.x/rcman/Cw1280h720q95gc/s/a.jpg",
    );
    expect(m.upgradeThumbnailUrl("https://i.gazeteoksijen.com/2/150/84/s/a.jpg")).toBe(
      "https://i.gazeteoksijen.com/2/1280/720/s/a.jpg",
    );
    expect(m.upgradeThumbnailUrl("https://cdn.test/a.jpg")).toBe("https://cdn.test/a.jpg");
  });

  it("stores the real media:thumbnail when the enclosure is a site logo (mfa.gov.tr)", () => {
    const row = mod!.normalizeItem(source, {
      title: "Dışişleri açıklaması",
      link: "/mfa1",
      enclosure: { url: "https://www.mfa.gov.tr/images/logo.png", type: "image/png" },
      mediaThumbnail: { $: { url: "https://www.mfa.gov.tr/data/Photos/2026/11/foto-1.jpg" } },
    });
    expect(row!.image_url).toBe("https://www.mfa.gov.tr/data/Photos/2026/11/foto-1.jpg");
  });

  it("stores NULL for a logo enclosure with nothing else", () => {
    const row = mod!.normalizeItem(source, {
      title: "Dışişleri açıklaması",
      link: "/mfa2",
      enclosure: { url: "https://www.mfa.gov.tr/images/logo.png", type: "image/png" },
    });
    expect(row).not.toBeNull();
    expect(row!.image_url).toBeNull();
  });

  it("skips a favicon / apple-touch-icon / icon_32 media candidate", () => {
    for (const url of [
      "https://cdn.test/favicon.ico",
      "https://cdn.test/apple-touch-icon.png",
      "https://cdn.test/img/icon_32.png",
      "https://cdn.test/img/site-logo-2x.png",
    ]) {
      const row = mod!.normalizeItem(source, {
        title: "Haber başlığı",
        link: "/ic1",
        mediaContent: { $: { url } },
      });
      expect(row!.image_url).toBeNull();
    }
  });

  it("does not skip a photo whose name merely contains icon or logo inside a word", () => {
    for (const url of [
      "https://cdn.test/2026/11/silicon-vadisi-haberi.jpg",
      "https://cdn.test/2026/11/teknoloji-zirvesi.jpg",
      "https://cdn.test/2026/11/erdogan-ekonomi.jpg",
    ]) {
      const row = mod!.normalizeItem(source, {
        title: "Haber başlığı",
        link: "/ic2",
        enclosure: { url, type: "image/jpeg" },
      });
      expect(row!.image_url).toBe(url);
    }
  });

  it("stores a YouTube embed enclosure as the hqdefault thumbnail", () => {
    const row = mod!.normalizeItem(source, {
      title: "Video haberi",
      link: "/yt1",
      enclosure: { url: "https://www.youtube.com/embed/2lKJof-8DeE" },
    });
    expect(row!.image_url).toBe("https://img.youtube.com/vi/2lKJof-8DeE/hqdefault.jpg");
  });

  it("falls through a host-root enclosure to the next candidate", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/root1",
      enclosure: { url: "https://cdn.istiklal.com.tr/" },
      mediaThumbnail: { $: { url: "https://cdn.istiklal.com.tr/uploads/2026/11/foto.jpg" } },
    });
    expect(row!.image_url).toBe("https://cdn.istiklal.com.tr/uploads/2026/11/foto.jpg");
  });

  it("stores NULL for a host-root enclosure alone, and for a WordPress emoji", () => {
    const root = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/root2",
      enclosure: { url: "https://cdn.istiklal.com.tr/" },
    });
    expect(root!.image_url).toBeNull();
    const emoji = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/emoji1",
      mediaContent: { $: { url: "https://s.w.org/images/core/emoji/15.0.3/72x72/1f449.png" } },
    });
    expect(emoji!.image_url).toBeNull();
  });

  it("stores NULL for a Sözcü 'son-dakikajpg-<hash>' card", () => {
    const row = mod!.normalizeItem(source, {
      title: "Haber başlığı",
      link: "/soz1",
      enclosure: {
        url: "https://sozcu01.sozcucdn.com/sozcu/production/uploads/images/2026/10/son-dakikajpg-fGomF2NHS0uGhDDwDPCbMQ.jpg",
        type: "image/jpeg",
      },
    });
    expect(row!.image_url).toBeNull();
  });

  it("content_hash does not depend on the image URL", () => {
    const base = { title: "Aynı başlık", link: "/hash1", contentSnippet: "Aynı açıklama" };
    const a = mod!.normalizeItem(source, { ...base, enclosure: { url: AKSAM_BROKEN, type: "image/jpeg" } });
    const b = mod!.normalizeItem(source, { ...base });
    expect(a!.content_hash).toBe(b!.content_hash);
  });
});
