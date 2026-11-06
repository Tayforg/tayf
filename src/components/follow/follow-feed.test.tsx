import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  EmptyState,
  FeedFrame,
  FollowFeed,
  FollowSection,
  retryResultAnnouncement,
  SectionBody,
} from "./follow-feed";
import {
  followRowMeta,
  type Follow,
  type FollowItem,
} from "@/lib/follows/follows";

// The vitest environment is "node" (no DOM, no effects), so /takip's client
// half is covered three ways: renderToStaticMarkup for what each piece emits,
// a direct walk of the (hook-free) section tree for handlers and refs, and a
// source guard for the one invariant markup cannot show (a single live region).
// The fetch / focus-handoff effects of <FollowFeed/> itself need a browser.

const NOW = "2026-10-22T09:00:00.000Z";

function follow(kind: Follow["kind"], value: string): Follow {
  return { kind, value, addedAt: NOW, seenAt: NOW };
}
const SECIM = follow("q", "seçim");
const EKONOMI = follow("konu", "ekonomi");
const DEVA = follow("gundem", "deva");

function item(over: Partial<FollowItem> = {}): FollowItem {
  return {
    id: "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb",
    title: "Bir haber başlığı",
    firstPublished: "2026-10-22T07:00:00+00:00",
    updatedAt: "2026-10-22T08:50:00+00:00",
    sourceCount: 3,
    isBlindspot: false,
    zoneLine: "İktidar 1 · Bağımsız 1 · Muhalefet 1",
    ...over,
  };
}

const SEEN_AT = "2026-10-22T09:00:00.000Z";

/**
 * One item per flag, newest first, ids unique per position: true = first
 * published after SEEN_AT (a "yeni" story), false = before it.
 */
function newsItems(flags: boolean[]): FollowItem[] {
  return flags.map((isNew, i) =>
    item({
      id: `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, "0")}`,
      title: `Haber ${i}`,
      firstPublished: isNew ? `2026-10-22T10:${String(59 - i).padStart(2, "0")}:00+00:00` : "2026-10-22T08:00:00+00:00",
    }),
  );
}

type El = { type?: unknown; props?: Record<string, unknown> };

function collect(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as El;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) collect(el.props.children, out);
  }
  return out;
}

function textOf(node: unknown): string {
  const parts: string[] = [];
  const visit = (n: unknown) => {
    if (typeof n === "string" || typeof n === "number") parts.push(String(n));
    else if (Array.isArray(n)) n.forEach(visit);
    else if (n && typeof n === "object") visit((n as El).props?.children);
  };
  visit(node);
  return parts.join("");
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

function section(
  f: Follow,
  state: Parameters<typeof FollowSection>[0]["state"],
  extra: Partial<Parameters<typeof FollowSection>[0]> = {},
): ReactNode {
  return <FollowSection follow={f} state={state} seenAt={null} onRemove={() => {}} {...extra} />;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FeedFrame / live region", () => {
  it("FollowFeed pre-hydration renders the polite status region with the busy placeholder", () => {
    expect(typeof window).toBe("undefined");
    const markup = renderToStaticMarkup(<FollowFeed />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-busy="true"');
    // The server snapshot has no follows; it must not flash the empty state.
    expect(markup).not.toContain("Henüz bir şey takip etmiyorsunuz");
  });

  it("wraps the empty state in the same frame, carrying the announcement", () => {
    const markup = renderToStaticMarkup(
      <FeedFrame announcement="x">
        <EmptyState />
      </FeedFrame>,
    );
    expect(markup).toMatch(/<p role="status" aria-live="polite" class="sr-only">x<\/p>/);
    expect(markup).toContain("Henüz bir şey takip etmiyorsunuz");
  });

  it("renders the region before its children, empty when there is nothing to say", () => {
    const markup = renderToStaticMarkup(
      <FeedFrame announcement="">
        <i>child</i>
      </FeedFrame>,
    );
    expect(markup).toBe(
      '<div class="space-y-4"><p role="status" aria-live="polite" class="sr-only"></p><i>child</i></div>',
    );
  });

  it("is the only live region in the module (it must never remount or duplicate)", () => {
    const src = readFileSync(resolve(__dirname, "follow-feed.tsx"), "utf8");
    expect(count(src, 'role="status"')).toBe(1);
  });

  it("FollowFeed always returns the frame, so the region survives every state", () => {
    const src = readFileSync(resolve(__dirname, "follow-feed.tsx"), "utf8");
    // Every branch of FollowFeed (placeholder, empty, list) goes through FeedFrame.
    const feed = src.slice(src.indexOf("export function FollowFeed"), src.indexOf("export function EmptyState"));
    expect(count(feed, "<FeedFrame")).toBe(1);
    expect(feed).not.toMatch(/return\s*<EmptyState/);
  });
});

describe("retryResultAnnouncement", () => {
  type State = Parameters<typeof retryResultAnnouncement>[1];
  const SEEN = "2026-10-22T09:00:00.000Z";

  it("reads the loaded count, capped at the five rows shown when nothing is new", () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      item({ id: `aaaaaaaa-1111-4111-8111-00000000000${i}` }),
    );
    const state: State = { status: "ok", items };
    expect(retryResultAnnouncement("“seçim”", state, null)).toBe("“seçim” yüklendi · 5 hikâye");
  });

  it("reads the exact count below the cap", () => {
    const state: State = { status: "ok", items: [item()] };
    expect(retryResultAnnouncement("Ekonomi", state, null)).toBe("Ekonomi yüklendi · 1 hikâye");
  });

  // h55-personal-1: the rows grow to cover every new story, so the count the
  // region reads is the rows on screen, not a flat five.
  it("counts the extended rows: 8 items, all new after seenAt -> 8 hikâye", () => {
    const state: State = { status: "ok", items: newsItems(Array(8).fill(true)) };
    expect(retryResultAnnouncement("Ekonomi", state, SEEN)).toBe("Ekonomi yüklendi · 8 hikâye");
  });

  it("with no baseline (seenAt null) 8 items still read as the five default rows", () => {
    const state: State = { status: "ok", items: newsItems(Array(8).fill(true)) };
    expect(retryResultAnnouncement("Ekonomi", state, null)).toBe("Ekonomi yüklendi · 5 hikâye");
  });

  it("says there is no match (not 'no news') when the list came back empty", () => {
    const state: State = { status: "ok", items: [] };
    const text = retryResultAnnouncement("Ekonomi", state, SEEN);
    expect(text).toBe("Ekonomi yüklendi · eşleşen hikâye yok");
    expect(text).not.toContain("yeni haber yok");
  });

  it("explains a rate-limited retry", () => {
    const state: State = { status: "error", reason: "rate" };
    expect(retryResultAnnouncement("“seçim”", state, null)).toBe(
      "“seçim”: çok sık yenilendi, biraz sonra tekrar deneyin",
    );
  });

  it("reports a retry that failed again", () => {
    const state: State = { status: "error", reason: "down" };
    expect(retryResultAnnouncement("“seçim”", state, null)).toBe("“seçim” şu an yüklenemedi");
  });

  it("every outcome names the follow it is about", () => {
    const states: State[] = [
      { status: "ok", items: [item()] },
      { status: "ok", items: [] },
      { status: "error", reason: "rate" },
      { status: "error", reason: "down" },
    ];
    for (const state of states) {
      expect(retryResultAnnouncement("Ekonomi", state, SEEN)).toContain("Ekonomi");
    }
  });
});

describe("retry result announcement wiring (source guard: effects need a browser)", () => {
  const src = readFileSync(resolve(__dirname, "follow-feed.tsx"), "utf8");
  const retryStart = src.indexOf("function handleRetry");
  const handleRetry = src.slice(retryStart, src.indexOf("\n  }\n", retryStart));
  const effectStart = src.indexOf("useEffect(() => {");
  const effectEnd = src.indexOf("}, [keysSignature, retryNonce]);");
  const fetchEffect = src.slice(effectStart, effectEnd);

  it("slices the code it is guarding (the guards below are not vacuous)", () => {
    expect(retryStart).toBeGreaterThan(-1);
    expect(handleRetry).toContain("setRetryNonce");
    expect(effectStart).toBeGreaterThan(-1);
    expect(effectEnd).toBeGreaterThan(effectStart);
    expect(fetchEffect).toContain("fetchFollowState");
  });

  it("keeps the follows awaiting an announcement in a ref map of key -> label", () => {
    expect(src).toContain("retryPending = useRef<Map<string, string>>(new Map())");
  });

  it("handleRetry registers the follow BEFORE it bumps the nonce that triggers the fetch", () => {
    const set = handleRetry.indexOf("retryPending.current.set(key");
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(handleRetry.indexOf("setRetryNonce"));
  });

  it("the fetch effect announces only after the not-aborted check", () => {
    const aborted = fetchEffect.indexOf("if (controller.signal.aborted) return;");
    const get = fetchEffect.indexOf("retryPending.current.get(item.key)");
    expect(aborted).toBeGreaterThan(-1);
    expect(get).toBeGreaterThan(aborted);
    expect(fetchEffect).toContain("setAnnouncement(retryResultAnnouncement(");
    expect(fetchEffect.indexOf("setAnnouncement(retryResultAnnouncement(")).toBeGreaterThan(get);
  });

  it("consumes the entry once it has announced, and prunes entries of unfollowed keys", () => {
    expect(fetchEffect).toContain("retryPending.current.delete(");
    // Both the per-item consume and the live-set prune delete from the map.
    expect(count(fetchEffect, "retryPending.current.delete(")).toBe(2);
  });

  it("still has exactly one live region (announcing reuses it)", () => {
    expect(count(src, 'role="status"')).toBe(1);
    expect(count(src, 'aria-live="polite"')).toBe(1);
  });

  // h55-personal-1: the announcement counts rows with the reader's baseline. The
  // effect cannot depend on seenSnapshot (that would refetch on every snapshot
  // change), so it reads the per-key snapshot from a ref mirrored by an effect.
  it("reads the per-key seenAt from a ref, passing it to retryResultAnnouncement", () => {
    expect(src).toContain("seenSnapshotRef = useRef<Record<string, string | null>>({})");
    expect(fetchEffect).toContain("seenSnapshotRef.current[item.key] ?? null");
    expect(fetchEffect).toContain("retryResultAnnouncement(label, outcome, seenAt)");
  });

  it("mirrors seenSnapshot into that ref outside the fetch effect, and keeps the effect's deps", () => {
    expect(count(src, "seenSnapshotRef.current = seenSnapshot")).toBe(1);
    expect(fetchEffect).not.toContain("seenSnapshotRef.current = seenSnapshot");
    expect(src).toContain("}, [keysSignature, retryNonce]);");
    expect(src).not.toMatch(/\}, \[[^\]]*seenSnapshot[^\]]*\]\);/);
  });
});

describe("EmptyState", () => {
  it("tells the reader the button also lives on gündem pages", () => {
    const text = textOf(EmptyState({}));
    expect(text).toContain(
      "Bir konu ya da gündem sayfasında veya aramada “Takip et”e dokunun.",
    );
  });

  it("has a focusable heading so focus can land there after the last unfollow", () => {
    const markup = renderToStaticMarkup(<EmptyState />);
    expect(markup).toMatch(/<h2 [^>]*tabindex="-1"[^>]*>Henüz bir şey takip etmiyorsunuz<\/h2>/);
  });

  it("hands its heading ref through", () => {
    const headingRef = vi.fn();
    const h2 = collect(EmptyState({ headingRef })).find((el) => el.type === "h2");
    expect(h2?.props?.ref).toBe(headingRef);
    expect(h2?.props?.tabIndex).toBe(-1);
  });

  // h49-browser-2: the two links are the only actions for a new visitor, and
  // were 101x18 / 104x18 bare text links. On phones (max-sm) they get the site's
  // 44 px floor; sm and up is unchanged (max-sm:min-h-11 never applies there).
  describe("empty-state links (h49-browser-2)", () => {
    const TOUCH_TOKENS = ["inline-flex", "items-center", "max-sm:min-h-11", "touch-manipulation"];
    const tokensOf = (el: El) =>
      String(el.props?.className ?? "")
        .split(/\s+/)
        .filter(Boolean);

    /** The <p> that holds the two links, plus its direct Link children. */
    function linkRow() {
      const els = collect(EmptyState({}));
      const row = els.find(
        (el) =>
          el.type === "p" &&
          collect(el.props?.children).filter((c) => typeof c.props?.href === "string").length === 2,
      );
      const links = collect(row?.props?.children).filter((c) => typeof c.props?.href === "string");
      return { row, links };
    }

    it("both links keep their target and label", () => {
      const { links } = linkRow();

      expect(links.map((l) => [l.props?.href, textOf(l)])).toEqual([
        ["/konu", "Konulara göz at"],
        ["/", "Ana sayfada ara"],
      ]);
    });

    it("both links carry the phone 44 px tokens", () => {
      const { links } = linkRow();

      expect(links).toHaveLength(2);
      for (const l of links) expect(tokensOf(l)).toEqual(expect.arrayContaining(TOUCH_TOKENS));
    });

    it("keeps the dotted-underline style and never forces a min-height on desktop", () => {
      const { links } = linkRow();

      for (const l of links) {
        const tokens = tokensOf(l);
        expect(tokens).toEqual(
          expect.arrayContaining(["underline", "decoration-dotted", "underline-offset-2", "hover:text-primary"]),
        );
        expect(tokens.filter((t) => /^min-h-/.test(t))).toEqual([]);
      }
    });

    it("still renders both links inside the same <p>, separated by ' · '", () => {
      const { row } = linkRow();

      expect(row).toBeDefined();
      expect(textOf(row)).toBe("Konulara göz at · Ana sayfada ara");
      const markup = renderToStaticMarkup(<EmptyState />);
      expect(markup).toMatch(
        /<p class="text-sm"><a [^>]*href="\/konu"[^>]*>Konulara göz at<\/a> · <a [^>]*href="\/"[^>]*>Ana sayfada ara<\/a><\/p>/,
      );
    });

    it("the rendered anchors carry the tokens too", () => {
      const markup = renderToStaticMarkup(<EmptyState />);
      const anchors = [...markup.matchAll(/<a [^>]*>/g)].map((m) => m[0]);

      expect(anchors).toHaveLength(2);
      for (const a of anchors) {
        for (const t of TOUCH_TOKENS) expect(a).toContain(t);
      }
    });
  });
});

describe("FollowSection -- gündem (entity hub) follow", () => {
  it("shows the entity's label as the heading, not the key", () => {
    const markup = renderToStaticMarkup(section(DEVA, undefined));
    expect(markup).toMatch(/<h2 [^>]*tabindex="-1"[^>]*>DEVA<\/h2>/);
    expect(markup).not.toContain("“deva”");
  });

  it("links 'Tümü' to the /gundem/<key> hub, named after the entity", () => {
    const markup = renderToStaticMarkup(section(DEVA, undefined));
    const link = /<a [^>]*>Tümü<\/a>/.exec(markup)?.[0] ?? "";
    expect(link).toContain('href="/gundem/deva"');
    expect(link).toContain('aria-label="Tümü: DEVA"');
    expect(markup).toContain(">Tümü</a>");
    expect(markup).not.toContain("/?q=");
  });

  it("names the remove button after the entity", () => {
    const markup = renderToStaticMarkup(section(DEVA, undefined));
    expect(markup).toContain('aria-label="DEVA takibini bırak"');
  });

  it("uses the recent-window empty copy and no corroboration caption (a hub is newest first)", () => {
    const empty = renderToStaticMarkup(section(DEVA, { status: "ok", items: [] }));
    expect(empty).toContain("Son dönemde eşleşen hikâye yok.");
    expect(empty).not.toContain("Eşleşen hikâye bulunamadı.");
    const list = renderToStaticMarkup(section(DEVA, { status: "ok", items: [item()] }));
    expect(list).not.toContain("En çok kaynaklı eşleşmeler");
    expect(list).toContain("Bir haber başlığı");
  });

  it("does not reserve the keyword caption line in the loading skeleton", () => {
    const skeleton = renderToStaticMarkup(section(DEVA, undefined));
    expect(skeleton).not.toContain('class="h-4 px-2"');
    const keyword = renderToStaticMarkup(section(SECIM, undefined));
    expect(keyword).toContain('class="h-4 px-2"');
  });

  it("gives a keyword, a topic and a hub follow distinct accessible names", () => {
    const markup = renderToStaticMarkup(
      <>
        {section(SECIM, undefined)}
        {section(EKONOMI, undefined)}
        {section(DEVA, undefined)}
      </>,
    );
    const labels = [...markup.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toHaveLength(6);
    expect(new Set(labels).size).toBe(6);
  });
});

describe("FollowSection", () => {
  it("names the remove button after the follow it removes (keyword and topic)", () => {
    const q = renderToStaticMarkup(section(SECIM, undefined));
    expect(q).toContain('aria-label="“seçim” takibini bırak"');
    const t = renderToStaticMarkup(section(EKONOMI, undefined));
    expect(t).toContain('aria-label="Ekonomi takibini bırak"');
    expect(q).not.toContain('aria-label="Takibi bırak"');
  });

  it("names the 'Tümü' link after its follow, keeping the visible word first", () => {
    const q = renderToStaticMarkup(section(SECIM, undefined));
    expect(q).toContain('aria-label="Tümü: “seçim”"');
    expect(q).toContain(">Tümü</a>");
    const t = renderToStaticMarkup(section(EKONOMI, undefined));
    expect(t).toContain('aria-label="Tümü: Ekonomi"');
  });

  it("gives every control on two sections a distinct accessible name", () => {
    const markup = renderToStaticMarkup(
      <>
        {section(SECIM, undefined)}
        {section(EKONOMI, undefined)}
      </>,
    );
    const labels = [...markup.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toHaveLength(4);
    expect(new Set(labels).size).toBe(4);
  });

  it("makes the remove button and the 'Tümü' link at least 44px", () => {
    const markup = renderToStaticMarkup(section(SECIM, undefined));
    expect(markup).toContain("h-11 w-11");
    expect(markup).toContain("min-h-[44px]");
    expect(markup).toContain("touch-manipulation");
    // The icon itself stays small; only the hit area grew.
    expect(markup).toMatch(/<svg [^>]*class="[^"]*h-4 w-4/);
  });

  it("makes the 'Tümü' link 44px in BOTH dimensions (WCAG 2.5.8), not just tall", () => {
    const markup = renderToStaticMarkup(section(SECIM, undefined));
    const cls = /<a [^>]*aria-label="Tümü: “seçim”"[^>]*class="([^"]*)"/.exec(markup)?.[1];
    expect(cls).toBeDefined();
    expect(cls).toContain("min-h-[44px]");
    expect(cls).toContain("min-w-[44px]");
    // A 44px-wide box with a short word in it: the word is centred, not left-stuck.
    expect(cls).toContain("justify-center");
  });

  it("renders a focusable heading with the follow's label", () => {
    const markup = renderToStaticMarkup(section(SECIM, undefined));
    expect(markup).toMatch(/<h2 [^>]*tabindex="-1"[^>]*>“seçim”<\/h2>/);
  });

  it("passes the heading ref and the remove handler through", () => {
    const headingRef = vi.fn();
    const onRemove = vi.fn();
    const tree = FollowSection({
      follow: SECIM,
      state: undefined,
      seenAt: null,
      onRemove,
      headingRef,
    });
    const h2 = collect(tree).find((el) => el.type === "h2");
    expect(h2?.props?.ref).toBe(headingRef);
    expect(h2?.props?.tabIndex).toBe(-1);
    const remove = collect(tree).find(
      (el) => el.type === "button" && el.props?.["aria-label"] === "“seçim” takibini bırak",
    );
    (remove?.props?.onClick as () => void)();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("an error state offers 'Tekrar dene', named after the follow", () => {
    const markup = renderToStaticMarkup(
      section(SECIM, { status: "error", reason: "down" }),
    );
    expect(markup).toContain("Şu an yüklenemedi.");
    expect(markup).toMatch(/<button [^>]*aria-label="Tekrar dene: “seçim”"[^>]*>Tekrar dene<\/button>/);
    expect(markup).toContain('type="button"');
  });

  it("hands the label and the retry handler to its body, which wires the button", () => {
    const onRetry = vi.fn();
    const tree = FollowSection({
      follow: EKONOMI,
      state: { status: "error", reason: "rate" },
      seenAt: null,
      onRemove: () => {},
      onRetry,
    });
    const body = collect(tree).find((el) => el.type === SectionBody);
    expect(body?.props?.label).toBe("Ekonomi");
    expect(body?.props?.onRetry).toBe(onRetry);

    const retry = collect(SectionBody(body?.props as Parameters<typeof SectionBody>[0])).find(
      (el) => el.type === "button" && el.props?.["aria-label"] === "Tekrar dene: Ekonomi",
    );
    expect(retry).toBeDefined();
    (retry?.props?.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the 'yeni' badge only for stories first published after seenAt", () => {
    const markup = renderToStaticMarkup(
      section(
        SECIM,
        {
          status: "ok",
          items: [
            item({ id: "aaaaaaaa-1111-4111-8111-000000000001", firstPublished: "2026-10-22T10:00:00+00:00" }),
            item({ id: "aaaaaaaa-1111-4111-8111-000000000002", firstPublished: "2026-10-22T08:00:00+00:00" }),
          ],
        },
        { seenAt: NOW },
      ),
    );
    expect(markup).toContain("1 yeni");
  });
});

// h55-personal-1: the "N yeni" badge and the rows must agree. The list used to
// show 5 rows while the badge counted all 10 API items, and markSeen then
// stamped the unseen rows 6-10 as seen. The rows now extend to the last new
// story (followRowsToShow), so every story the badge calls "yeni" is on screen.
describe("FollowSection -- the rows cover every 'yeni' story", () => {
  function render(flags: boolean[], seenAt: string | null) {
    const items = newsItems(flags);
    const markup = renderToStaticMarkup(
      section(EKONOMI, { status: "ok", items }, { seenAt }),
    );
    return { items, markup };
  }

  /** Cluster ids linked from the rendered rows, in order. */
  function renderedIds(markup: string): string[] {
    return [...markup.matchAll(/<li><a [^>]*href="\/cluster\/([^"]+)"/g)].map((m) => m[1] as string);
  }

  /** Text of the badge pill, or null. */
  function badgeText(markup: string): string | null {
    return /<span class="shrink-0 rounded-full bg-brand\/15[^>]*>([^<]*)<\/span>/.exec(markup)?.[1] ?? null;
  }

  /** How many rendered rows were first published after seenAt. */
  function renderedNewRows(items: FollowItem[], markup: string, seenAt: string): number {
    const byId = new Map(items.map((i) => [i.id, i]));
    return renderedIds(markup).filter(
      (id) => Date.parse(byId.get(id)!.firstPublished) > Date.parse(seenAt),
    ).length;
  }

  it("(a) 10 items all after seenAt -> 10 rows and '10+ yeni'", () => {
    const { markup } = render(Array(10).fill(true), SEEN_AT);
    expect(count(markup, "<li>")).toBe(10);
    expect(renderedIds(markup)).toHaveLength(10);
    expect(badgeText(markup)).toBe("10+ yeni");
  });

  it("(b) 7 new + 3 old -> 7 rows and '7 yeni'", () => {
    const { items, markup } = render([...Array(7).fill(true), ...Array(3).fill(false)], SEEN_AT);
    expect(renderedIds(markup)).toHaveLength(7);
    expect(badgeText(markup)).toBe("7 yeni");
    expect(renderedNewRows(items, markup, SEEN_AT)).toBe(7);
  });

  it("(c) 2 new, the first and the seventh row -> 7 rows and '2 yeni'", () => {
    const flags = Array(10).fill(false);
    flags[0] = true;
    flags[6] = true;
    const { items, markup } = render(flags, SEEN_AT);
    expect(renderedIds(markup)).toHaveLength(7);
    expect(badgeText(markup)).toBe("2 yeni");
    expect(renderedNewRows(items, markup, SEEN_AT)).toBe(2);
  });

  it("a new story below row 5 is rendered even when fewer than 5 are new", () => {
    const flags = Array(10).fill(false);
    flags[7] = true;
    const { items, markup } = render(flags, SEEN_AT);
    expect(renderedIds(markup)).toEqual(items.slice(0, 8).map((i) => i.id));
    expect(badgeText(markup)).toBe("1 yeni");
  });

  it("(d) no baseline (seenAt null) -> the default 5 rows and no badge", () => {
    const { markup } = render(Array(10).fill(true), null);
    expect(renderedIds(markup)).toHaveLength(5);
    expect(badgeText(markup)).toBeNull();
    expect(markup).not.toContain("yeni");
  });

  it("nothing new keeps the default 5 rows and shows no badge", () => {
    const { markup } = render(Array(10).fill(false), SEEN_AT);
    expect(renderedIds(markup)).toHaveLength(5);
    expect(badgeText(markup)).toBeNull();
  });

  it("(e) the two-item case still shows '1 yeni' and both rows", () => {
    const { markup } = render([true, false], SEEN_AT);
    expect(renderedIds(markup)).toHaveLength(2);
    expect(badgeText(markup)).toBe("1 yeni");
  });

  it("the badge number always equals the new rows on screen", () => {
    const cases: boolean[][] = [
      [...Array(7).fill(true), ...Array(3).fill(false)],
      [true, false, false, false, false, false, true, false, false, false],
      [false, false, true, false, false, false, false, false, false, false],
      [true, true, true, false, false, false, false, false, false, false],
      [false, false, false, false, false, false, false, false, false, true],
    ];
    for (const flags of cases) {
      const { items, markup } = render(flags, SEEN_AT);
      const wanted = flags.filter(Boolean).length;
      expect(badgeText(markup)).toBe(`${wanted} yeni`);
      expect(renderedNewRows(items, markup, SEEN_AT)).toBe(wanted);
    }
  });

  it("hands seenAt through to its body (the body decides how many rows to show)", () => {
    const tree = FollowSection({
      follow: EKONOMI,
      state: { status: "ok", items: newsItems([true]) },
      seenAt: SEEN_AT,
      onRemove: () => {},
    });
    const body = collect(tree).find((el) => el.type === SectionBody);
    expect(body?.props?.seenAt).toBe(SEEN_AT);
  });

  it("SectionBody on its own, without a baseline, keeps the five-row cap", () => {
    const markup = renderToStaticMarkup(
      <SectionBody kind="konu" state={{ status: "ok", items: newsItems(Array(10).fill(true)) }} label="Ekonomi" />,
    );
    expect(count(markup, "<li>")).toBe(5);
  });

  it("the loading skeleton keeps ROWS_PER_FOLLOW rows whatever the baseline", () => {
    const markup = renderToStaticMarkup(
      <SectionBody kind="konu" state={undefined} seenAt={SEEN_AT} label="Ekonomi" />,
    );
    expect(count(markup, "h-[54px]")).toBe(5);
  });
});

describe("SectionBody", () => {
  it("loading keyword follow: a caption placeholder plus five 54px rows (no layout shift)", () => {
    const markup = renderToStaticMarkup(
      <SectionBody kind="q" state={undefined} label="“seçim”" />,
    );
    expect(markup).toContain('aria-busy="true"');
    expect(count(markup, "h-[54px]")).toBe(5);
    expect(count(markup, 'class="h-4 px-2"')).toBe(1);
    // The caption placeholder comes first, like the real caption.
    expect(markup.indexOf("h-4 px-2")).toBeLessThan(markup.indexOf("h-[54px]"));
    expect(markup).toContain("space-y-1");
    expect(markup).toContain("animate-pulse rounded-lg bg-card/60");
  });

  it("loading topic follow: five rows and no caption placeholder (a topic has no caption)", () => {
    const markup = renderToStaticMarkup(
      <SectionBody kind="konu" state={undefined} label="Ekonomi" />,
    );
    expect(count(markup, "h-[54px]")).toBe(5);
    expect(markup).not.toContain("h-4 px-2");
  });

  it("a loaded keyword list shows at most five rows under its caption", () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      item({ id: `aaaaaaaa-1111-4111-8111-00000000000${i}` }),
    );
    const loaded = renderToStaticMarkup(
      <SectionBody kind="q" state={{ status: "ok", items }} label="“seçim”" />,
    );
    // Five rows are shown per follow; the caption is the p.px-2 above the list.
    expect(count(loaded, "<li>")).toBe(5);
    expect(loaded).toContain("En çok kaynaklı eşleşmeler · yeniden eskiye");
  });

  it("an ok state ages each row by firstPublished, not updatedAt", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T09:00:00.000Z"));
    const row = item({
      firstPublished: "2026-10-22T07:00:00+00:00", // 2 hours ago
      updatedAt: "2026-10-22T08:50:00+00:00", // 10 minutes ago
    });
    const markup = renderToStaticMarkup(
      <SectionBody kind="konu" state={{ status: "ok", items: [row] }} label="Ekonomi" />,
    );
    const meta = followRowMeta(row);
    expect(meta).toBe("3 kaynak · 2 saat önce · İktidar 1 · Bağımsız 1 · Muhalefet 1");
    expect(markup).toContain(`<span>${meta}</span>`);
    expect(markup).not.toContain("10 dakika önce");
    expect(markup).toContain(`href="/cluster/${row.id}"`);
  });

  // h47-personal-1: the row prints the server's sourceCountHead wording, so the
  // count and the voting-only zone line next to it add up.
  it("a loaded row's text carries the countHead, '(4 sınıflandırılmış)' included", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T09:00:00.000Z"));
    const row = item({
      sourceCount: 5,
      countHead: "5 kaynak (4 sınıflandırılmış)",
      zoneLine: "İktidar 4 · Bağımsız 0 · Muhalefet 0",
    });
    const markup = renderToStaticMarkup(
      <SectionBody kind="q" state={{ status: "ok", items: [row] }} label="“seçim”" />,
    );
    expect(markup).toContain("(4 sınıflandırılmış)");
    expect(markup).toContain(
      "<span>5 kaynak (4 sınıflandırılmış) · 2 saat önce · İktidar 4 · Bağımsız 0 · Muhalefet 0</span>",
    );
  });

  it("a row from an old cached body (no countHead) still reads '{n} kaynak'", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T09:00:00.000Z"));
    const markup = renderToStaticMarkup(
      <SectionBody kind="konu" state={{ status: "ok", items: [item()] }} label="Ekonomi" />,
    );
    expect(markup).toContain("<span>3 kaynak · 2 saat önce · İktidar 1 · Bağımsız 1 · Muhalefet 1</span>");
    expect(markup).not.toContain("sınıflandırılmış");
  });

  it("marks a blindspot row", () => {
    const markup = renderToStaticMarkup(
      <SectionBody
        kind="konu"
        state={{ status: "ok", items: [item({ isBlindspot: true })] }}
        label="Ekonomi"
      />,
    );
    expect(markup).toContain("Kör nokta");
  });

  it("an ok state with no items shows the kind-specific empty copy", () => {
    expect(
      renderToStaticMarkup(<SectionBody kind="q" state={{ status: "ok", items: [] }} label="x" />),
    ).toContain("Eşleşen hikâye bulunamadı.");
    expect(
      renderToStaticMarkup(<SectionBody kind="konu" state={{ status: "ok", items: [] }} label="x" />),
    ).toContain("Son dönemde eşleşen hikâye yok.");
  });

  it("an error state keeps the reason copy and adds a 44px 'Tekrar dene' button", () => {
    const down = renderToStaticMarkup(
      <SectionBody kind="q" state={{ status: "error", reason: "down" }} label="“seçim”" />,
    );
    expect(down).toContain("Şu an yüklenemedi.");
    expect(down).toContain("min-h-[44px]");
    expect(down).toContain("touch-manipulation");
    const rate = renderToStaticMarkup(
      <SectionBody kind="q" state={{ status: "error", reason: "rate" }} label="“seçim”" />,
    );
    expect(rate).toContain("Çok sık yenilendi, biraz sonra tekrar deneyin.");
    expect(rate).toContain("Tekrar dene");
  });

  it("escapes a hostile keyword in the retry button's name", () => {
    const markup = renderToStaticMarkup(
      <SectionBody
        kind="q"
        state={{ status: "error", reason: "down" }}
        label="“<img src=x onerror=alert(1)>”"
      />,
    );
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
  });

  it("the retry button's visible text is exactly 'Tekrar dene'", () => {
    const tree = SectionBody({
      kind: "q",
      state: { status: "error", reason: "down" },
      label: "“seçim”",
    });
    const button = collect(tree).find((el) => el.type === "button");
    expect(textOf(button)).toBe("Tekrar dene");
  });
});
