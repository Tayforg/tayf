import { deflateSync, inflateSync } from "node:zlib";

import { describe, it, expect, vi } from "vitest";

import type { ClusterDetail, ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { BiasCategory, SourceKind } from "@/types";

// Companion to opengraph-image.test.tsx, which mocks `next/og` to inspect
// the element tree. This file keeps ONE real Satori render in the suite so
// a style Satori doesn't support (grid, a pseudo-element, an unsupported
// property) fails here instead of at the first social crawl.

const VALID_ID = "6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b";
const MISSING_ID = "11111111-2222-4333-8444-555555555555";

const getClusterDetailOrThrow = vi.fn();
vi.mock("@/lib/clusters/cluster-detail-query", () => ({
  getClusterDetailOrThrow: (...args: unknown[]) => getClusterDetailOrThrow(...args),
}));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// ---------------------------------------------------------------------------
// Minimal PNG decoder (h20-contracts-1). No dependency: node:zlib only (sharp is
// merely transitive). Reads IHDR, requires 8-bit RGB/RGBA without interlacing,
// joins the IDAT chunks, inflates them and undoes the five scanline filters.
// ---------------------------------------------------------------------------

interface DecodedPng {
  width: number;
  height: number;
  /** Bytes per pixel: 4 for RGBA (colour type 6), 3 for RGB (colour type 2). */
  channels: number;
  /** Unfiltered scanlines, `height * width * channels` bytes, no filter bytes. */
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes: Uint8Array): DecodedPng {
  expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = -1;
  let colorType = -1;
  let interlace = -1;
  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    const start = offset + 8;
    if (type === "IHDR") {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      bitDepth = bytes[start + 8] ?? -1;
      colorType = bytes[start + 9] ?? -1;
      interlace = bytes[start + 12] ?? -1;
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4; // data + CRC
  }
  expect(bitDepth).toBe(8);
  expect([2, 6]).toContain(colorType);
  expect(interlace).toBe(0);
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  expect(idat.length).toBeGreaterThan(0);

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.byteLength).toBe(height * (stride + 1));

  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = y * (stride + 1) + 1;
    const row = y * stride;
    const above = row - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[line + x] ?? 0;
      const left = x >= channels ? (data[row + x - channels] ?? 0) : 0;
      const up = y > 0 ? (data[above + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (data[above + x - channels] ?? 0) : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = up;
          break;
        case 3:
          predictor = (left + up) >> 1;
          break;
        case 4:
          predictor = paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      data[row + x] = (cur + predictor) & 0xff;
    }
  }
  return { width, height, channels, data };
}

type Rgb = readonly [number, number, number];

function pixelAt(png: DecodedPng, x: number, y: number): Rgb {
  const at = (y * png.width + x) * png.channels;
  return [png.data[at] ?? -1, png.data[at + 1] ?? -1, png.data[at + 2] ?? -1];
}

/** Encode `pixels` (RGBA, row-major) with one chosen filter type per row. */
function encodeRgbaPng(width: number, height: number, pixels: Uint8Array, filters: number[]): Uint8Array {
  const channels = 4;
  const stride = width * channels;
  const body = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length] ?? 0;
    body[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const cur = pixels[y * stride + x] ?? 0;
      const left = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (pixels[(y - 1) * stride + x - channels] ?? 0) : 0;
      const predictor =
        filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      body[y * (stride + 1) + 1 + x] = (cur - predictor) & 0xff;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    return out; // the CRC is left at zero: the decoder under test does not read it
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(PNG_SIGNATURE),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(body)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function blindspotDetail(): ClusterDetail {
  return {
    cluster: {
      id: VALID_ID,
      title_tr:
        "Cumhurbaşkanı Erdoğan, Şanlıurfa'daki güneş enerjisi santrali açılışında muhalefete yüklendi; İstanbul'da öğretmenler grev kararı aldı",
      title_original: null,
      title_method: null,
      summary_tr: "Özet",
      article_count: 7,
      bias_distribution: {
        pro_government: 4,
        gov_leaning: 2,
        state_media: 1,
        center: 0,
        opposition_leaning: 0,
        opposition: 0,
        nationalist: 0,
        islamist_conservative: 0,
        pro_kurdish: 0,
        international: 0,
      },
      is_blindspot: true,
      blindspot_side: "pro_government",
      first_published: "2026-07-01T10:00:00Z",
      updated_at: "2026-07-01T12:00:00Z",
      is_archived: false,
    },
    members: [],
    allSources: [],
    wire: { isWireRedistribution: false, effectiveArticleCount: 7, memberCount: 7 },
    blindspotSuppressed: false,
    blindspotRecallVetoed: false,
  };
}

async function pngBytes(res: Response): Promise<Uint8Array> {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  return new Uint8Array(await res.arrayBuffer());
}

describe("cluster opengraph-image (real Satori render)", () => {
  it("renders the blindspot ribbon card to a real PNG", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(blindspotDetail());
    const { default: Image } = await import("./opengraph-image");

    const bytes = await pngBytes(
      await Image({ params: Promise.resolve({ id: VALID_ID }) }),
    );

    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE);
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  });

  it("renders the densest layout — blindspot ribbon + wire pill + chips — to a real PNG", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce({
      ...blindspotDetail(),
      wire: { isWireRedistribution: true, effectiveArticleCount: 1, memberCount: 7 },
    });
    const { default: Image } = await import("./opengraph-image");

    const bytes = await pngBytes(
      await Image({ params: Promise.resolve({ id: VALID_ID }) }),
    );

    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE);
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  });

  // h44-consistency-1: the widest top row is the qualified chip ("N kaynak (M
  // sınıflandırılmış)") next to the wire pill. The right padding (x >= 1128)
  // must stay empty: the chip widens, nothing may run off the canvas.
  it("keeps the right padding empty with the qualified source-count chip next to the wire pill", async () => {
    const wire = { isWireRedistribution: true, effectiveArticleCount: 9, memberCount: 9 };
    const base = blindspotDetail();
    const render = async (distribution: ClusterDetail["cluster"]["bias_distribution"]) => {
      getClusterDetailOrThrow.mockResolvedValueOnce({
        ...base,
        cluster: { ...base.cluster, article_count: 9, bias_distribution: distribution },
        wire,
      });
      const { default: Image } = await import("./opengraph-image");
      return decodePng(await pngBytes(await Image({ params: Promise.resolve({ id: VALID_ID }) })));
    };
    // 9 members, 7 voting -> "9 kaynak (7 sınıflandırılmış)"; 9 voting -> "9 kaynak".
    const qualified = await render({ ...base.cluster.bias_distribution, pro_government: 4, gov_leaning: 2, state_media: 1 });
    const plain = await render({ ...base.cluster.bias_distribution, pro_government: 5, gov_leaning: 3, state_media: 1 });

    for (let y = 60; y < 120; y += 6) {
      for (let x = 1136; x < 1200; x += 8) {
        expectNear(pixelAt(qualified, x, y), pixelAt(plain, x, y), `right padding at (${x},${y})`);
      }
    }
  }, 30_000);

  it("sets the exact edge cache-control header on the real Response", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(blindspotDetail());
    const { default: Image } = await import("./opengraph-image");

    const res = await Image({ params: Promise.resolve({ id: VALID_ID }) });

    expect(res.headers.get("cache-control")).toBe(
      "public, s-maxage=600, stale-while-revalidate=300",
    );
  });

  it("sets the same short shared cache-control as the 404 on the not-found card (h30-abuse-2)", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(null);
    const { default: Image } = await import("./opengraph-image");

    const res = await Image({ params: Promise.resolve({ id: MISSING_ID }) });

    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300");
  });

  it("renders the generic unavailable card to a real PNG with no-store when the reader throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getClusterDetailOrThrow.mockRejectedValueOnce(new Error("db down"));
    const { default: Image } = await import("./opengraph-image");

    try {
      const res = await Image({ params: Promise.resolve({ id: VALID_ID }) });

      expect(res.headers.get("cache-control")).toBe("no-store");
      const bytes = await pngBytes(res);
      expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE);
      expect(bytes.byteLength).toBeGreaterThan(1_000);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("renders the twitter-image re-export through the same card", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(null);
    const tw = await import("./twitter-image");
    const og = await import("./opengraph-image");

    expect(tw.default).toBe(og.default);
    expect(tw.size).toEqual({ width: 1200, height: 630 });
    expect(tw.contentType).toBe("image/png");

    const bytes = await pngBytes(
      await tw.default({ params: Promise.resolve({ id: MISSING_ID }) }),
    );
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE);
  });
});

describe("decodePng (the test-local decoder)", () => {
  it("round-trips an image that uses every scanline filter, Paeth included", () => {
    const width = 7;
    const height = 10;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + (i >> 3) * 11 + 5) & 0xff;
    // Rows cycle through filters 0,1,2,3,4,4,3,2,1,0.
    const png = encodeRgbaPng(width, height, pixels, [0, 1, 2, 3, 4, 4, 3, 2, 1, 0]);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.channels).toBe(4);
    expect(Array.from(decoded.data)).toEqual(Array.from(pixels));
    expect(pixelAt(decoded, 3, 4)).toEqual([pixels[(4 * width + 3) * 4], pixels[(4 * width + 3) * 4 + 1], pixels[(4 * width + 3) * 4 + 2]]);
  });
});

// ---------------------------------------------------------------------------
// h20-contracts-1: a headline of ~104+ characters wrapped to 4 lines and pushed
// the İktidar / Bağımsız / Muhalefet legend off the 1200x630 canvas: the legend
// boxes lost their bottom padding and the pixel at (250, 629) was the box fill
// (32,32,35) instead of the page gradient (21,21,24). The card must keep the
// legend row where it is whatever the title.
// ---------------------------------------------------------------------------

/** Cluster 7bc7a2c3-eed1-466b-a2ae-d0b439e9278e, 110 characters, no ribbon. */
const TITLE_110 =
  "Eşinin 'köy yerinde kimse gelmez' sözüne rağmen pes etmeyen kadın, mor renkli eviyle kendi işinin patronu oldu";
/** Cluster 594667c9-5ed8-49a1-af1a-b1b5530ed304 (a blindspot), 96 characters. */
const TITLE_96_RIBBON =
  "İlim Yayma Vakfı Mütevelli Heyeti Başkanı Bilal Erdoğan, HKÜ'de 'Akademik Ödül Töreni'ne katıldı";
const TITLE_200 =
  "Ankara ve İstanbul'da yapılan geniş katılımlı toplantıda hükümet ve muhalefet temsilcileri ekonomik istikrar paketi üzerinde uzlaşmaya varamadı, görüşmeler yarın sabah devam edecek ve oturum ertelendi";
const TITLE_SHORT = "Test kümesi başlığı";
/** Widest glyphs with blanks: the most lines per character that can still wrap. */
const TITLE_WIDE_WORDS = "WWWWWWWW ".repeat(14);
/** Wide capitals with blanks: an all-caps headline is the next-widest case. */
const TITLE_ALL_CAPS =
  "CUMHURBAŞKANI ERDOĞAN ŞANLIURFA'DAKİ GÜNEŞ ENERJİSİ SANTRALİ AÇILIŞINDA KONUŞTU MUHALEFET TEPKİ GÖSTERDİ ÖĞRETMENLER GREV KARARI ALDI";
/** 79 characters: the 64 px / 56 px (ribbon) tier at its widest, 3 lines. */
const TITLE_CAPS_79 = "KURTULMUŞ ÖĞRETMENLER GREV KARARI ALDI MUHALEFET TEPKİ GÖSTERDİ ŞANLIURFA GÜNEŞ";

const LEGEND_PROBE_Y = 629;
/** One probe in each legend tile's column plus the one the hunt measured. */
const LEGEND_PROBE_X = [250, 600, 950] as const;
const CHANNEL_TOLERANCE = 3;

async function renderCard(title: string, ribbon: boolean): Promise<DecodedPng> {
  const base = blindspotDetail();
  getClusterDetailOrThrow.mockResolvedValueOnce({
    ...base,
    cluster: {
      ...base.cluster,
      title_tr: title,
      is_blindspot: ribbon,
      blindspot_side: ribbon ? "pro_government" : null,
    },
  });
  const { default: Image } = await import("./opengraph-image");
  const bytes = await pngBytes(await Image({ params: Promise.resolve({ id: VALID_ID }) }));
  const png = decodePng(bytes);
  expect(png.width).toBe(1200);
  expect(png.height).toBe(630);
  return png;
}

function expectNear(actual: Rgb, reference: Rgb, label: string): void {
  for (let i = 0; i < 3; i++) {
    const a = actual[i] ?? -1;
    const r = reference[i] ?? -1;
    expect(Math.abs(a - r), `${label}: channel ${i} is ${a}, reference ${r}`).toBeLessThanOrEqual(CHANNEL_TOLERANCE);
  }
}

describe("cluster opengraph-image bottom edge (real Satori render)", () => {
  // Renders are memoised per (title, variant): a Satori render costs ~1 s.
  const cards = new Map<string, Promise<DecodedPng>>();
  const cardFor = (title: string, ribbon: boolean): Promise<DecodedPng> => {
    const key = `${ribbon ? "ribbon" : "plain"}|${title}`;
    let card = cards.get(key);
    if (!card) {
      card = renderCard(title, ribbon);
      cards.set(key, card);
    }
    return card;
  };
  // One short-title card per variant is the reference: its bottom row is the
  // page gradient. A card whose legend row has not moved shows the same pixels.
  const referenceCard = (ribbon: boolean): Promise<DecodedPng> => cardFor(TITLE_SHORT, ribbon);

  it("the reference cards show the page gradient at (250,629), not a legend box fill", async () => {
    // The hunt measured (21,21,24) on a card that fits; the box fill is (32,32,35).
    for (const ribbon of [false, true]) {
      const png = await referenceCard(ribbon);
      expectNear(pixelAt(png, 250, LEGEND_PROBE_Y), [21, 21, 24], `ribbon=${ribbon}`);
    }
  }, 30_000);

  const CASES: ReadonlyArray<readonly [string, string, boolean]> = [
    ["the 110-character 7bc7a2c3 title, plain", TITLE_110, false],
    ["the 96-character 594667c9 title, blindspot ribbon", TITLE_96_RIBBON, true],
    ["a 200-character title, plain", TITLE_200, false],
    ["a 200-character title, blindspot ribbon", TITLE_200, true],
    ["a 126-character run of wide 'W' words, plain", TITLE_WIDE_WORDS, false],
    ["a 126-character run of wide 'W' words, blindspot ribbon", TITLE_WIDE_WORDS, true],
    ["a 130-character all-caps headline, plain", TITLE_ALL_CAPS, false],
    ["a 130-character all-caps headline, blindspot ribbon", TITLE_ALL_CAPS, true],
    ["a 79-character all-caps headline (3 lines at the largest size), plain", TITLE_CAPS_79, false],
    ["a 79-character all-caps headline (3 lines at the largest size), blindspot ribbon", TITLE_CAPS_79, true],
  ];

  it.each(CASES)("keeps the legend row on the canvas for %s", async (label, title, ribbon) => {
    const ref = await referenceCard(ribbon);
    const card = await cardFor(title, ribbon);
    for (const x of LEGEND_PROBE_X) {
      expectNear(pixelAt(card, x, LEGEND_PROBE_Y), pixelAt(ref, x, LEGEND_PROBE_Y), `${label} at (${x},${LEGEND_PROBE_Y})`);
    }
  }, 30_000);

  // The strict form: below the title the whole column is the reference's, so
  // the legend row has not moved by even one pixel. It holds for the plain card
  // at the 52 and 44 px sizes (3 lines fit the title box). Two layouts have no
  // room for 3 lines, so the legend gives way there, never off the canvas (the
  // probe above pins that): a 3-line headline at 64 px needs ~5 px more than the
  // plain box has (the legend moves ~3 px), and under the blindspot ribbon the
  // box is ~80 px shorter (a 3-line title pushes the legend ~48-61 px down).
  it.each(CASES.filter(([, title, ribbon]) => !ribbon && title !== TITLE_CAPS_79))(
    "does not move the legend row for %s: the whole column below the title matches the reference",
    async (label, title, ribbon) => {
      const ref = await referenceCard(ribbon);
      const card = await cardFor(title, ribbon);
      // The zone tiles start near y=454 and end at y=566; their 1 px borders
      // would show a shift of even one pixel in this column.
      for (const x of [250, 950]) {
        for (let y = 470; y < 630; y++) {
          expectNear(pixelAt(card, x, y), pixelAt(ref, x, y), `${label} at (${x},${y})`);
        }
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// h57-outbound-1: "KÖR NOKTA — spektrumda sadece İktidar" is 5 characters longer
// than "KÖR NOKTA — sadece İktidar yazdı" at fontSize 26. It must stay one line,
// inside the 72 px side padding, and must not move the legend row (the
// h20-contracts-1 contract above).
// ---------------------------------------------------------------------------

function nonVotingMember(slug: string, kind: SourceKind, bias: BiasCategory): ClusterDetailMember {
  return {
    source: {
      id: slug,
      name: slug,
      slug,
      url: `https://${slug}.example`,
      rss_url: `https://${slug}.example/rss`,
      bias,
      logo_url: null,
      active: true,
      kind,
      trustee_since: null,
      trustee_note: null,
    },
    article: {
      id: `${slug}-1`,
      title: `${slug} başlığı`,
      url: `https://${slug}.example/haber/1`,
      published_at: "2026-07-01T10:00:00Z",
      image_url: null,
      content_hash: `hash-${slug}`,
    },
  };
}

/** Amber ribbon pixels (fill ~ (57,43,22), text (252,211,77)); the page gradient and the white title have r ~ b. */
function ribbonBox(png: DecodedPng): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  for (let y = 118; y < 215; y++) {
    for (let x = 0; x < png.width; x++) {
      const [r, , b] = pixelAt(png, x, y);
      if (r - b >= 20) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, maxX, minY, maxY };
}

describe("cluster opengraph-image qualified ribbon (real Satori render, h57-outbound-1)", () => {
  type Zone = "iktidar" | "muhalefet";
  const cards = new Map<string, Promise<DecodedPng>>();
  const renderRibbonCard = (title: string, zone: Zone, qualified: boolean): Promise<DecodedPng> => {
    const key = `${zone}|${qualified}|${title}`;
    let card = cards.get(key);
    if (!card) {
      card = (async () => {
        const base = blindspotDetail();
        const bias_distribution =
          zone === "iktidar"
            ? { ...base.cluster.bias_distribution }
            : { ...base.cluster.bias_distribution, pro_government: 0, gov_leaning: 0, state_media: 0, opposition: 5, opposition_leaning: 2 };
        // The outsider sits in another zone than the ribbon's, and does not vote.
        const members = qualified
          ? [
              nonVotingMember("son-dakika", "aggregator", zone === "iktidar" ? "center" : "gov_leaning"),
              nonVotingMember("isci-haber", "niche", zone === "iktidar" ? "opposition" : "pro_government"),
            ]
          : [];
        getClusterDetailOrThrow.mockResolvedValueOnce({
          ...base,
          cluster: {
            ...base.cluster,
            title_tr: title,
            bias_distribution,
            blindspot_side: zone === "iktidar" ? "pro_government" : "opposition",
          },
          members,
        });
        const { default: Image } = await import("./opengraph-image");
        const png = decodePng(await pngBytes(await Image({ params: Promise.resolve({ id: VALID_ID }) })));
        expect(png.width).toBe(1200);
        expect(png.height).toBe(630);
        return png;
      })();
      cards.set(key, card);
    }
    return card;
  };

  it("draws a wider but still one-line ribbon, inside the 72 px side padding", async () => {
    const plain = ribbonBox(await renderRibbonCard(TITLE_SHORT, "iktidar", false));
    const qualified = ribbonBox(await renderRibbonCard(TITLE_SHORT, "iktidar", true));
    expect(plain).not.toBeNull();
    expect(qualified).not.toBeNull();
    // Same left edge (alignSelf flex-start inside the 72 px padding) and the same height: one line.
    expect(qualified!.minX).toBe(plain!.minX);
    expect(Math.abs(qualified!.minY - plain!.minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(qualified!.maxY - plain!.maxY)).toBeLessThanOrEqual(1);
    // The qualified text is longer, so the ribbon is wider, and still short of the right padding (x >= 1128).
    expect(qualified!.maxX).toBeGreaterThan(plain!.maxX);
    expect(qualified!.maxX).toBeLessThan(1128);
  }, 30_000);

  it("fits the widest zone label too: 'spektrumda sadece Muhalefet'", async () => {
    const box = ribbonBox(await renderRibbonCard(TITLE_SHORT, "muhalefet", true));
    const plain = ribbonBox(await renderRibbonCard(TITLE_SHORT, "muhalefet", false));
    expect(box).not.toBeNull();
    expect(box!.maxX).toBeLessThan(1128);
    expect(box!.maxX).toBeGreaterThan(plain!.maxX);
    expect(box!.maxY - box!.minY).toBeLessThanOrEqual(plain!.maxY - plain!.minY + 1);
  }, 30_000);

  it("keeps the legend row on the canvas under the qualified ribbon, whatever the title", async () => {
    const ref = await renderRibbonCard(TITLE_SHORT, "iktidar", true);
    // The hunt's probe: the page gradient at (250,629), not a legend box fill (32,32,35).
    expectNear(pixelAt(ref, 250, LEGEND_PROBE_Y), [21, 21, 24], "reference at (250,629)");
    for (const title of [TITLE_96_RIBBON, TITLE_200, TITLE_ALL_CAPS]) {
      const card = await renderRibbonCard(title, "iktidar", true);
      for (const x of LEGEND_PROBE_X) {
        expectNear(
          pixelAt(card, x, LEGEND_PROBE_Y),
          pixelAt(ref, x, LEGEND_PROBE_Y),
          `${title.slice(0, 24)}... at (${x},${LEGEND_PROBE_Y})`,
        );
      }
    }
  }, 60_000);

  it("lays the qualified card out exactly like the unqualified ribbon card below the ribbon (same title box)", async () => {
    const plain = await renderRibbonCard(TITLE_96_RIBBON, "iktidar", false);
    const qualified = await renderRibbonCard(TITLE_96_RIBBON, "iktidar", true);
    for (const x of [250, 950]) {
      for (let y = 470; y < 630; y++) {
        expectNear(pixelAt(qualified, x, y), pixelAt(plain, x, y), `legend column at (${x},${y})`);
      }
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// h108-sharesurfaces-1: a blindspot Jev's recall stage matched with the same event
// (cluster 0746c9d2) now reads "KÖR NOKTA — kümede sadece İktidar" instead of
// "... sadece İktidar yazdı". The card must still render to a real PNG, with the
// ribbon on ONE line inside the 72 px side padding, no wider than the
// "spektrumda sadece" ribbon that already fits, and the rows below it unmoved.
// ---------------------------------------------------------------------------
describe("cluster opengraph-image recall-matched ribbon (real Satori render, h108-sharesurfaces-1)", () => {
  type Zone = "iktidar" | "muhalefet";
  type Mode = "plain" | "spectrum" | "recall";
  const cards = new Map<string, Promise<DecodedPng>>();
  const renderCard = (title: string, zone: Zone, mode: Mode): Promise<DecodedPng> => {
    const key = `${zone}|${mode}|${title}`;
    let card = cards.get(key);
    if (!card) {
      card = (async () => {
        const base = blindspotDetail();
        const bias_distribution =
          zone === "iktidar"
            ? { ...base.cluster.bias_distribution }
            : { ...base.cluster.bias_distribution, pro_government: 0, gov_leaning: 0, state_media: 0, opposition: 5, opposition_leaning: 2 };
        const members =
          mode === "spectrum"
            ? [
                nonVotingMember("son-dakika", "aggregator", zone === "iktidar" ? "center" : "gov_leaning"),
                nonVotingMember("isci-haber", "niche", zone === "iktidar" ? "opposition" : "pro_government"),
              ]
            : [];
        getClusterDetailOrThrow.mockResolvedValueOnce({
          ...base,
          cluster: {
            ...base.cluster,
            title_tr: title,
            bias_distribution,
            blindspot_side: zone === "iktidar" ? "pro_government" : "opposition",
          },
          members,
          ...(mode === "recall"
            ? { recallMatchedZones: zone === "iktidar" ? ["muhalefet" as const] : ["iktidar" as const] }
            : {}),
        });
        const { default: Image } = await import("./opengraph-image");
        const png = decodePng(await pngBytes(await Image({ params: Promise.resolve({ id: VALID_ID }) })));
        expect(png.width).toBe(1200);
        expect(png.height).toBe(630);
        return png;
      })();
      cards.set(key, card);
    }
    return card;
  };

  it("renders a real 1200x630 PNG with a one-line ribbon inside the 72 px side padding", async () => {
    const plain = ribbonBox(await renderCard(TITLE_SHORT, "iktidar", "plain"));
    const recall = ribbonBox(await renderCard(TITLE_SHORT, "iktidar", "recall"));
    expect(plain).not.toBeNull();
    expect(recall).not.toBeNull();
    // Same left edge (alignSelf flex-start inside the 72 px padding) and the same height: one line.
    expect(recall!.minX).toBe(plain!.minX);
    expect(Math.abs(recall!.minY - plain!.minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(recall!.maxY - plain!.maxY)).toBeLessThanOrEqual(1);
    expect(recall!.maxX).toBeLessThan(1128);
    // The ribbon text did change: "kümede sadece İktidar" is not "sadece İktidar yazdı".
    expect(recall!.maxX).not.toBe(plain!.maxX);
  }, 30_000);

  it("is no wider than the 'spektrumda sadece' ribbon that already fits, also for the widest label (Muhalefet)", async () => {
    for (const zone of ["iktidar", "muhalefet"] as const) {
      const spectrum = ribbonBox(await renderCard(TITLE_SHORT, zone, "spectrum"));
      const recall = ribbonBox(await renderCard(TITLE_SHORT, zone, "recall"));
      expect(spectrum).not.toBeNull();
      expect(recall).not.toBeNull();
      expect(recall!.maxX).toBeLessThanOrEqual(spectrum!.maxX);
      expect(recall!.maxY - recall!.minY).toBeLessThanOrEqual(spectrum!.maxY - spectrum!.minY + 1);
    }
  }, 60_000);

  it("keeps the legend row on the canvas under the ribbon, whatever the title", async () => {
    const ref = await renderCard(TITLE_SHORT, "iktidar", "recall");
    expectNear(pixelAt(ref, 250, LEGEND_PROBE_Y), [21, 21, 24], "reference at (250,629)");
    for (const title of [TITLE_96_RIBBON, TITLE_200, TITLE_ALL_CAPS]) {
      const card = await renderCard(title, "iktidar", "recall");
      for (const x of LEGEND_PROBE_X) {
        expectNear(
          pixelAt(card, x, LEGEND_PROBE_Y),
          pixelAt(ref, x, LEGEND_PROBE_Y),
          `${title.slice(0, 24)}... at (${x},${LEGEND_PROBE_Y})`,
        );
      }
    }
  }, 60_000);

  it("lays the card out exactly like the plain ribbon card below the ribbon (same title box)", async () => {
    const plain = await renderCard(TITLE_96_RIBBON, "iktidar", "plain");
    const recall = await renderCard(TITLE_96_RIBBON, "iktidar", "recall");
    for (const x of [250, 950]) {
      for (let y = 470; y < 630; y++) {
        expectNear(pixelAt(recall, x, y), pixelAt(plain, x, y), `legend column at (${x},${y})`);
      }
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// h64-ogcards-3: a cluster whose sources are all toplayıcı / niş (cluster
// 4b5cd9f5: haberler-com + ekonomim) has an all-zero bias_distribution. The card
// drew an empty bar and three "%0 · 0" tiles; it now draws ONE box with the
// "sınıflandırılan kaynak yok" line where the tiles were. Satori must accept the
// layout, the box must sit exactly where the tiles sit, the line must stay on one
// line inside the box's padding, and the bottom padding row must stay background.
// ---------------------------------------------------------------------------

function emptySpectrumDetail(title: string): ClusterDetail {
  const base = blindspotDetail();
  return {
    ...base,
    cluster: {
      ...base.cluster,
      title_tr: title,
      article_count: 2,
      bias_distribution: {
        pro_government: 0,
        gov_leaning: 0,
        state_media: 0,
        center: 0,
        opposition_leaning: 0,
        opposition: 0,
        nationalist: 0,
        islamist_conservative: 0,
        pro_kurdish: 0,
        international: 0,
      },
      is_blindspot: false,
      blindspot_side: null,
    },
    members: [
      nonVotingMember("haberler-com", "aggregator", "gov_leaning"),
      nonVotingMember("ekonomim", "niche", "center"),
    ],
    wire: { isWireRedistribution: false, effectiveArticleCount: 2, memberCount: 2 },
  };
}

/** Sum of the three channels: a cheap brightness for "differs from the page gradient". */
function lumaSum(rgb: Rgb): number {
  return rgb[0] + rgb[1] + rgb[2];
}

/**
 * Rows in [from, to) where column `x` is lighter than the bottom padding row of
 * the same column (the page gradient): the tile/box fill (+11 per channel) and
 * its border are above the margin, the gradient's own drift over 190 rows is not.
 */
function boxRows(png: DecodedPng, x: number, from: number, to: number): { minY: number; maxY: number } | null {
  const bg = lumaSum(pixelAt(png, x, LEGEND_PROBE_Y));
  let minY = Infinity;
  let maxY = -1;
  for (let y = from; y < to; y++) {
    if (lumaSum(pixelAt(png, x, y)) - bg >= 15) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxY < 0 ? null : { minY, maxY };
}

/**
 * The left and right edge of the box/tile row at row `y`: the first x that jumps
 * up in brightness from the pixel two to its left (the 1 px border, +28 per
 * channel, on a gradient that drifts under 1 per 10 px) and the last x that drops
 * back down to the pixel two to its right.
 */
function boxColumns(png: DecodedPng, y: number): { minX: number; maxX: number } | null {
  let minX = Infinity;
  let maxX = -1;
  for (let x = 2; x < png.width - 2; x++) {
    const here = lumaSum(pixelAt(png, x, y));
    if (here - lumaSum(pixelAt(png, x - 2, y)) >= 24 && x < minX) minX = x;
    if (here - lumaSum(pixelAt(png, x + 2, y)) >= 24) maxX = x;
  }
  return maxX < 0 ? null : { minX, maxX };
}

/** Bright text pixels (the line is #e4e4e7) inside the rows/columns given. */
function textBounds(
  png: DecodedPng,
  box: { minY: number; maxY: number },
): { minX: number; maxX: number; minY: number; maxY: number; count: number } | null {
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  let count = 0;
  for (let y = box.minY + 2; y < box.maxY - 1; y++) {
    for (let x = 76; x < 1124; x++) {
      if (pixelAt(png, x, y)[0] >= 110) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return count === 0 ? null : { minX, maxX, minY, maxY, count };
}

describe("cluster opengraph-image empty spectrum (real Satori render, h64-ogcards-3)", () => {
  const cards = new Map<string, Promise<DecodedPng>>();
  const emptyCard = (title: string): Promise<DecodedPng> => {
    let card = cards.get(title);
    if (!card) {
      card = (async () => {
        getClusterDetailOrThrow.mockResolvedValueOnce(emptySpectrumDetail(title));
        const { default: Image } = await import("./opengraph-image");
        const png = decodePng(await pngBytes(await Image({ params: Promise.resolve({ id: VALID_ID }) })));
        expect(png.width).toBe(1200);
        expect(png.height).toBe(630);
        return png;
      })();
      cards.set(title, card);
    }
    return card;
  };
  /** A plain card with a classified source: the tiles are the reference for where the box goes. */
  const tilesCard = (): Promise<DecodedPng> => cardFor("tiles-reference", TITLE_SHORT);
  const refs = new Map<string, Promise<DecodedPng>>();
  const cardFor = (key: string, title: string): Promise<DecodedPng> => {
    let card = refs.get(key);
    if (!card) {
      card = renderCard(title, false);
      refs.set(key, card);
    }
    return card;
  };

  it("renders the empty-state card to a 1200x630 PNG, and the bottom padding row stays the page gradient", async () => {
    const card = await emptyCard(TITLE_SHORT);
    const ref = await tilesCard();
    // The hunt's probe: the page gradient at (250,629), not a box fill (32,32,35).
    expectNear(pixelAt(card, 250, LEGEND_PROBE_Y), [21, 21, 24], "empty card at (250,629)");
    for (const x of LEGEND_PROBE_X) {
      expectNear(pixelAt(card, x, LEGEND_PROBE_Y), pixelAt(ref, x, LEGEND_PROBE_Y), `vs the tiles card at (${x},${LEGEND_PROBE_Y})`);
    }
  }, 30_000);

  it("puts the box exactly where the tiles were: same top, same bottom, same left and right edge", async () => {
    const card = await emptyCard(TITLE_SHORT);
    const ref = await tilesCard();

    // Column 80 is inside the first tile's left padding (the dot starts at 93) and inside the box.
    const tile = boxRows(ref, 80, 440, LEGEND_PROBE_Y);
    const box = boxRows(card, 80, 440, LEGEND_PROBE_Y);
    expect(tile).not.toBeNull();
    expect(box).not.toBeNull();
    // The hunt measured the tiles at y 454..566 (112 px) with the 64 px bottom padding below.
    expect(tile!.maxY).toBeGreaterThanOrEqual(564);
    expect(tile!.maxY).toBeLessThanOrEqual(566);
    expect(Math.abs(box!.minY - tile!.minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(box!.maxY - tile!.maxY)).toBeLessThanOrEqual(1);

    const row = Math.round((tile!.minY + tile!.maxY) / 2);
    const tileCols = boxColumns(ref, row);
    const boxCols = boxColumns(card, row);
    expect(tileCols).not.toBeNull();
    expect(boxCols).not.toBeNull();
    expect(Math.abs(boxCols!.minX - tileCols!.minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(boxCols!.maxX - tileCols!.maxX)).toBeLessThanOrEqual(1);
    // Inside the 72 px side padding.
    expect(boxCols!.minX).toBeGreaterThanOrEqual(72);
    expect(boxCols!.maxX).toBeLessThan(1128);
  }, 30_000);

  it("draws no bar: the 18 px bar's rows above the methodology row are the page gradient", async () => {
    const card = await emptyCard(TITLE_SHORT);
    const ref = await tilesCard();
    // The bar spans x 72..1128, 18 px tall, ~14 + 19 + 12 px above the tiles. Its
    // track is rgba(250,250,250,0.08) over the gradient: lighter than the page.
    const tile = boxRows(ref, 80, 440, LEGEND_PROBE_Y)!;
    const barBottom = tile.minY - 12 - 19 - 14;
    const barTop = barBottom - 18;
    const withBar = boxRows(ref, 600, barTop - 4, barBottom + 4);
    const withoutBar = boxRows(card, 600, barTop - 4, barBottom + 4);
    expect(withBar).not.toBeNull();
    expect(withoutBar).toBeNull();
  }, 30_000);

  it("keeps the line on one line, readable, inside the box's own padding", async () => {
    const card = await emptyCard(TITLE_SHORT);
    const box = boxRows(card, 80, 440, LEGEND_PROBE_Y)!;
    const text = textBounds(card, box);

    expect(text).not.toBeNull();
    // Something legible was drawn (a 22 px, 79-character line is thousands of bright pixels).
    expect(text!.count).toBeGreaterThan(1_000);
    // Inside the box's 1 px border + 20 px padding on both sides (a pixel of side bearing allowed).
    expect(text!.minX).toBeGreaterThanOrEqual(72 + 1 + 20 - 2);
    expect(text!.maxX).toBeLessThanOrEqual(1128 - 1 - 20 + 2);
    // Inside the 16 px vertical padding too: nothing touches the border.
    expect(text!.minY).toBeGreaterThanOrEqual(box.minY + 1 + 16 - 2);
    expect(text!.maxY).toBeLessThanOrEqual(box.maxY - 1 - 16 + 2);
  }, 30_000);

  it.each([
    ["a 110-character title", TITLE_110],
    ["a 200-character title", TITLE_200],
    ["a 126-character run of wide 'W' words", TITLE_WIDE_WORDS],
    ["a 130-character all-caps headline", TITLE_ALL_CAPS],
  ] as const)("keeps the box and the bottom row where they are under %s", async (label, title) => {
    const ref = await emptyCard(TITLE_SHORT);
    const card = await emptyCard(title);
    for (const x of LEGEND_PROBE_X) {
      expectNear(pixelAt(card, x, LEGEND_PROBE_Y), pixelAt(ref, x, LEGEND_PROBE_Y), `${label} at (${x},${LEGEND_PROBE_Y})`);
    }
    // The whole column below the title is the reference's: the box has not moved a pixel.
    for (const x of [250, 950]) {
      for (let y = 470; y < 630; y++) {
        expectNear(pixelAt(card, x, y), pixelAt(ref, x, y), `${label} at (${x},${y})`);
      }
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// h118-shares-1: an all-English cluster (92742df8: daily-sabah, hurriyet-daily-news,
// trt-world) drew "İktidar %100 · 3 / Bağımsız %0 · 0 / Muhalefet %0 · 0". The card
// now prints the English-only line in the box the empty-spectrum state already uses.
// Satori must accept it, the box must sit exactly where the tiles sit, the line must
// stay on ONE line inside the box's padding whatever the headline, and the bottom
// padding row must stay background.
// ---------------------------------------------------------------------------

function isolatedDetail(title: string, ribbon = false): ClusterDetail {
  const base = blindspotDetail();
  return {
    ...base,
    cluster: {
      ...base.cluster,
      title_tr: title,
      title_method: "extractive",
      article_count: 3,
      bias_distribution: {
        ...base.cluster.bias_distribution,
        pro_government: ribbon ? 3 : 2,
        gov_leaning: ribbon ? 0 : 1,
        state_media: 0,
      },
      is_blindspot: ribbon,
      blindspot_side: ribbon ? "pro_government" : null,
    },
    members: [
      nonVotingMember("daily-sabah", "outlet", "pro_government"),
      nonVotingMember("hurriyet-daily-news", "outlet", "gov_leaning"),
      nonVotingMember("trt-world", "outlet", "pro_government"),
    ],
    wire: { isWireRedistribution: false, effectiveArticleCount: 3, memberCount: 3 },
  };
}

describe("cluster opengraph-image language-isolated state (real Satori render, h118-shares-1)", () => {
  const cards = new Map<string, Promise<DecodedPng>>();
  const isoCard = (title: string, ribbon = false): Promise<DecodedPng> => {
    const key = `${ribbon}|${title}`;
    let card = cards.get(key);
    if (!card) {
      card = (async () => {
        getClusterDetailOrThrow.mockResolvedValueOnce(isolatedDetail(title, ribbon));
        const { default: Image } = await import("./opengraph-image");
        const png = decodePng(await pngBytes(await Image({ params: Promise.resolve({ id: VALID_ID }) })));
        expect(png.width).toBe(1200);
        expect(png.height).toBe(630);
        return png;
      })();
      cards.set(key, card);
    }
    return card;
  };
  const refs = new Map<string, Promise<DecodedPng>>();
  /** A plain Turkish card with a classified source: the tiles are the reference for where the box goes. */
  const tilesCard = (): Promise<DecodedPng> => {
    let card = refs.get("tiles");
    if (!card) {
      card = renderCard(TITLE_SHORT, false);
      refs.set("tiles", card);
    }
    return card;
  };
  const EN_TITLE = "Türkiye remembers Atatürk on 88th anniversary of his death";

  it("renders to a 1200x630 PNG, and the bottom padding row stays the page gradient", async () => {
    const card = await isoCard(EN_TITLE);
    const ref = await tilesCard();
    expectNear(pixelAt(card, 250, LEGEND_PROBE_Y), [21, 21, 24], "isolated card at (250,629)");
    for (const x of LEGEND_PROBE_X) {
      expectNear(pixelAt(card, x, LEGEND_PROBE_Y), pixelAt(ref, x, LEGEND_PROBE_Y), `vs the tiles card at (${x},${LEGEND_PROBE_Y})`);
    }
  }, 30_000);

  it("puts the box exactly where the tiles were: same top, same bottom, same left and right edge", async () => {
    const card = await isoCard(EN_TITLE);
    const ref = await tilesCard();

    const tile = boxRows(ref, 80, 440, LEGEND_PROBE_Y);
    const box = boxRows(card, 80, 440, LEGEND_PROBE_Y);
    expect(tile).not.toBeNull();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.minY - tile!.minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(box!.maxY - tile!.maxY)).toBeLessThanOrEqual(1);

    const row = Math.round((tile!.minY + tile!.maxY) / 2);
    const tileCols = boxColumns(ref, row);
    const boxCols = boxColumns(card, row);
    expect(tileCols).not.toBeNull();
    expect(boxCols).not.toBeNull();
    expect(Math.abs(boxCols!.minX - tileCols!.minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(boxCols!.maxX - tileCols!.maxX)).toBeLessThanOrEqual(1);
    expect(boxCols!.minX).toBeGreaterThanOrEqual(72);
    expect(boxCols!.maxX).toBeLessThan(1128);
  }, 30_000);

  it("draws no bar: the 18 px bar's rows above the methodology row are the page gradient", async () => {
    const card = await isoCard(EN_TITLE);
    const ref = await tilesCard();
    const tile = boxRows(ref, 80, 440, LEGEND_PROBE_Y)!;
    const barBottom = tile.minY - 12 - 19 - 14;
    const barTop = barBottom - 18;
    expect(boxRows(ref, 600, barTop - 4, barBottom + 4)).not.toBeNull();
    expect(boxRows(card, 600, barTop - 4, barBottom + 4)).toBeNull();
  }, 30_000);

  it("keeps the line on one line, readable, inside the box's own padding", async () => {
    const card = await isoCard(EN_TITLE);
    const box = boxRows(card, 80, 440, LEGEND_PROBE_Y)!;
    const text = textBounds(card, box);

    expect(text).not.toBeNull();
    expect(text!.count).toBeGreaterThan(1_000);
    expect(text!.minX).toBeGreaterThanOrEqual(72 + 1 + 20 - 2);
    expect(text!.maxX).toBeLessThanOrEqual(1128 - 1 - 20 + 2);
    expect(text!.minY).toBeGreaterThanOrEqual(box.minY + 1 + 16 - 2);
    expect(text!.maxY).toBeLessThanOrEqual(box.maxY - 1 - 16 + 2);
    // One 22 px line is ~28 px from the top of an ascender to the foot of a descender; a wrapped
    // second line would double it.
    expect(text!.maxY - text!.minY).toBeLessThanOrEqual(34);
  }, 30_000);

  it.each([
    ["a 110-character Turkish title", TITLE_110],
    ["a 200-character Turkish title", TITLE_200],
    ["a 126-character run of wide 'W' words", TITLE_WIDE_WORDS],
    ["a 130-character all-caps headline", TITLE_ALL_CAPS],
  ] as const)("keeps the box and the bottom row where they are under %s", async (label, title) => {
    const ref = await isoCard(EN_TITLE);
    const card = await isoCard(title);
    for (const x of LEGEND_PROBE_X) {
      expectNear(pixelAt(card, x, LEGEND_PROBE_Y), pixelAt(ref, x, LEGEND_PROBE_Y), `${label} at (${x},${LEGEND_PROBE_Y})`);
    }
    for (const x of [250, 950]) {
      for (let y = 470; y < 630; y++) {
        expectNear(pixelAt(card, x, y), pixelAt(ref, x, y), `${label} at (${x},${y})`);
      }
    }
  }, 30_000);

  it("a flagged isolated card ('kümede sadece İktidar' ribbon) draws the same-size box, on the canvas and no lower than the ribbon card's tiles", async () => {
    // A 3-line headline under the ribbon already pushes the legend row below the 64 px bottom
    // padding on today's cards (the tiles end near y 613 on this very title); the box is the
    // tiles' height without the 18 px bar, so it must end no lower than they do.
    const card = await isoCard(TITLE_96_RIBBON, true);
    const tilesRibbon = await renderCard(TITLE_96_RIBBON, true);
    const box = boxRows(card, 80, 440, LEGEND_PROBE_Y);
    const tiles = boxRows(tilesRibbon, 80, 440, LEGEND_PROBE_Y);
    expect(box).not.toBeNull();
    expect(tiles).not.toBeNull();
    expect(box!.maxY - box!.minY).toBeGreaterThanOrEqual(110);
    expect(box!.maxY - box!.minY).toBeLessThanOrEqual(113);
    expect(box!.maxY).toBeLessThanOrEqual(tiles!.maxY);
    // The page gradient is still the bottom row of the canvas (the box does not reach it).
    expectNear(pixelAt(card, 250, LEGEND_PROBE_Y), [21, 21, 24], "ribbon card at (250,629)");
    // The line stays on one line inside the box's padding.
    const text = textBounds(card, box!);
    expect(text).not.toBeNull();
    expect(text!.maxY - text!.minY).toBeLessThanOrEqual(34);
    expect(text!.minX).toBeGreaterThanOrEqual(72 + 1 + 20 - 2);
    expect(text!.maxX).toBeLessThanOrEqual(1128 - 1 - 20 + 2);
    // The ribbon is one line inside the 72 px side padding.
    const ribbon = ribbonBox(card);
    expect(ribbon).not.toBeNull();
    expect(ribbon!.minX).toBeGreaterThanOrEqual(72);
    expect(ribbon!.maxX).toBeLessThan(1128);
    expect(ribbon!.maxY - ribbon!.minY).toBeLessThanOrEqual(60);
  }, 30_000);
});
