import { describe, expect, it } from "vitest";

import {
  extractHeroImageFromHtml,
  extractOgImage,
  isValidImageUrl,
} from "../../../supabase/functions/_shared/og-image.ts";

// ---------------------------------------------------------------------------
// ingest-hygiene: og:image values pass through normalizeImageUrl so a
// publisher's doubled leading slash (`https://h//a/b.jpg`) is repaired before
// it reaches articles.image_url. isValidImageUrl keeps its existing rules.
// ---------------------------------------------------------------------------

describe("extractHeroImageFromHtml: image URL normalisation", () => {
  it("collapses a doubled leading slash in og:image", () => {
    const html =
      '<head><meta property="og:image" content="https://h//a/b.jpg"></head>';
    expect(extractHeroImageFromHtml(html)).toBe("https://h/a/b.jpg");
  });

  it("returns a clean og:image unchanged", () => {
    const html =
      '<meta property="og:image" content="https://cdn.test/photos/a.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe("https://cdn.test/photos/a.jpg");
  });

  it("keeps a mid-path '//' untouched", () => {
    const html =
      '<meta property="og:image" content="https://i20.haber7.net/resize/1280x720//haber/x.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe(
      "https://i20.haber7.net/resize/1280x720//haber/x.jpg",
    );
  });

  it("falls through to the next extractor when the first candidate cannot be normalised", () => {
    const html =
      '<meta property="og:image" content="/relative.jpg">' +
      '<meta name="twitter:image" content="https://cdn.test/tw/a.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe("https://cdn.test/tw/a.jpg");
  });

  // posta-image-url: a joined `<id1>.jpg<id2>.jpg` value (the publisher glues
  // two ObjectIds together; the first is a constant placeholder) is healed to
  // the real second image on every og:image / twitter:image style path.
  it("heals a joined posta ObjectId og:image", () => {
    const html =
      '<head><meta property="og:image" content="https://image.posta.com.tr/i/posta/90/0x0/627e113be4bfdc26aca117f5.jpg6acfb319b65de53ef53b8d3c.jpg"></head>';
    expect(extractHeroImageFromHtml(html)).toBe(
      "https://image.posta.com.tr/i/posta/90/0x0/6acfb319b65de53ef53b8d3c.jpg",
    );
  });

  it("heals a joined posta ObjectId twitter:image and keeps its query string", () => {
    const html =
      '<meta name="twitter:image" content="https://image.posta.com.tr/i/posta/90/0x0/627e113be4bfdc26aca117f5.jpg6acfb319b65de53ef53b8d3c.jpg?v=1">';
    expect(extractHeroImageFromHtml(html)).toBe(
      "https://image.posta.com.tr/i/posta/90/0x0/6acfb319b65de53ef53b8d3c.jpg?v=1",
    );
  });

  it("returns null for empty html", () => {
    expect(extractHeroImageFromHtml("")).toBeNull();
  });

  // gif-filter (http-1): a 22 MB animated placeholder GIF must never be
  // backfilled into articles.image_url.
  it("skips a .gif og:image and returns the jpg twitter:image", () => {
    const html =
      '<meta property="og:image" content="https://i12.haber7.net/x/rlQtL_1579004365_7688.gif">' +
      '<meta name="twitter:image" content="https://cdn.test/tw/a.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe("https://cdn.test/tw/a.jpg");
  });

  it("returns null when every candidate is a .gif", () => {
    const html =
      '<meta property="og:image" content="https://cdn.test/a.gif">' +
      '<meta name="twitter:image" content="https://cdn.test/b.GIF?x=1">';
    expect(extractHeroImageFromHtml(html)).toBeNull();
  });
});

// db-4 ingest half: the backfill must never store a publisher logo card or a
// 'son dakika' stand-in either, or the very job that is meant to find the real
// photo would write the placeholder straight back. Fixtures are the verified
// prod rows from tests/functions/_shared/image-url.test.ts.
describe("db-4 ingest half: placeholder og:image is rejected", () => {
  const CNN =
    "https://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg";
  const HABERLER_COM = "https://foto.haberler.com/haber/2026/07/03/son-dakika_o.jpg";
  const A_HABER =
    "https://iaahbr.tmgrup.com.tr/c18248/1200/675/0/0/1200/675?u=https://iahbr.tmgrup.com.tr/Defaults/Upload/ahbr-default-1754911102530.png";

  it("isValidImageUrl is false for an exact-asset placeholder", () => {
    expect(isValidImageUrl(CNN)).toBe(false);
  });

  it("isValidImageUrl is false for a basename-pattern placeholder", () => {
    expect(isValidImageUrl(HABERLER_COM)).toBe(false);
    expect(
      isValidImageUrl("https://img.piri.net/resim/imagecrop/2026/04/01/09/50/tr_son_dakika_530x530.jpg"),
    ).toBe(false);
  });

  it("isValidImageUrl is false for a resizer URL wrapping a placeholder in u=", () => {
    expect(isValidImageUrl(A_HABER)).toBe(false);
  });

  it("isValidImageUrl still accepts a real photo", () => {
    expect(isValidImageUrl("https://image.cnnturk.com/i/cnnturk/75/1200x675/6710a1b2c3d4e5f607182930.jpg")).toBe(true);
  });

  it("falls through a placeholder og:image to a real twitter:image", () => {
    const html =
      `<meta property="og:image" content="${CNN}">` +
      '<meta name="twitter:image" content="https://cdn.test/tw/real.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe("https://cdn.test/tw/real.jpg");
  });

  it("falls through a placeholder og:image and twitter:image to a real itemprop image", () => {
    const html =
      `<meta property="og:image" content="${CNN}">` +
      `<meta name="twitter:image" content="${HABERLER_COM}">` +
      '<meta itemprop="image" content="https://cdn.test/ip/real.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe("https://cdn.test/ip/real.jpg");
  });

  it("returns null when every candidate is a placeholder", () => {
    const html =
      `<meta property="og:image" content="${CNN}">` +
      `<meta name="twitter:image" content="${HABERLER_COM}">` +
      `<meta itemprop="image" content="${A_HABER}">`;
    expect(extractHeroImageFromHtml(html)).toBeNull();
  });
});

describe("isValidImageUrl keeps its rules", () => {
  it("rejects favicons, data: URIs and non-http(s) values", () => {
    expect(isValidImageUrl("https://cdn.test/favicon.png")).toBe(false);
    expect(isValidImageUrl("data:image/png;base64,AAAAAAAA")).toBe(false);
    expect(isValidImageUrl("/relative/path.jpg")).toBe(false);
  });

  it("accepts a plain https image URL", () => {
    expect(isValidImageUrl("https://cdn.test/photos/a.jpg")).toBe(true);
  });

  it("rejects an animated .gif (gif-filter, http-1)", () => {
    expect(isValidImageUrl("https://h/a.gif")).toBe(false);
    expect(isValidImageUrl("https://cdn.test/photos/A.GIF?x=1")).toBe(false);
    expect(isValidImageUrl("https://i12.haber7.net/x/rlQtL_1579004365_7688.gif")).toBe(false);
  });

  it("still accepts a URL that only mentions gif in its query string or as .gifv", () => {
    expect(isValidImageUrl("https://cdn.test/img?format=gif")).toBe(true);
    expect(isValidImageUrl("https://cdn.test/a.gifv")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hunt-26 security-3: the multi-attribute regexes (a whitespace run followed by
// an optional lazy attribute gap) backtracked super-linearly, so a 1.6 KB
// hostile page held the image-consumer for seconds.
// They are replaced by a tag tokenizer plus a linear attribute scanner. The
// characterization block pins every extraction the regexes supported; the
// timing block pins the hostile inputs.
// ---------------------------------------------------------------------------

describe("extractHeroImageFromHtml: characterization (unchanged behaviour)", () => {
  const OG = "https://cdn.test/og/a.jpg";
  const TW = "https://cdn.test/tw/a.jpg";
  const IP = "https://cdn.test/ip/a.jpg";
  const LS = "https://cdn.test/ls/a.jpg";
  const JC = "https://cdn.test/jc/a.jpg";
  const JU = "https://cdn.test/ju/a.jpg";
  const JS = "https://cdn.test/js/a.jpg";

  it("reads a property-first og:image", () => {
    expect(
      extractHeroImageFromHtml(`<meta property="og:image" content="${OG}">`),
    ).toBe(OG);
  });

  it("reads a content-first og:image", () => {
    expect(
      extractHeroImageFromHtml(`<meta content="${OG}" property="og:image">`),
    ).toBe(OG);
  });

  it("reads a name-first twitter:image", () => {
    expect(
      extractHeroImageFromHtml(`<meta name="twitter:image" content="${TW}">`),
    ).toBe(TW);
  });

  it("reads a content-first twitter:image", () => {
    expect(
      extractHeroImageFromHtml(`<meta content="${TW}" name="twitter:image">`),
    ).toBe(TW);
  });

  it("reads meta itemprop=image", () => {
    expect(
      extractHeroImageFromHtml(`<meta itemprop="image" content="${IP}">`),
    ).toBe(IP);
  });

  it("reads link rel=image_src href", () => {
    expect(
      extractHeroImageFromHtml(`<link rel="image_src" href="${LS}">`),
    ).toBe(LS);
  });

  it("reads a JSON-LD contentUrl", () => {
    const html = `<script type="application/ld+json">{"image":{"@type":"ImageObject","contentUrl":"${JC}"}}</script>`;
    expect(extractHeroImageFromHtml(html)).toBe(JC);
  });

  it("reads a JSON-LD image url", () => {
    const html = `<script type="application/ld+json">{"image":{"@type":"ImageObject","url":"${JU}"}}</script>`;
    expect(extractHeroImageFromHtml(html)).toBe(JU);
  });

  it("reads a plain JSON-LD image string", () => {
    const html = `<script type="application/ld+json">{"image": "${JS}"}</script>`;
    expect(extractHeroImageFromHtml(html)).toBe(JS);
  });

  it("keeps the priority og > twitter > itemprop > image_src > contentUrl > url > string", () => {
    const parts: Array<readonly [string, string]> = [
      [`<meta property="og:image" content="${OG}">`, OG],
      [`<meta name="twitter:image" content="${TW}">`, TW],
      [`<meta itemprop="image" content="${IP}">`, IP],
      [`<link rel="image_src" href="${LS}">`, LS],
      [`<script>{"image":{"contentUrl":"${JC}"}}</script>`, JC],
      [`<script>{"image":{"url":"${JU}"}}</script>`, JU],
      [`<script>{"image":"${JS}"}</script>`, JS],
    ];
    // Dropping the winner one at a time must hand the win to the next kind.
    for (let i = 0; i < parts.length; i++) {
      const html = parts
        .slice(i)
        .map(([markup]) => markup)
        .join("\n");
      expect(extractHeroImageFromHtml(html), `from kind ${i}`).toBe(parts[i]![1]);
    }
  });

  it("is not order-sensitive between kinds: a late og:image still beats an early twitter:image", () => {
    const html =
      `<meta name="twitter:image" content="${TW}">` +
      `<link rel="image_src" href="${LS}">` +
      `<meta property="og:image" content="${OG}">`;
    expect(extractHeroImageFromHtml(html)).toBe(OG);
  });

  it("accepts single-quoted attributes", () => {
    expect(
      extractHeroImageFromHtml(`<meta property='og:image' content='${OG}'>`),
    ).toBe(OG);
    expect(
      extractHeroImageFromHtml(`<link rel='image_src' href='${LS}'>`),
    ).toBe(LS);
  });

  it("is case-insensitive for the tag, attribute names and the property value", () => {
    expect(
      extractHeroImageFromHtml(`<META PROPERTY="OG:IMAGE" CONTENT="${OG}">`),
    ).toBe(OG);
    expect(
      extractHeroImageFromHtml(`<Meta Name="Twitter:Image" Content="${TW}">`),
    ).toBe(TW);
    expect(
      extractHeroImageFromHtml(`<LINK REL="IMAGE_SRC" HREF="${LS}">`),
    ).toBe(LS);
  });

  it("accepts newlines and tabs between attributes", () => {
    expect(
      extractHeroImageFromHtml(
        `<meta\n  property="og:image"\n\tcontent="${OG}"\n>`,
      ),
    ).toBe(OG);
    expect(
      extractHeroImageFromHtml(`<meta\r\ncontent="${OG}"\r\nproperty="og:image"/>`),
    ).toBe(OG);
  });

  it("does not read og:image:width (or another og:image:* property) as og:image", () => {
    expect(
      extractHeroImageFromHtml('<meta property="og:image:width" content="1200">'),
    ).toBeNull();
    expect(
      extractHeroImageFromHtml(
        `<meta property="og:image:width" content="https://cdn.test/w/1200.jpg">` +
          `<meta property="og:image" content="${OG}">`,
      ),
    ).toBe(OG);
  });

  it("returns null for a page with no image markup", () => {
    expect(
      extractHeroImageFromHtml(
        '<html><head><title>x</title><meta name="description" content="y"></head></html>',
      ),
    ).toBeNull();
  });

  it("ignores an og:image tag with an empty content value", () => {
    expect(
      extractHeroImageFromHtml(
        `<meta property="og:image" content=""><meta property="og:image" content="${OG}">`,
      ),
    ).toBe(OG);
  });

  it("lets the first duplicate attribute win", () => {
    expect(
      extractHeroImageFromHtml(
        `<meta property="og:image" content="${OG}" content="https://cdn.test/og/dup.jpg">`,
      ),
    ).toBe(OG);
  });

  it("does not read an image out of a non-meta tag", () => {
    expect(
      extractHeroImageFromHtml(`<div property="og:image" content="${OG}">`),
    ).toBeNull();
    expect(
      extractHeroImageFromHtml(`<metadata property="og:image" content="${OG}">`),
    ).toBeNull();
  });

  it("does not read a link rel other than image_src", () => {
    expect(
      extractHeroImageFromHtml(`<link rel="canonical" href="${LS}">`),
    ).toBeNull();
  });

  it("recovers from an unterminated tag before a good one", () => {
    const html =
      '<meta name="description" content="foo"\n' +
      `<meta property="og:image" content="${OG}">`;
    expect(extractHeroImageFromHtml(html)).toBe(OG);
  });
});

describe("extractHeroImageFromHtml: attributes between property and content (new capability)", () => {
  const URL_OK = "https://cdn.test/photos/extra.jpg";

  it("extracts og:image when another attribute sits between property and content", () => {
    expect(
      extractHeroImageFromHtml(
        `<meta property="og:image" data-x="1" content="${URL_OK}">`,
      ),
    ).toBe(URL_OK);
  });

  it("extracts twitter:image, itemprop and image_src with an extra attribute in between", () => {
    expect(
      extractHeroImageFromHtml(
        `<meta name="twitter:image" data-rh="true" content="${URL_OK}">`,
      ),
    ).toBe(URL_OK);
    expect(
      extractHeroImageFromHtml(
        `<meta itemprop="image" id="x" content="${URL_OK}">`,
      ),
    ).toBe(URL_OK);
    expect(
      extractHeroImageFromHtml(
        `<link rel="image_src" type="image/jpeg" href="${URL_OK}">`,
      ),
    ).toBe(URL_OK);
  });

  it("extracts a content-first og:image with an extra attribute in between", () => {
    expect(
      extractHeroImageFromHtml(
        `<meta content="${URL_OK}" data-x="1" property="og:image">`,
      ),
    ).toBe(URL_OK);
  });

  it("takes the first non-empty tag of a kind in document order (not property-first before content-first)", () => {
    const html =
      `<meta content="${URL_OK}" property="og:image">` +
      '<meta property="og:image" content="https://cdn.test/og/second.jpg">';
    expect(extractHeroImageFromHtml(html)).toBe(URL_OK);
  });

  it("reads an unquoted attribute value", () => {
    expect(
      extractHeroImageFromHtml(`<meta property=og:image content=${URL_OK}>`),
    ).toBe(URL_OK);
  });

  it("treats a whitespace-only content as empty and takes the next tag", () => {
    const html =
      '<meta property="og:image" content="   ">' +
      `<meta property="og:image" content="${URL_OK}">`;
    expect(extractHeroImageFromHtml(html)).toBe(URL_OK);
  });

  it("lets a missing '>' end the tag at the next '<' instead of swallowing the next tag", () => {
    const html =
      '<meta property="og:image" content="https://cdn.test/photos/lost.jpg"\n' +
      `<meta property="og:image" content="${URL_OK}">`;
    // The first tag still carries a complete property/content pair.
    expect(extractHeroImageFromHtml(html)).toBe("https://cdn.test/photos/lost.jpg");
    const swallowed =
      '<meta name="description" content="x"\n' +
      `<meta property="og:image" content="${URL_OK}">`;
    expect(extractHeroImageFromHtml(swallowed)).toBe(URL_OK);
  });

  it("keeps a quote of the other kind inside a quoted value", () => {
    const withApostrophe = "https://cdn.test/photos/o'neil.jpg";
    expect(
      extractHeroImageFromHtml(
        `<meta property="og:image" content="${withApostrophe}">`,
      ),
    ).toBe(withApostrophe);
  });
});

describe("extractOgImage", () => {
  it("returns the og:image URL without validating it", () => {
    // `/favicon.png` style values fail isValidImageUrl but extractOgImage,
    // like fetchOgImage before it, only normalises.
    expect(
      extractOgImage('<meta property="og:image" content="https://cdn.test/favicon.png">'),
    ).toBe("https://cdn.test/favicon.png");
  });

  it("returns the normalised spelling", () => {
    expect(
      extractOgImage('<meta property="og:image" content="https://h//a/b.jpg">'),
    ).toBe("https://h/a/b.jpg");
  });

  it("reads content-first and attribute-in-between spellings", () => {
    expect(
      extractOgImage('<meta content="https://cdn.test/a.jpg" property="og:image">'),
    ).toBe("https://cdn.test/a.jpg");
    expect(
      extractOgImage('<meta property="og:image" data-x="1" content="https://cdn.test/a.jpg">'),
    ).toBe("https://cdn.test/a.jpg");
  });

  it("ignores twitter:image, itemprop, image_src and JSON-LD", () => {
    const html =
      '<meta name="twitter:image" content="https://cdn.test/tw.jpg">' +
      '<meta itemprop="image" content="https://cdn.test/ip.jpg">' +
      '<link rel="image_src" href="https://cdn.test/ls.jpg">' +
      '{"image":"https://cdn.test/js.jpg"}';
    expect(extractOgImage(html)).toBeNull();
  });

  it("does not read og:image:width", () => {
    expect(
      extractOgImage('<meta property="og:image:width" content="1200">'),
    ).toBeNull();
  });

  it("returns null for an og:image that cannot be normalised", () => {
    expect(
      extractOgImage('<meta property="og:image" content="/relative.jpg">'),
    ).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractOgImage("")).toBeNull();
  });
});

describe("hostile pages: no super-linear backtracking", () => {
  const GOOD = "https://cdn.test/photos/good.jpg";
  // Wall-clock budget, sized for a shared CI runner (~5x slower than a laptop,
  // where every case below costs < 10 ms except the JSON-LD x 20k page at ~25 ms)
  // and at least 3x below the pre-fix cost of the cheapest regression it guards
  // (the 1.6 KB page: 1.1 s; the 5,000-space pages: 18-52 s).
  const BUDGET_MS = 300;
  // The JSON-LD x 20k page is the one case that costs ~25 ms locally (~125 ms on
  // CI) and whose pre-fix cost is only 1.3 s, so it gets the widest window that
  // is still 3x below that.
  const BUDGET_OVERRIDES_MS: Readonly<Record<string, number>> = {
    "JSON-LD '\"image\":{' x 20k": 400,
  };
  const budgetFor = (label: string): number => BUDGET_OVERRIDES_MS[label] ?? BUDGET_MS;

  function timed<T>(fn: () => T): { value: T; ms: number } {
    const t0 = performance.now();
    const value = fn();
    return { value, ms: performance.now() - t0 };
  }

  const hostile: Array<readonly [string, string]> = [
    ["meta + 5000 spaces then <title>", "<html><head><meta" + " ".repeat(5000) + "<title>x</title>"],
    ["content-first meta + 5000 spaces", '<html><head><meta content="x"' + " ".repeat(5000)],
    ["content-first meta + 1600 spaces (the 1.6 KB page)", '<html><head><meta content="x"' + " ".repeat(1600)],
    ["meta + 1600 spaces", "<html><head><meta" + " ".repeat(1600)],
    ["non-meta tag with content= + 5000 spaces", '<div content="x"' + " ".repeat(5000)],
    ["link + 5000 spaces", "<link" + " ".repeat(5000)],
    ["link rel=image_src + 5000 spaces", '<link rel="image_src"' + " ".repeat(5000)],
    ["200 KB of '<meta ' with no '>'", "<meta ".repeat(Math.ceil(200_000 / 6))],
    ["200 KB of '<link ' with no '>'", "<link ".repeat(Math.ceil(200_000 / 6))],
    ["200 KB of '<meta property=\"og:image\" ' with no '>'", '<meta property="og:image" '.repeat(8_000)],
    ["JSON-LD '\"image\":{' + 100k spaces", '"image":{' + " ".repeat(100_000)],
    ["JSON-LD '\"image\":{' x 20k", '"image":{'.repeat(20_000)],
    ["tag with a 100k unterminated quote", '<meta property="og:image" content="' + "a".repeat(100_000)],
    ["a 100 KB attribute run inside one tag", "<meta " + "a=1 ".repeat(25_000) + ">"],
  ];

  for (const [label, html] of hostile) {
    it(`extractHeroImageFromHtml returns null in < ${budgetFor(label)} ms: ${label}`, () => {
      const { value, ms } = timed(() => extractHeroImageFromHtml(html));
      expect(value).toBeNull();
      expect(ms).toBeLessThan(budgetFor(label));
    });

    it(`extractOgImage returns null in < ${budgetFor(label)} ms: ${label}`, () => {
      const { value, ms } = timed(() => extractOgImage(html));
      expect(value).toBeNull();
      expect(ms).toBeLessThan(budgetFor(label));
    });
  }

  it("still finds a valid og:image that follows a hostile whitespace run", () => {
    const html =
      "<html><head><meta" +
      " ".repeat(5000) +
      "<title>x</title>" +
      `<meta property="og:image" content="${GOOD}">`;
    const { value, ms } = timed(() => extractHeroImageFromHtml(html));
    expect(value).toBe(GOOD);
    expect(ms).toBeLessThan(BUDGET_MS);
    const og = timed(() => extractOgImage(html));
    expect(og.value).toBe(GOOD);
    expect(og.ms).toBeLessThan(BUDGET_MS);
  });

  it("finds a valid image after 200 KB of unterminated '<meta ' starts", () => {
    const html = "<meta ".repeat(30_000) + `<meta property="og:image" content="${GOOD}">`;
    const { value, ms } = timed(() => extractHeroImageFromHtml(html));
    expect(value).toBe(GOOD);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("stays fast when '>' appears every ~1.9 KB between dense '<meta a=' starts", () => {
    // `<meta a=<meta a=...` keeps every start inside one long attribute run, and
    // a '>' within the 2,000-char limit means every start is parsed; the scan
    // budget keeps the total work bounded.
    const block = "<meta a=".repeat(237) + ">";
    const html = block.repeat(Math.ceil(200_000 / block.length));
    const { value, ms } = timed(() => extractHeroImageFromHtml(html));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(BUDGET_MS);
    const og = timed(() => extractOgImage(html));
    expect(og.value).toBeNull();
    expect(og.ms).toBeLessThan(BUDGET_MS);
  });

  it("skips a tag longer than 2,000 chars but keeps reading the next one", () => {
    const html =
      `<meta property="og:image" ${"x=1 ".repeat(600)} content="https://cdn.test/photos/toolong.jpg">` +
      `<meta name="twitter:image" content="${GOOD}">`;
    expect(extractHeroImageFromHtml(html)).toBe(GOOD);
  });

  it("scales linearly: 8x the input costs far less than 64x the time", () => {
    const small = "<meta ".repeat(5_000) + ">";
    const large = "<meta ".repeat(40_000) + ">";
    // Warm the JIT so the ratio is not dominated by compilation.
    extractHeroImageFromHtml(small);
    const a = timed(() => extractHeroImageFromHtml(small)).ms;
    const b = timed(() => extractHeroImageFromHtml(large)).ms;
    expect(b).toBeLessThan(Math.max(a * 40, 30));
  });
});
