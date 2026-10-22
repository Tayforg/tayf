import { beforeAll, describe, expect, it } from "vitest";

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
}

let mod: NormalizeModule | null = null;
let loadError: unknown = null;

beforeAll(async () => {
  try {
    const m = await import(
      "../../../supabase/functions/_shared/rss/normalize.ts"
    );
    mod = { normalizeItem: m.normalizeItem, isVideoUrl: m.isVideoUrl };
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
