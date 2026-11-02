import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// h26-security-3 (review round 2): fetchHeroImage's early-stop probe.
//
// safeFetch calls `shouldStopReading(accumulated)` with the WHOLE decoded body
// after EVERY network chunk. The probe used to run extractOgImage over that whole
// body once '</head>' had arrived, so it cost O(body) per chunk: quadratic in the
// number of chunks. On a hostile 200 KB page (overlapping '<meta a<meta a...'
// groups that use up the scanner's 1M-unit budget) a trickling server cost the
// worker 920 ms of CPU at 1,460-byte chunks (one TCP segment) and 6.7 s at
// 200-byte chunks, from ONE article, against a 2 s isolate limit and
// BATCH_SIZE = 20 articles per message.
//
// The probe is now amortised: '</head>' is searched in the new tail only, and
// the og:image scan re-runs only when the body has doubled since the last scan.
//
// safeFetch is mocked with a stand-in that runs the SAME loop (decode chunk,
// append, ask the probe, stop on true), so the tests drive the real
// fetchHeroImage wiring without a network.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  chunks: [] as string[],
  readChunks: 0,
  probeCalls: 0,
  maxBytes: 0,
}));

vi.mock("../../../supabase/functions/_shared/safe-fetch.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../supabase/functions/_shared/safe-fetch.ts")>();
  return {
    ...actual,
    safeFetch: vi.fn(
      async (
        _url: string,
        opts: {
          maxBytes?: number;
          shouldStopReading?: (accumulated: string) => boolean;
        },
      ) => {
        let accumulated = "";
        state.readChunks = 0;
        state.probeCalls = 0;
        state.maxBytes = opts.maxBytes ?? 0;
        for (const chunk of state.chunks) {
          if (accumulated.length >= (opts.maxBytes ?? Infinity)) break;
          accumulated += chunk;
          state.readChunks++;
          if (opts.shouldStopReading) {
            state.probeCalls++;
            if (opts.shouldStopReading(accumulated)) break;
          }
        }
        return {
          status: 200,
          headers: new Headers(),
          body: accumulated,
          finalUrl: "https://aa.example.test/haber/1",
        };
      },
    ),
  };
});

import {
  createHeroStopProbe,
  fetchHeroImage,
} from "../../../supabase/functions/_shared/og-image.ts";

const GOOD = "https://cdn.test/photos/good.jpg";

function split(body: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < body.length; i += size) out.push(body.slice(i, i + size));
  return out;
}

/** Feed `chunks` to a probe the way safeFetch does; returns the 1-based call
 *  index that said stop (0 when it never did) and the accumulated length then. */
function drive(probe: (s: string) => boolean, chunks: readonly string[]) {
  let acc = "";
  for (let i = 0; i < chunks.length; i++) {
    acc += chunks[i];
    if (probe(acc)) return { stoppedAt: i + 1, length: acc.length };
  }
  return { stoppedAt: 0, length: acc.length };
}

/** The pre-fix probe, kept here as the behavioural reference. */
function legacyProbe(extract: (html: string) => string | null) {
  return (html: string) => html.includes("</head>") && extract(html) !== null;
}

const OG = `<meta property="og:image" content="${GOOD}">`;

describe("createHeroStopProbe: stop semantics", () => {
  it("does not stop before '</head>' has arrived, even with an og:image", () => {
    const probe = createHeroStopProbe();
    expect(probe(`<html><head>${OG}`)).toBe(false);
  });

  it("stops at the chunk that completes '</head>' when the head carries an og:image", () => {
    const body = `<html><head>${OG}<title>x</title></head><body>${"p".repeat(500)}</body></html>`;
    const r = drive(createHeroStopProbe(), split(body, 40));
    const headEnd = body.indexOf("</head>") + "</head>".length;
    expect(r.stoppedAt).toBeGreaterThan(0);
    expect(r.length).toBeGreaterThanOrEqual(headEnd);
    expect(r.length).toBeLessThan(headEnd + 40);
  });

  it("finds '</head>' split across two chunks", () => {
    const probe = createHeroStopProbe();
    expect(probe(`<html><head>${OG}</he`)).toBe(false);
    expect(probe(`<html><head>${OG}</head>`)).toBe(true);
  });

  it("does not stop on a head without an og:image", () => {
    const body = `<html><head><title>x</title></head><body>${"p".repeat(2000)}</body>`;
    expect(drive(createHeroStopProbe(), split(body, 100)).stoppedAt).toBe(0);
  });

  it("does not stop on an og:image meta whose content is blank", () => {
    const body = `<html><head><meta property="og:image" content="  "></head><body></body>`;
    expect(drive(createHeroStopProbe(), split(body, 30)).stoppedAt).toBe(0);
  });

  it("picks up an og:image placed in <body> after the first '</head>' (the aa.com.tr shape)", () => {
    const head = "<html><head><title>x</title></head><body>";
    const body = head + "<p>" + "metin ".repeat(1500) + "</p>" + OG + "<p>devam</p>".repeat(2000);
    const chunks = split(body, 1460);
    const legacy = drive(legacyProbe((h) => (h.includes(GOOD) ? GOOD : null)), chunks);
    const fresh = drive(createHeroStopProbe(), chunks);
    expect(legacy.stoppedAt).toBeGreaterThan(0);
    expect(fresh.stoppedAt).toBeGreaterThan(0);
    // never earlier than the legacy probe, at most about 2x its read length
    expect(fresh.length).toBeGreaterThanOrEqual(legacy.length);
    expect(fresh.length).toBeLessThanOrEqual(2 * legacy.length + 1460);
  });

  it("is sticky once it has said stop", () => {
    const probe = createHeroStopProbe();
    const body = `<html><head>${OG}</head>`;
    expect(probe(body)).toBe(true);
    expect(probe(body + "x")).toBe(true);
  });

  it("starts over when handed a shorter string (a new fetch, not a growing prefix)", () => {
    const probe = createHeroStopProbe();
    expect(probe(`<html><head>${OG}</head>`)).toBe(true);
    const fresh = createHeroStopProbe();
    expect(fresh("<html><head>")).toBe(false);
    expect(fresh("<ht")).toBe(false);
    expect(fresh(`<html><head>${OG}</head>`)).toBe(true);
  });
});

describe("createHeroStopProbe: total cost across chunks [hunt-26 security-3]", () => {
  const BUDGET_MS = 100;

  // '<meta a=<meta a=...' groups, a '>' every ~1.9 KB: each start is parsed and
  // the 1M-unit scan budget is used up by a full scan of 200 KB.
  const GROUP = "<meta a=".repeat(237) + ">";
  function hostilePage(bytes: number): string {
    const head = "<html><head></head><body>";
    return head + GROUP.repeat(Math.ceil((bytes - head.length) / GROUP.length)).slice(0, bytes - head.length);
  }

  for (const size of [1460, 700, 200]) {
    it(`a 200 KB hostile page in ${size}-byte chunks costs < ${BUDGET_MS} ms of probing`, () => {
      const page = hostilePage(200_000);
      const chunks = split(page, size);
      createHeroStopProbe()("warm"); // JIT
      const probe = createHeroStopProbe();
      const t0 = performance.now();
      const r = drive(probe, chunks);
      const ms = performance.now() - t0;
      expect(r.stoppedAt).toBe(0);
      expect(r.length).toBe(200_000);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }

  it("the scan count is logarithmic in the number of chunks, not linear", () => {
    // Count extractOgImage runs through the probe's cost: with N chunks a linear
    // probe would take ~N scans. Time a 4x larger chunk count and require less
    // than 4x the cost (it is ~constant: the scans are doubling-spaced).
    const page = hostilePage(200_000);
    const timeIt = (size: number) => {
      const probe = createHeroStopProbe();
      const t0 = performance.now();
      drive(probe, split(page, size));
      return performance.now() - t0;
    };
    timeIt(1460); // warm
    const few = timeIt(1460);
    const many = timeIt(365);
    expect(many).toBeLessThan(Math.max(few * 3, 40));
  });
});

describe("fetchHeroImage: the real wiring, driven through a stand-in safeFetch", () => {
  beforeEach(() => {
    state.chunks = [];
  });

  it("returns the og:image and stops reading as soon as the head is closed", async () => {
    const body = `<html><head>${OG}</head><body>${"p".repeat(150_000)}</body></html>`;
    state.chunks = split(body, 1460);
    const hero = await fetchHeroImage("https://aa.example.test/haber/1", "anadolu-ajansi");
    expect(hero).toBe(GOOD);
    expect(state.readChunks).toBeLessThan(5);
  });

  it("a hostile 200 KB body in 200-byte chunks costs < 100 ms end to end", async () => {
    const group = "<meta a=".repeat(237) + ">";
    const page = ("<html><head></head><body>" + group.repeat(120)).slice(0, 200_000);
    state.chunks = split(page, 200);
    await fetchHeroImage("https://hostile.example.test/a", "trt-haber"); // warm
    const t0 = performance.now();
    const hero = await fetchHeroImage("https://hostile.example.test/a", "trt-haber");
    const ms = performance.now() - t0;
    expect(hero).toBeNull();
    expect(state.probeCalls).toBeGreaterThan(900);
    expect(ms).toBeLessThan(100);
  });

  it("reads the full 200 KB window and still finds a late og:image after the probe gave up", async () => {
    const filler = "<p>x</p>".repeat(12_000); // ~96 KB, no meta tags
    const page = `<html><head></head><body>${filler}${OG}</body></html>`;
    state.chunks = split(page, 1460);
    const hero = await fetchHeroImage("https://hostile.example.test/b", "haberler-com");
    expect(hero).toBe(GOOD);
  });
});
