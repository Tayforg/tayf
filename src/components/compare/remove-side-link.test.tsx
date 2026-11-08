import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

type Tray = {
  tray: readonly string[];
  add: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
};

// When `override` is null the REAL hook runs (SSR test below); otherwise the
// link is driven by a fake tray so the click handler can be asserted directly.
let override: Tray | null = null;
vi.mock("./use-compare-tray", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-compare-tray")>();
  return {
    ...actual,
    useCompareTray: () => override ?? actual.useCompareTray(),
  };
});

import Link from "next/link";
import { RemoveSideLink } from "./remove-side-link";
import { compareHref } from "@/lib/compare/compare-params";

const A = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
const B = "cccccccc-2222-4222-8222-dddddddddddd";

const add = vi.fn();
const remove = vi.fn();
const clear = vi.fn();

const CLASS_NAME =
  "inline-flex min-h-[44px] items-center self-start justify-self-start touch-manipulation text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground";

const props = {
  href: compareHref(A),
  removeId: B,
  className: CLASS_NAME,
  "aria-label": "Bu tarafı kaldır: İkinci hikâye",
  children: "Bu tarafı kaldır",
};

beforeEach(() => {
  override = null;
  add.mockReset();
  remove.mockReset();
  clear.mockReset();
});

describe("RemoveSideLink — click", () => {
  it("renders a next/link carrying the href, class and aria-label it was given", () => {
    override = { tray: [A, B], add, remove, clear };
    const el = RemoveSideLink(props) as { type: unknown; props: Record<string, unknown> };
    expect(el.type).toBe(Link);
    expect(el.props.href).toBe(`/karsilastir?a=${A}`);
    expect(el.props.className).toBe(CLASS_NAME);
    expect(el.props["aria-label"]).toBe("Bu tarafı kaldır: İkinci hikâye");
    expect(el.props.children).toBe("Bu tarafı kaldır");
  });

  it("removes the removed side from the tray when Link navigates, exactly once, and nothing else", () => {
    override = { tray: [A, B], add, remove, clear };
    const el = RemoveSideLink(props) as {
      props: { onNavigate: (e: { preventDefault: () => void }) => void };
    };
    el.props.onNavigate({ preventDefault: vi.fn() });
    expect(remove).toHaveBeenCalledExactlyOnceWith(B);
    expect(add).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("leaves the tray alone on a click Link does not navigate (Cmd/Ctrl/Shift/Alt, new tab)", () => {
    // Link calls a user `onClick` for every click but only calls `onNavigate`
    // once it has decided to do the in-app navigation (it returns before that
    // for modified clicks and new-tab targets). So no onClick may be wired.
    override = { tray: [A, B], add, remove, clear };
    const el = RemoveSideLink(props) as { props: Record<string, unknown> };
    expect(el.props.onClick).toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("does not take the event, so the navigation proceeds (no preventDefault)", () => {
    override = { tray: [A, B], add, remove, clear };
    const el = RemoveSideLink(props) as {
      props: { onNavigate: (e: { preventDefault: () => void }) => unknown };
    };
    const preventDefault = vi.fn();
    expect(() => el.props.onNavigate({ preventDefault })).not.toThrow();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("asks the tray to remove the id even when the tray does not hold it (the tray makes it a no-op)", () => {
    override = { tray: [], add, remove, clear };
    const el = RemoveSideLink(props) as {
      props: { onNavigate: (e: { preventDefault: () => void }) => void };
    };
    el.props.onNavigate({ preventDefault: vi.fn() });
    expect(remove).toHaveBeenCalledExactlyOnceWith(B);
  });
});

describe("RemoveSideLink — SSR", () => {
  it("renders a plain anchor on the server without touching window", () => {
    // Node env: `window` / `sessionStorage` do not exist, so any render-time
    // access would throw a ReferenceError here.
    expect(typeof window).toBe("undefined");
    const markup = renderToStaticMarkup(<RemoveSideLink {...props} />);
    expect(markup).toMatch(/^<a /);
    expect(markup).toContain(`href="/karsilastir?a=${A}"`);
    expect(markup).toContain('aria-label="Bu tarafı kaldır: İkinci hikâye"');
    expect(markup).toContain("min-h-[44px]");
    expect(markup).toContain("touch-manipulation");
    expect(markup).toContain(">Bu tarafı kaldır</a>");
  });

  it("escapes a hostile aria-label rather than injecting markup", () => {
    const markup = renderToStaticMarkup(
      <RemoveSideLink {...props} aria-label={'Bu tarafı kaldır: "><script>x</script>'} />,
    );
    expect(markup).not.toContain("<script>");
  });
});
