import { deflateSync, inflateSync } from "node:zlib";

import { describe, it, expect, vi } from "vitest";

import type { ClusterDetail } from "@/lib/clusters/cluster-detail-query";

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

  it("sets the exact edge cache-control header on the real Response", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(blindspotDetail());
    const { default: Image } = await import("./opengraph-image");

    const res = await Image({ params: Promise.resolve({ id: VALID_ID }) });

    expect(res.headers.get("cache-control")).toBe(
      "public, s-maxage=600, stale-while-revalidate=86400",
    );
  });

  it("sets the shorter fallback cache-control header on the not-found card", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(null);
    const { default: Image } = await import("./opengraph-image");

    const res = await Image({ params: Promise.resolve({ id: MISSING_ID }) });

    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60");
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
