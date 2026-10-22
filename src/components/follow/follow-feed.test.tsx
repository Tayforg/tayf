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

describe("EmptyState", () => {
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
