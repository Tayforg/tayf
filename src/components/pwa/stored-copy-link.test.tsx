import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CACHE_NAMES } from "@/lib/pwa/sw-contract";
import { formatTurkishTimeAgo } from "@/lib/time";

import { StoredCopyLink } from "./stored-copy-link";

// h69-pwa-1: during a database brownout the cluster route answers 200 and then renders ./error.tsx, so the service
// worker never sees a failure and the reader got "Hikâye yüklenemedi" even when this device held the story. The
// boundary now asks Cache Storage after mount and offers the copy.
//
// The repo has no DOM environment, so `react` is replaced here (own file, like daily-game-hydration.test.tsx) with
// a one-slot useState and an effect list. mount() renders once (the server pass and the first client render),
// runs the recorded effects the way React does after commit, waits for the async lookup, then renders again with
// the state the effect stored. The lookup itself is the real findStoredCopy against a stubbed globalThis.caches.

const slot = vi.hoisted(() => ({
  state: undefined as unknown,
  assigned: false,
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [
      slot.assigned ? slot.state : initial,
      (next: unknown) => {
        slot.state = next;
        slot.assigned = true;
      },
    ],
    useEffect: (effect: () => void | (() => void)) => {
      slot.effects.push(effect);
    },
  };
});

const ORIGIN = "https://tayf.test";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type Entries = Record<string, string | null>;

function stubCaches(stores: { saved?: Entries; pages?: Entries }) {
  const byName = new Map<string, Entries>();
  if (stores.saved) byName.set("tayf-saved-v1", stores.saved);
  if (stores.pages) {
    // The pages cache name carries SW_VERSION; any tayf-pages-* the component asks for is the one we hold.
    byName.set("*pages", stores.pages);
  }
  const resolve = (name: string) => byName.get(name) ?? (name.startsWith("tayf-pages-") ? byName.get("*pages") : undefined);
  vi.stubGlobal("caches", {
    has: async (name: string) => resolve(name) !== undefined,
    open: async (name: string) => {
      const entries = resolve(name) ?? {};
      return {
        keys: async () => [],
        match: async (request: Request | string) => {
          const url = typeof request === "string" ? request : request.url;
          if (!(url in entries)) return undefined;
          const at = entries[url];
          return { headers: new Headers(at === null || at === undefined ? {} : { "x-tayf-cached-at": at }) };
        },
      };
    },
  });
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount(clusterId = ID) {
  slot.state = undefined;
  slot.assigned = false;
  slot.effects = [];
  const first = renderToStaticMarkup(<StoredCopyLink clusterId={clusterId} />);
  const pending = [...slot.effects];
  slot.effects = [];
  const cleanups = pending.map((effect) => effect());
  await settle();
  await settle();
  const second = renderToStaticMarkup(<StoredCopyLink clusterId={clusterId} />);
  return { first, second, cleanups, effectCount: pending.length };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("location", { origin: ORIGIN });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("StoredCopyLink", () => {
  it("renders nothing on the server pass and on the first client render, even when a copy exists", async () => {
    stubCaches({ saved: { [`${ORIGIN}/cluster/${ID}`]: iso(3 * HOUR) } });
    const { first, effectCount } = await mount();
    expect(first).toBe("");
    expect(effectCount).toBe(1); // the lookup runs in an effect, i.e. only after mount
  });

  it("after mount, offers a saved copy with its age and a plain link that carries ?kopya=1", async () => {
    const at = iso(3 * HOUR);
    stubCaches({ saved: { [`${ORIGIN}/cluster/${ID}`]: at } });
    const { second } = await mount();
    expect(second).toContain(
      `Bu hikâyenin bu cihazda kayıtlı bir kopyası var (${formatTurkishTimeAgo(at, { now: NOW })} kaydedildi).`,
    );
    expect(second).toContain("(3 saat önce kaydedildi).");
    expect(second).toMatch(new RegExp(`<a href="/cluster/${ID}\\?kopya=1"[^>]*>Kayıtlı kopyayı aç</a>`));
    expect(second.match(/<a\b/g)).toHaveLength(1);
  });

  it("offers a pages (visited) copy as well", async () => {
    stubCaches({ pages: { [`${ORIGIN}/cluster/${ID}`]: iso(2 * DAY) } });
    const { second } = await mount();
    expect(second).toContain("Kayıtlı kopyayı aç");
    expect(second).toContain("(2 gün önce kaydedildi).");
  });

  it("keeps the saved age relative, never a bare date before 'kaydedildi'", async () => {
    stubCaches({ saved: { [`${ORIGIN}/cluster/${ID}`]: iso(100 * DAY) } });
    const { second } = await mount();
    expect(second).toMatch(/\(\d+ (ay|hafta|yıl) önce kaydedildi\)\./);
    expect(second).not.toMatch(/Ağustos|Temmuz|Haziran|Eylül|2026/);
  });

  it("omits the parenthesis when the copy has no usable stamp", async () => {
    stubCaches({ saved: { [`${ORIGIN}/cluster/${ID}`]: null } });
    const { second } = await mount();
    expect(second).toContain("Bu hikâyenin bu cihazda kayıtlı bir kopyası var.");
    expect(second).not.toContain("(");
    expect(second).not.toContain("kaydedildi");
    expect(second).toContain(`href="/cluster/${ID}?kopya=1"`);
  });

  it("renders nothing when there is no copy of this story", async () => {
    stubCaches({ saved: { [`${ORIGIN}/cluster/11111111-2222-3333-4444-555555555555`]: iso(0) } });
    const { second } = await mount();
    expect(second).toBe("");
  });

  it("renders nothing for a pages copy older than 14 days (the worker would not serve it)", async () => {
    stubCaches({ pages: { [`${ORIGIN}/cluster/${ID}`]: iso(15 * DAY) } });
    const { second } = await mount();
    expect(second).toBe("");
  });

  it("renders nothing when this browser has no Cache Storage", async () => {
    vi.stubGlobal("caches", undefined);
    const { first, second } = await mount();
    expect(first).toBe("");
    expect(second).toBe("");
  });

  it("renders nothing, and does not throw, when the cache API fails", async () => {
    vi.stubGlobal("caches", {
      has: async () => {
        throw new Error("SecurityError");
      },
      open: async () => {
        throw new Error("SecurityError");
      },
    });
    const { second } = await mount();
    expect(second).toBe("");
  });

  it("renders nothing for an id that is not a story id", async () => {
    stubCaches({ saved: { [`${ORIGIN}/cluster/${ID}`]: iso(0) } });
    const { second } = await mount("not-a-uuid");
    expect(second).toBe("");
  });

  it("lower-cases the id in the link", async () => {
    stubCaches({ saved: { [`${ORIGIN}/cluster/${ID}`]: iso(HOUR) } });
    const { second } = await mount(ID.toUpperCase());
    expect(second).toContain(`href="/cluster/${ID}?kopya=1"`);
  });

  it("ignores a lookup that finishes after unmount", async () => {
    stubCaches({ saved: { [`${ORIGIN}/cluster/${ID}`]: iso(HOUR) } });
    slot.state = undefined;
    slot.assigned = false;
    slot.effects = [];
    renderToStaticMarkup(<StoredCopyLink clusterId={ID} />);
    const cleanups = slot.effects.map((effect) => effect());
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    await settle();
    await settle();
    expect(slot.assigned).toBe(false);
  });
});

// sw-kopya-reload-trap / security-1: the worker answers ?kopya=1 from storage only once per click, when the click
// left a mark in Cache Storage. This is the click: preventDefault, write the mark, THEN navigate. A modified click
// (new tab, new window, download) or a non-primary button keeps the browser's own behaviour and goes network-first.
describe("StoredCopyLink click", () => {
  type AnchorProps = { href: string; onClick?: (event: unknown) => unknown };

  function findAnchor(node: unknown): ReactElement<AnchorProps> | null {
    if (!isValidElement(node)) return null;
    const element = node as ReactElement<AnchorProps & { children?: unknown }>;
    if (element.type === "a") return element;
    if (typeof element.type === "function") {
      return findAnchor((element.type as (props: unknown) => unknown)(element.props));
    }
    const children = element.props.children;
    for (const child of Array.isArray(children) ? children : [children]) {
      const hit = findAnchor(child);
      if (hit !== null) return hit;
    }
    return null;
  }

  async function mountAnchor() {
    await mount(); // runs the lookup effect and leaves the offer in the one-slot state
    slot.effects = [];
    const anchor = findAnchor(StoredCopyLink({ clusterId: ID }));
    slot.effects = [];
    if (anchor === null) throw new Error("no anchor rendered");
    return anchor;
  }

  const click = (over: Record<string, unknown> = {}) => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...over,
  });

  let order: string[];
  let puts: Array<{ cache: string; key: string; stamp: string | null }>;
  let assign: ReturnType<typeof vi.fn>;
  let gate: Promise<void> | null;

  beforeEach(() => {
    order = [];
    puts = [];
    gate = null;
    assign = vi.fn((href: string) => {
      order.push(`assign:${href}`);
    });
    vi.stubGlobal("location", { origin: ORIGIN, assign });
    vi.stubGlobal("caches", {
      has: async (name: string) => name === "tayf-saved-v1",
      open: async (name: string) => ({
        keys: async () => [],
        match: async () => ({ headers: new Headers({ "x-tayf-cached-at": iso(HOUR) }) }),
        put: async (request: Request | string, response: Response) => {
          if (gate) await gate;
          order.push("put");
          puts.push({
            cache: name,
            key: typeof request === "string" ? request : request.url,
            stamp: response.headers.get("x-tayf-cached-at"),
          });
        },
      }),
    });
  });

  it("a plain primary click prevents the default, writes the mark, and only then navigates", async () => {
    const anchor = await mountAnchor();
    expect(anchor.props.href).toBe(`/cluster/${ID}?kopya=1`); // modifier clicks still use the real href
    const event = click();
    anchor.props.onClick?.(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1); // synchronously, before any await
    expect(assign).not.toHaveBeenCalled();
    await settle();
    await settle();
    expect(order).toEqual(["put", `assign:/cluster/${ID}?kopya=1`]);
    expect(puts).toEqual([{ cache: CACHE_NAMES.openCopy, key: `${ORIGIN}/cluster/${ID}`, stamp: new Date(NOW).toISOString() }]);
  });

  it("does not navigate while the mark is still being written", async () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const anchor = await mountAnchor();
    anchor.props.onClick?.(click());
    await settle();
    await settle();
    expect(assign).not.toHaveBeenCalled();
    release();
    await settle();
    await settle();
    expect(order).toEqual(["put", `assign:/cluster/${ID}?kopya=1`]);
  });

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["a middle click", { button: 1 }],
    ["a secondary click", { button: 2 }],
  ])("leaves a %s click to the browser: no preventDefault, no mark, no assign", async (_name, over) => {
    const anchor = await mountAnchor();
    const event = click(over);
    anchor.props.onClick?.(event);
    await settle();
    await settle();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
    expect(assign).not.toHaveBeenCalled();
  });

  it("still navigates when the mark cannot be written (the worker then answers network-first)", async () => {
    const anchor = await mountAnchor();
    vi.stubGlobal("caches", {
      has: async () => {
        throw new Error("SecurityError");
      },
      open: async () => {
        throw new Error("SecurityError");
      },
    });
    anchor.props.onClick?.(click());
    await settle();
    await settle();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/cluster/${ID}?kopya=1`);
  });

  it("still navigates when this browser has no Cache Storage", async () => {
    const anchor = await mountAnchor();
    vi.stubGlobal("caches", undefined);
    anchor.props.onClick?.(click());
    await settle();
    await settle();
    expect(assign).toHaveBeenCalledWith(`/cluster/${ID}?kopya=1`);
    expect(puts).toEqual([]);
  });

  it("stamps the mark with the click-time clock, not the render-time one", async () => {
    const anchor = await mountAnchor();
    vi.setSystemTime(NOW + 20_000);
    anchor.props.onClick?.(click());
    await settle();
    await settle();
    expect(puts.map((p) => p.stamp)).toEqual([new Date(NOW + 20_000).toISOString()]);
  });
});

// The effect and the plain-anchor choice need a browser; pin them by source text, comments blanked
// (house pattern, see stale-copy-notice.test.tsx).
describe("stored-copy-link.tsx and error.tsx wiring", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const strip = (raw: string) =>
    raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
  const linkRaw = readFileSync(join(here, "stored-copy-link.tsx"), "utf8");
  const link = strip(linkRaw);
  const errorRaw = readFileSync(join(here, "../../app/cluster/[id]/error.tsx"), "utf8");
  const error = strip(errorRaw);

  it("is a client module", () => {
    expect(linkRaw.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("is a full navigation (plain anchor, never next/link) so the worker sees the request", () => {
    expect(link).not.toMatch(/next\/link/);
    expect(link).toMatch(/<a\b/);
  });

  it("looks the copy up after mount, in an effect, never in the render body", () => {
    expect(link).toMatch(/useEffect\(/);
    expect(link).toMatch(/findStoredCopy\(/);
    expect(link.split("findStoredCopy(").length - 1).toBe(1);
    // The clock is read twice: once in the lookup effect and once in the click handler that stamps the mark.
    expect(link.split("Date.now()").length - 1).toBe(2);
  });

  it("marks the click through markStoredCopyOpen and navigates with location.assign", () => {
    expect(link).toMatch(/markStoredCopyOpen\(/);
    expect(link.split("markStoredCopyOpen(").length - 1).toBe(1);
    expect(link).toMatch(/location\.assign\(/);
    expect(link).toMatch(/onClick=/);
    // preventDefault comes first and synchronously: nothing may be awaited before it.
    expect(link.indexOf("preventDefault()")).toBeGreaterThan(-1);
    expect(link.indexOf("preventDefault()")).toBeLessThan(link.indexOf("await "));
  });

  it("the cluster error boundary renders it for the id of the route", () => {
    expect(error).toMatch(/import \{ useParams \} from "next\/navigation";/);
    expect(error).toMatch(/import \{ StoredCopyLink \} from "@\/components\/pwa\/stored-copy-link";/);
    expect(error).toMatch(/useParams(?:<[^>]*>)?\(\)/);
    expect(error).toMatch(/<StoredCopyLink\s+clusterId=\{/);
  });
});
