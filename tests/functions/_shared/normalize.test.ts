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
