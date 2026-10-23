import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Props every mocked next/image render received, in call order. Hoisted so
// the vi.mock factory below (itself hoisted above the imports) can close
// over it. Lets a test assert on the props ClusterCardImage hands to
// next/image (preload / loading / fetchPriority) rather than on how a
// plain <img> happens to serialise them.
const calls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

// next/image needs the App Router's image-optimization machinery
// (request context, loader config) that isn't present when rendering a
// component function in isolation with `react-dom/server` — mocked out to
// a plain <img> so this test can exercise ClusterCardImage's own JSX
// without pulling in Next's image pipeline. House pattern: see
// header-a11y.test.tsx for the same style of minimal per-test mocking.
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    calls.push(props);
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

import {
  ClusterCardImage,
  isUndersizedForSlot,
  measureIntrinsicWidth,
  PROBE_TIMEOUT_MS,
} from "./cluster-card-image";

const here = dirname(fileURLToPath(import.meta.url));
const componentSource = readFileSync(join(here, "cluster-card-image.tsx"), "utf8");

const CREDIT_URL = "https://cdn.outlet.example/foto.jpg";

beforeEach(() => {
  calls.length = 0;
});

describe("ClusterCardImage — photo credit (R1-F1)", () => {
  it("renders the credit line for the currently-displayed candidate when `credits` has an entry for it", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={CREDIT_URL}
        credits={{
          [CREDIT_URL]: {
            href: "https://example.com/articles/a-outlet",
            name: "Outlet Gazete",
          },
        }}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain("Görsel:");
    expect(markup).toContain("Outlet Gazete");
    expect(markup).toContain('href="https://example.com/articles/a-outlet"');
  });

  it("renders no credit line when `credits` is omitted", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={CREDIT_URL}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).not.toContain("Görsel:");
  });

  it("renders no credit line when `credits` has no entry for the current candidate", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={CREDIT_URL}
        credits={{
          "https://cdn.outlet.example/some-other-photo.jpg": {
            href: "https://example.com/articles/other",
            name: "Başka Gazete",
          },
        }}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).not.toContain("Görsel:");
  });

  it("renders no credit line on the logo tier even when `credits` is non-empty", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={null}
        logoSrc="https://example.com/logo.png"
        logoAlt="Outlet Gazete"
        credits={{
          [CREDIT_URL]: {
            href: "https://example.com/articles/a-outlet",
            name: "Outlet Gazete",
          },
        }}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).not.toContain("Görsel:");
  });
});

describe("ClusterCardImage — image URL normalisation (ingest-hygiene)", () => {
  it("renders the normalised src for a protocol-relative '//' URL", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src="//cdn.outlet.example/foto.jpg"
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain('src="https://cdn.outlet.example/foto.jpg"');
    expect(markup).not.toContain('src="//cdn.outlet.example');
  });

  it("collapses a doubled leading path slash on existing rows", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src="https://i12.haber7.net//fotogaleri/x.jpg"
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain('src="https://i12.haber7.net/fotogaleri/x.jpg"');
  });

  it("drops candidates that cannot be normalised and uses the next valid one", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src="/relative-only.jpg"
        srcs={["data:image/png;base64,AAAA", "https://cdn.outlet.example/ok.jpg"]}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain('src="https://cdn.outlet.example/ok.jpg"');
  });

  it("dedupes candidates that only differ by the doubled slash", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src="https://h.example//a.jpg"
        srcs={["https://h.example/a.jpg"]}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    // Single <img> in the output: the two spellings collapse to one candidate.
    expect(markup.match(/<img /g)).toHaveLength(1);
  });

  it("still renders the credit when `credits` is keyed by the raw '//' URL", () => {
    const RAW = "//cdn.outlet.example/foto.jpg";
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={RAW}
        credits={{
          [RAW]: {
            href: "https://example.com/articles/a-outlet",
            name: "Outlet Gazete",
          },
        }}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain("Görsel:");
    expect(markup).toContain("Outlet Gazete");
  });
});

describe("ClusterCardImage — first-party logo tier (ingest-hygiene)", () => {
  it("routes a Google S2 favicon logo through /_next/image", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={null}
        logoSrc="https://www.google.com/s2/favicons?domain=ntv.com.tr&sz=64"
        logoAlt="NTV"
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    // `&` is serialised as `&amp;` in markup.
    expect(markup).toContain(
      'src="/_next/image?url=https%3A%2F%2Fwww.google.com%2Fs2%2Ffavicons',
    );
    expect(markup).toContain("&amp;w=64&amp;q=75");
  });

  it("captions the logo with a full-contrast muted token (no opacity modifier)", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={null}
        logoSrc="https://example.com/logo.png"
        logoAlt="Outlet Gazete"
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain("Outlet Gazete");
    expect(markup).toContain("text-muted-foreground");
    expect(markup).not.toContain("text-muted-foreground/70");
  });

  it("leaves a non-Google logo URL unchanged", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={null}
        logoSrc="https://example.com/logo.png"
        logoAlt="Outlet Gazete"
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain('src="https://example.com/logo.png"');
    expect(markup).not.toContain("/_next/image");
  });
});

// ---------------------------------------------------------------------------
// gif-filter (http-1): haber7 / elips-haber placeholder GIFs are 22 MB and
// pass through /_next/image unmodified. The query boundaries already null
// them; the card drops them too (defence in depth) so a GIF can never reach
// next/image no matter which caller builds the candidate list.
// ---------------------------------------------------------------------------
describe("ClusterCardImage — animated GIF filter (http-1)", () => {
  const GIF = "https://i12.haber7.net/x/rlQtL_1579004365_7688.gif";

  it("skips a .gif src and renders the next jpg candidate", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={GIF}
        srcs={["https://cdn.outlet.example/ok.jpg"]}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain('src="https://cdn.outlet.example/ok.jpg"');
    expect(markup).not.toContain(".gif");
  });

  it("skips a .gif that appears in srcs (query string and upper-case included)", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src="https://cdn.outlet.example/a.GIF"
        srcs={["https://cdn.outlet.example/b.gif?x=1", "https://cdn.outlet.example/c.webp"]}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain('src="https://cdn.outlet.example/c.webp"');
    expect(markup.toLowerCase()).not.toContain(".gif");
  });

  it("falls to the logo tier when the only candidate is a .gif", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={GIF}
        logoSrc="https://example.com/logo.png"
        logoAlt="Outlet Gazete"
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain('src="https://example.com/logo.png"');
    expect(markup).toContain("Outlet Gazete");
    expect(markup).not.toContain(".gif");
  });

  it("falls to the placeholder when the only candidate is a .gif and there is no logo", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={GIF}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).not.toContain("<img");
    expect(markup).not.toContain(".gif");
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Test görseli"');
  });

  it("still renders a .gifv-named or query-only-gif URL (only a .gif path is filtered)", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src="https://cdn.outlet.example/img?format=gif"
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain('src="https://cdn.outlet.example/img?format=gif"');
  });
});

// ---------------------------------------------------------------------------
// browser-6: a priority card renders the same hero twice (the mobile banner
// and the hidden desktop thumbnail). Only the mobile one may preload; the
// desktop one stays lazy but can still raise its fetch priority.
// ---------------------------------------------------------------------------
describe("ClusterCardImage — preload / loading / fetchPriority (browser-6)", () => {
  it("priority={true} preloads and loads eagerly", () => {
    renderToStaticMarkup(
      <ClusterCardImage
        src={CREDIT_URL}
        alt="Test görseli"
        width={768}
        height={576}
        priority
      />,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.preload).toBe(true);
    expect(calls[0]!.loading).toBe("eager");
  });

  it("priority={false} + fetchPriority=\"high\" stays lazy without a preload", () => {
    renderToStaticMarkup(
      <ClusterCardImage
        src={CREDIT_URL}
        alt="Test görseli"
        width={320}
        height={224}
        priority={false}
        fetchPriority="high"
      />,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.loading).toBe("lazy");
    expect(calls[0]!.fetchPriority).toBe("high");
    expect(calls[0]!.preload).toBeFalsy();
  });

  it("defaults to lazy with no preload when neither prop is passed", () => {
    renderToStaticMarkup(
      <ClusterCardImage
        src={CREDIT_URL}
        alt="Test görseli"
        width={320}
        height={224}
      />,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.loading).toBe("lazy");
    expect(calls[0]!.preload).toBeFalsy();
  });

  it("leaves fetchPriority undefined when the prop is not passed", () => {
    renderToStaticMarkup(
      <ClusterCardImage
        src={CREDIT_URL}
        alt="Test görseli"
        width={768}
        height={576}
        priority
      />,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.fetchPriority).toBeUndefined();
  });

  it("forwards fetchPriority=\"low\" and \"auto\" untouched", () => {
    for (const value of ["low", "auto"] as const) {
      calls.length = 0;
      renderToStaticMarkup(
        <ClusterCardImage
          src={CREDIT_URL}
          alt="Test görseli"
          width={320}
          height={224}
          fetchPriority={value}
        />,
      );
      expect(calls[0]!.fetchPriority).toBe(value);
    }
  });
});

// ---------------------------------------------------------------------------
// Undersized candidates: artigercek ships a 150x84 thumbnail as its og:image.
// Stretched across a full-width hero (~358px mobile, 384px cluster page) it
// renders as a blurry smear. Full-width heroes opt in with `minIntrinsicWidth`;
// a candidate whose real pixel width is below it is skipped exactly like an
// onError (next candidate, then logo tier, then gray placeholder).
// ---------------------------------------------------------------------------
describe("isUndersizedForSlot (minIntrinsicWidth)", () => {
  it("flags a 150px-wide image rendered in a visible 358px slot", () => {
    expect(
      isUndersizedForSlot({ naturalWidth: 150, renderedWidth: 358, minIntrinsicWidth: 320 }),
    ).toBe(true);
  });

  it("never flags an image that is not rendered (display:none desktop banner)", () => {
    // The sm:hidden mobile hero is still fetched at the smallest srcset width
    // on desktop, so its naturalWidth is tiny there. clientWidth is 0, and
    // the check must not walk (and fetch) every candidate.
    expect(
      isUndersizedForSlot({ naturalWidth: 150, renderedWidth: 0, minIntrinsicWidth: 320 }),
    ).toBe(false);
  });

  it("keeps an image that is wide enough", () => {
    expect(
      isUndersizedForSlot({ naturalWidth: 1080, renderedWidth: 358, minIntrinsicWidth: 320 }),
    ).toBe(false);
  });

  it("keeps an image exactly at the threshold (boundary is exclusive)", () => {
    expect(
      isUndersizedForSlot({ naturalWidth: 320, renderedWidth: 358, minIntrinsicWidth: 320 }),
    ).toBe(false);
  });

  it("ignores an unknown natural width (0 before decode / on broken images)", () => {
    expect(
      isUndersizedForSlot({ naturalWidth: 0, renderedWidth: 358, minIntrinsicWidth: 320 }),
    ).toBe(false);
  });

  it("is off when minIntrinsicWidth is not provided", () => {
    expect(
      isUndersizedForSlot({ naturalWidth: 150, renderedWidth: 358, minIntrinsicWidth: undefined }),
    ).toBe(false);
    expect(isUndersizedForSlot({ naturalWidth: 150, renderedWidth: 358 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #121 regression: with a srcset of w-descriptors, `img.naturalWidth` is
// DENSITY-CORRECTED (intrinsic px / (selected w / sizes px)), so on a DPR>=2
// screen a real 460px photo reads ~216 and was wrongly skipped by the 320
// floor. The slot must judge the real intrinsic width, measured by a probe
// `Image` that has no srcset (so it reports pixels, not CSS px).
// ---------------------------------------------------------------------------
describe("measureIntrinsicWidth (density-corrected naturalWidth, #121)", () => {
  // What next/image emits for the 390px mobile card hero at DPR2: the first
  // deviceSize >= 2 * 390 is 828, so the browser picks the 828w candidate.
  const NEXT_IMG =
    "/_next/image?url=https%3A%2F%2Fcdn.outlet.example%2Ffoto.jpg&w=828&q=75";
  const W_SRCSET = `/_next/image?url=x&w=384&q=75 384w, ${NEXT_IMG} 828w`;

  type Outcome = { kind: "load"; naturalWidth: number } | { kind: "error" };

  /**
   * Fake `Image` constructor. Records every probe it builds. Assigning `src`
   * schedules the load/error asynchronously, like a real (cached) image.
   */
  function fakeImageFactory(outcome: Outcome) {
    const probes: Array<{
      src: string;
      srcset?: string;
      sizes?: string;
      naturalWidth: number;
      onload: (() => void) | null;
      onerror: (() => void) | null;
    }> = [];
    const make = vi.fn(() => {
      let src = "";
      const probe = {
        naturalWidth: 0,
        onload: null as (() => void) | null,
        onerror: null as (() => void) | null,
        get src() {
          return src;
        },
        set src(value: string) {
          src = value;
          queueMicrotask(() => {
            if (outcome.kind === "load") {
              probe.naturalWidth = outcome.naturalWidth;
              probe.onload?.();
            } else {
              probe.onerror?.();
            }
          });
        },
      };
      probes.push(probe);
      return probe as unknown as HTMLImageElement;
    });
    return { make, probes };
  }

  it("(a) reads the real 460px width through the probe when naturalWidth is density-corrected to 216 (Milliyet)", async () => {
    const { make, probes } = fakeImageFactory({ kind: "load", naturalWidth: 460 });

    const width = await measureIntrinsicWidth(
      { naturalWidth: 216, currentSrc: NEXT_IMG, srcset: W_SRCSET },
      make,
    );

    expect(width).toBe(460);
    // The probe loads exactly the URL the element chose, with no srcset/sizes
    // of its own, so it reports raw pixels and comes from the memory cache.
    expect(make).toHaveBeenCalledTimes(1);
    expect(probes[0]!.src).toBe(NEXT_IMG);
    expect(probes[0]!.srcset).toBeUndefined();
    expect(probes[0]!.sizes).toBeUndefined();
    // The real width clears the 320 floor ...
    expect(
      isUndersizedForSlot({ naturalWidth: width, renderedWidth: 358, minIntrinsicWidth: 320 }),
    ).toBe(false);
    // ... whereas the raw density-corrected value is what caused the bug.
    expect(
      isUndersizedForSlot({ naturalWidth: 216, renderedWidth: 358, minIntrinsicWidth: 320 }),
    ).toBe(true);
  });

  it("(a) also keeps the 639px Son Dakika photo that reads 300 through naturalWidth", async () => {
    const { make } = fakeImageFactory({ kind: "load", naturalWidth: 639 });

    const width = await measureIntrinsicWidth(
      { naturalWidth: 300, currentSrc: NEXT_IMG, srcset: W_SRCSET },
      make,
    );

    expect(width).toBe(639);
    expect(
      isUndersizedForSlot({ naturalWidth: width, renderedWidth: 358, minIntrinsicWidth: 320 }),
    ).toBe(false);
  });

  it("(b) still flags a genuinely tiny image (artigercek 150x84) as undersized", async () => {
    const { make } = fakeImageFactory({ kind: "load", naturalWidth: 150 });

    const width = await measureIntrinsicWidth(
      { naturalWidth: 70, currentSrc: NEXT_IMG, srcset: W_SRCSET },
      make,
    );

    expect(width).toBe(150);
    expect(
      isUndersizedForSlot({ naturalWidth: width, renderedWidth: 358, minIntrinsicWidth: 320 }),
    ).toBe(true);
  });

  it("(c) returns naturalWidth as-is, with no probe, when the srcset is empty", async () => {
    const { make } = fakeImageFactory({ kind: "load", naturalWidth: 9999 });

    const width = await measureIntrinsicWidth(
      { naturalWidth: 460, currentSrc: "https://cdn.outlet.example/foto.jpg", srcset: "" },
      make,
    );

    expect(width).toBe(460);
    expect(make).not.toHaveBeenCalled();
  });

  it("(d) resolves 0 (unknown, so the image is kept) when the probe errors", async () => {
    const { make } = fakeImageFactory({ kind: "error" });

    const width = await measureIntrinsicWidth(
      { naturalWidth: 216, currentSrc: NEXT_IMG, srcset: W_SRCSET },
      make,
    );

    expect(width).toBe(0);
    expect(
      isUndersizedForSlot({ naturalWidth: width, renderedWidth: 358, minIntrinsicWidth: 320 }),
    ).toBe(false);
  });

  it("resolves 0 (keep the image) when the probe never settles", async () => {
    vi.useFakeTimers();
    try {
      const silent = () => ({}) as unknown as HTMLImageElement;
      const pending = measureIntrinsicWidth(
        { naturalWidth: 216, currentSrc: NEXT_IMG, srcset: W_SRCSET },
        silent,
      );
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
      await expect(pending).resolves.toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes for an x-descriptor srcset too (naturalWidth is density-corrected there as well)", async () => {
    const { make } = fakeImageFactory({ kind: "load", naturalWidth: 700 });

    const width = await measureIntrinsicWidth(
      { naturalWidth: 350, currentSrc: NEXT_IMG, srcset: `${NEXT_IMG} 1x, ${NEXT_IMG} 2x` },
      make,
    );

    expect(width).toBe(700);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("resolves 0 without probing when there is a srcset but no currentSrc to probe", async () => {
    // An empty `src` never fires load/error, so probing would hang forever.
    const { make } = fakeImageFactory({ kind: "load", naturalWidth: 460 });

    const width = await measureIntrinsicWidth(
      { naturalWidth: 216, currentSrc: "", srcset: W_SRCSET },
      make,
    );

    expect(width).toBe(0);
    expect(make).not.toHaveBeenCalled();
  });

  it("resolves 0 when the probe reports no decoded width", async () => {
    const { make } = fakeImageFactory({ kind: "load", naturalWidth: 0 });

    const width = await measureIntrinsicWidth(
      { naturalWidth: 216, currentSrc: NEXT_IMG, srcset: W_SRCSET },
      make,
    );

    expect(width).toBe(0);
  });

  it("defaults to the DOM global Image constructor (not the next/image component imported in the module)", async () => {
    const constructed: Array<{ src: string }> = [];
    class GlobalFakeImage {
      naturalWidth = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private _src = "";
      constructor() {
        constructed.push(this);
      }
      get src() {
        return this._src;
      }
      set src(value: string) {
        this._src = value;
        queueMicrotask(() => {
          this.naturalWidth = 512;
          this.onload?.();
        });
      }
    }
    vi.stubGlobal("Image", GlobalFakeImage);
    try {
      const width = await measureIntrinsicWidth({
        naturalWidth: 240,
        currentSrc: NEXT_IMG,
        srcset: W_SRCSET,
      });

      expect(width).toBe(512);
      expect(constructed).toHaveLength(1);
      expect(constructed[0]!.src).toBe(NEXT_IMG);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves 0 instead of rejecting when the probe cannot be constructed", async () => {
    const make = vi.fn(() => {
      throw new Error("no Image in this environment");
    });

    await expect(
      measureIntrinsicWidth(
        { naturalWidth: 216, currentSrc: NEXT_IMG, srcset: W_SRCSET },
        make as unknown as () => HTMLImageElement,
      ),
    ).resolves.toBe(0);
  });
});

describe("ClusterCardImage — minIntrinsicWidth wiring", () => {
  it("does not forward minIntrinsicWidth to next/image, and still wires onLoad", () => {
    renderToStaticMarkup(
      <ClusterCardImage
        src={CREDIT_URL}
        alt="Test görseli"
        width={768}
        height={576}
        minIntrinsicWidth={320}
      />,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("minIntrinsicWidth");
    expect(typeof calls[0]!.onLoad).toBe("function");
  });

  it("renders the first candidate normally (the check only runs after the client load)", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={CREDIT_URL}
        srcs={["https://cdn.outlet.example/second.jpg"]}
        alt="Test görseli"
        width={768}
        height={576}
        minIntrinsicWidth={320}
      />,
    );

    expect(markup).toContain(`src="${CREDIT_URL}"`);
    expect(markup).not.toContain("second.jpg");
  });

  it("source guard: the Image onLoad block judges the measured intrinsic width via isUndersizedForSlot and advances idx", () => {
    const start = componentSource.indexOf("onLoad={");
    expect(start).toBeGreaterThan(-1);
    const block = componentSource.slice(start, componentSource.indexOf("/>", start));
    // The width fed to the floor is the probed real width (#121), never the
    // density-corrected img.naturalWidth or a DPR multiple of it.
    expect(block).toContain("measureIntrinsicWidth");
    expect(block).toContain("isUndersizedForSlot");
    expect(block).not.toMatch(/naturalWidth:\s*img\.naturalWidth/);
    expect(block).not.toContain("devicePixelRatio");
    expect(componentSource).not.toContain("devicePixelRatio");
    expect(block).toContain("setIdx");
    // A skipped image must never fade in (no blurry flash).
    expect(block).toContain("setLoaded(false)");
    // The renderedWidth input is what protects the display:none desktop banner.
    expect(block).toContain("clientWidth");
    // The synchronous path (no floor / not rendered) still reveals at once.
    expect(block).toContain("minIntrinsicWidth === undefined");
    expect(block).toContain("setLoaded(true)");
  });

  it("source guard: a probe result is dropped only when the <img> element is no longer connected", () => {
    const start = componentSource.indexOf("onLoad={");
    const block = componentSource.slice(start, componentSource.indexOf("/>", start));
    // The decision happens after the await, behind an element check: the
    // keyed <Image> is removed from the DOM on unmount and on candidate
    // advance, but stays connected inside a hidden <Activity>.
    expect(block).toMatch(/\.isConnected/);
    expect(block.indexOf("isConnected")).toBeGreaterThan(block.indexOf("measureIntrinsicWidth"));
    expect(block.indexOf("isConnected")).toBeLessThan(block.indexOf("isUndersizedForSlot"));
    // No effect-lifetime guard: effect cleanup also runs when <Activity>
    // hides the tree, which dropped the probe and left the hero at
    // opacity-0 after the tree was shown again.
    expect(componentSource).not.toContain("liveRef");
    expect(componentSource).not.toMatch(/\buseEffect\b/);
    expect(componentSource).not.toMatch(/\buseRef\b/);
  });

  it("source guard: the logo <img> class string is untouched (allow-listed by the contrast guard)", () => {
    expect(componentSource).toContain(
      'className="max-h-[50%] max-w-[50%] object-contain opacity-60"',
    );
  });
});
