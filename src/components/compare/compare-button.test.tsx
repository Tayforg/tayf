import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Tray = {
  tray: readonly string[];
  add: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
};

// When `override` is null the REAL hook runs (SSR test below); otherwise the
// button is driven by a fake tray so each state can be asserted directly.
let override: Tray | null = null;
vi.mock("./use-compare-tray", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-compare-tray")>();
  return {
    ...actual,
    useCompareTray: () => override ?? actual.useCompareTray(),
  };
});

import { CompareButton, CompareButtonView } from "./compare-button";
import { COMPARE_HINT_ONE, COMPARE_HINT_TWO } from "@/lib/compare/compare-tray";

const ID = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
const OTHER = "cccccccc-2222-4222-8222-dddddddddddd";
const THIRD = "eeeeeeee-3333-4333-8333-ffffffffffff";

const add = vi.fn();
const remove = vi.fn();
const clear = vi.fn();

function fakeTray(tray: readonly string[]): Tray {
  return { tray, add, remove, clear };
}

function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { children?: ReactNode } };
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

type El = { type?: unknown; props?: Record<string, unknown> };

function collectElements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as El;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) collectElements(el.props.children, out);
  }
  return out;
}

/**
 * Calls the hook-free view directly and returns its tree. The tray comes from
 * `override` (so each test keeps reading `override = fakeTray(...)`); `notice`
 * is the CompareButton wrapper's local state, passed in explicitly.
 */
function treeFor(clusterId: string, notice = ""): ReactNode {
  const { tray } = override ?? fakeTray([]);
  return CompareButtonView({ clusterId, tray, add, remove, clear, notice });
}

function buttonWithText(tree: unknown, text: string): El {
  const found = collectElements(tree).find(
    (el) => el.type === "button" && collectText(el.props?.children).join("").includes(text),
  );
  if (!found) throw new Error(`no <button> containing ${text}`);
  return found;
}

beforeEach(() => {
  override = null;
  add.mockReset();
  remove.mockReset();
  clear.mockReset();
});

describe("CompareButton — SSR", () => {
  it("renders 'Karşılaştır' on the server without touching window", () => {
    // Node env: `window` / `sessionStorage` do not exist, so any render-time
    // access would throw a ReferenceError here.
    expect(typeof window).toBe("undefined");
    const markup = renderToStaticMarkup(<CompareButton clusterId={ID} />);
    expect(markup).toContain("Karşılaştır");
    expect(markup).toContain('type="button"');
    expect(markup).not.toContain("Vazgeç");
    expect(markup).not.toContain("Temizle");
    expect(markup).not.toContain("/karsilastir");
  });

  it("uses the bookmark chip styling", () => {
    const markup = renderToStaticMarkup(<CompareButton clusterId={ID} />);
    expect(markup).toContain("rounded-full");
    expect(markup).toContain("border-border/60");
    expect(markup).toContain("bg-muted/40");
    expect(markup).toContain("text-[11px]");
  });
});

describe("CompareButton — tray states", () => {
  it("empty tray: plain button that adds the current id", () => {
    override = fakeTray([]);
    const tree = treeFor(ID);
    const button = buttonWithText(tree, "Karşılaştır");
    expect(collectText(tree).join(" ")).not.toContain("eklendi");
    (button.props?.onClick as () => void)();
    expect(add).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it("current id not in the tray (other id present): still offers 'Karşılaştır'", () => {
    override = fakeTray([OTHER]);
    const tree = treeFor(ID);
    const text = collectText(tree).join(" ");
    expect(text).toContain("Karşılaştır");
    expect(text).not.toContain("eklendi");
    expect(text).not.toContain("Vazgeç");
    (buttonWithText(tree, "Karşılaştır").props?.onClick as () => void)();
    expect(add).toHaveBeenCalledWith(ID);
  });

  it("full tray that does not contain the current id: button that evicts via add", () => {
    override = fakeTray([OTHER, THIRD]);
    const tree = treeFor(ID);
    expect(collectText(tree).join(" ")).not.toContain("(2)");
    (buttonWithText(tree, "Karşılaştır").props?.onClick as () => void)();
    expect(add).toHaveBeenCalledWith(ID);
  });

  it("tray is [current]: shows the hint and a 'Vazgeç' button that removes it", () => {
    override = fakeTray([ID]);
    const tree = treeFor(ID);
    const text = collectText(tree).join(" ");
    expect(text).toContain(
      "Karşılaştırmaya eklendi · ikinci haberi açıp “Karşılaştır”a dokunun",
    );
    (buttonWithText(tree, "Vazgeç").props?.onClick as () => void)();
    expect(remove).toHaveBeenCalledExactlyOnceWith(ID);
    expect(add).not.toHaveBeenCalled();
  });

  it("matches an uppercase route param against the lowercase tray", () => {
    override = fakeTray([ID]);
    expect(collectText(treeFor(ID.toUpperCase())).join(" ")).toContain("Vazgeç");
  });

  it("tray has two ids including the current: link to the compare view plus 'Temizle'", () => {
    override = fakeTray([OTHER, ID]);
    const tree = treeFor(ID);
    const link = collectElements(tree).find(
      (el) => typeof el.props?.href === "string",
    );
    expect(link?.props?.href).toBe(`/karsilastir?a=${OTHER}&b=${ID}`);
    expect(collectText(link?.props?.children).join("")).toContain("Karşılaştır (2) →");
    (buttonWithText(tree, "Temizle").props?.onClick as () => void)();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("renders the two-id state as markup with a real anchor", () => {
    override = fakeTray([ID, OTHER]);
    const markup = renderToStaticMarkup(<CompareButton clusterId={ID} />);
    expect(markup).toContain(`href="/karsilastir?a=${ID}&amp;b=${OTHER}"`);
    expect(markup).toContain("Karşılaştır (2) →");
    expect(markup).toContain("Temizle");
  });
});

// ---------------------------------------------------------------------------
// Accessibility. Activating the button changes the tray, which changes what
// the component renders. React keeps the DOM node of an element whose type and
// position are unchanged, so the activated <button> must stay at one stable
// slot in all three states -- otherwise it is unmounted, focus falls back to
// <body> and a keyboard / screen-reader user loses their place. The state
// change must also be announced, via a live region that is mounted in every
// state (a region inserted together with its text is usually not announced).
// ---------------------------------------------------------------------------

function rootChildren(tree: unknown): Array<El | null | false> {
  const root = tree as El;
  expect(root.type).toBe("span"); // one persistent wrapper, not a Fragment
  const children = root.props?.children;
  return (Array.isArray(children) ? children : [children]) as Array<El | null | false>;
}

const CLEARED = "Seçim temizlendi";
const WITHDRAWN = "Karşılaştırmadan çıkarıldı";

const STATES: Array<[string, readonly string[], string]> = [
  ["empty tray", [], ""],
  ["other id only", [OTHER], ""],
  ["current id only", [ID], ""],
  ["two ids incl. current", [OTHER, ID], ""],
  ["full tray without current", [OTHER, THIRD], ""],
  ["empty tray after Temizle", [], CLEARED],
  ["empty tray after Vazgeç", [], WITHDRAWN],
];

function buttonSlot(children: Array<El | null | false>): number {
  return children.findIndex((c) => c && c.type === "button");
}

function statusSlot(children: Array<El | null | false>): number {
  return children.findIndex((c) => !!c && c.props?.role === "status");
}

describe("CompareButton — focus stays put across state changes", () => {
  it("keeps the same slot count and the <button> and status at the same slots in every state", () => {
    const shapes = STATES.map(([, tray, notice]) => {
      override = fakeTray(tray);
      const children = rootChildren(treeFor(ID, notice));
      return {
        length: children.length,
        button: buttonSlot(children),
        status: statusSlot(children),
      };
    });
    const first = shapes[0];
    expect(first?.button).toBeGreaterThanOrEqual(0);
    expect(first?.status).toBeGreaterThanOrEqual(0);
    for (const shape of shapes) expect(shape).toEqual(first);
  });

  // h60-mobile-1: the visible hint must come AFTER the control, never before
  // it, so the hint appearing cannot push the tapped button to a new line.
  // Slot order is [compare link | null] [button] [role=status] in EVERY state.
  it("orders the slots [link | null] [button] [status] in every state", () => {
    for (const [name, tray, notice] of STATES) {
      override = fakeTray(tray);
      const children = rootChildren(treeFor(ID, notice));
      expect(children, name).toHaveLength(3);
      expect(buttonSlot(children), `${name}: button slot`).toBe(1);
      expect(statusSlot(children), `${name}: status slot`).toBe(2);
      expect(buttonSlot(children)).toBeLessThan(statusSlot(children));
      // Slot 0 is the compare link (two ids incl. current) or nothing at all.
      const first = children[0];
      if (first) expect(typeof first.props?.href, `${name}: slot 0 is the link`).toBe("string");
    }
  });

  it("renders exactly one <button> in every state", () => {
    for (const [, tray, notice] of STATES) {
      override = fakeTray(tray);
      const buttons = collectElements(treeFor(ID, notice)).filter((el) => el.type === "button");
      expect(buttons).toHaveLength(1);
    }
  });

  it("never gives the activated <button> a state-dependent key", () => {
    for (const [, tray, notice] of STATES) {
      override = fakeTray(tray);
      const children = rootChildren(treeFor(ID, notice));
      const button = children[buttonSlot(children)] as unknown as { key: unknown };
      expect(button.key).toBeNull();
    }
  });

  it("swaps the label and handler of that one button per state", () => {
    override = fakeTray([ID]);
    const inTray = buttonWithText(treeFor(ID), "Vazgeç");
    (inTray.props?.onClick as () => void)();
    expect(remove).toHaveBeenCalledExactlyOnceWith(ID);

    override = fakeTray([OTHER, ID]);
    const full = buttonWithText(treeFor(ID), "Temizle");
    (full.props?.onClick as () => void)();
    expect(clear).toHaveBeenCalledTimes(1);

    override = fakeTray([]);
    const empty = buttonWithText(treeFor(ID), "Karşılaştır");
    (empty.props?.onClick as () => void)();
    expect(add).toHaveBeenCalledExactlyOnceWith(ID);
  });
});

describe("CompareButton — status is announced", () => {
  function statusOf(tray: readonly string[], notice = ""): El {
    override = fakeTray(tray);
    const status = rootChildren(treeFor(ID, notice)).find(
      (c): c is El => !!c && c.props?.role === "status",
    );
    if (!status) throw new Error("no role=status element");
    return status;
  }

  it("mounts a polite live region in every state", () => {
    for (const [, tray, notice] of STATES) {
      const status = statusOf(tray, notice);
      expect(status.props?.["aria-live"]).toBe("polite");
    }
  });

  it("keeps the live region at the same slot in every state, after the button", () => {
    const slots = STATES.map(([, tray, notice]) => {
      override = fakeTray(tray);
      const children = rootChildren(treeFor(ID, notice));
      return { status: statusSlot(children), button: buttonSlot(children) };
    });
    expect(slots[0]?.status).toBeGreaterThanOrEqual(0);
    expect(new Set(slots.map((s) => s.status)).size).toBe(1);
    expect(new Set(slots.map((s) => s.button)).size).toBe(1);
    for (const s of slots) expect(s.button).toBeLessThan(s.status);
  });

  it("empty tray: region is present but empty and visually hidden", () => {
    const status = statusOf([]);
    expect(collectText(status.props?.children).join("")).toBe("");
    expect(String(status.props?.className)).toContain("sr-only");
  });

  it("[current]: the visible hint lives inside the live region", () => {
    const status = statusOf([ID]);
    expect(collectText(status.props?.children).join("")).toBe(COMPARE_HINT_ONE);
    expect(String(status.props?.className)).not.toContain("sr-only");
  });

  it("[other]: the visible hint says this story would be the second pick", () => {
    const status = statusOf([OTHER]);
    expect(collectText(status.props?.children).join("")).toBe(
      "1 haber seçili · bunu ikinci olarak ekleyin",
    );
    expect(String(status.props?.className)).not.toContain("sr-only");
  });

  it("[other, third]: the visible region warns that adding evicts the first pick", () => {
    const status = statusOf([OTHER, THIRD]);
    expect(collectText(status.props?.children).join("")).toBe(
      "2 haber seçili · eklerseniz ilk seçim çıkar",
    );
    expect(String(status.props?.className)).not.toContain("sr-only");
  });

  it.each([
    ["Temizle", CLEARED],
    ["Vazgeç", WITHDRAWN],
  ])("empty tray after %s: the notice is announced, screen-reader-only", (_a, notice) => {
    const status = statusOf([], notice);
    expect(collectText(status.props?.children).join("")).toBe(notice);
    expect(String(status.props?.className)).toContain("sr-only");
  });

  it("in-tray states ignore a leftover notice", () => {
    expect(collectText(statusOf([ID], CLEARED).props?.children).join("")).toBe(COMPARE_HINT_ONE);
    expect(collectText(statusOf([OTHER, ID], CLEARED).props?.children).join("")).toBe(
      COMPARE_HINT_TWO,
    );
  });

  it("two ids: announces readiness to screen readers without extra visual clutter", () => {
    const status = statusOf([OTHER, ID]);
    expect(collectText(status.props?.children).join("")).toBe(COMPARE_HINT_TWO);
    expect(String(status.props?.className)).toContain("sr-only");
  });

  it("markup carries role=status and aria-live=polite in all states", () => {
    for (const [, tray, notice] of STATES) {
      const markup = renderToStaticMarkup(
        <CompareButtonView
          clusterId={ID}
          tray={tray}
          add={add}
          remove={remove}
          clear={clear}
          notice={notice}
        />,
      );
      expect(markup).toContain('role="status"');
      expect(markup).toContain('aria-live="polite"');
    }
  });

  it("markup of the real wrapper still carries the live region (pre-hydration)", () => {
    const markup = renderToStaticMarkup(<CompareButton clusterId={ID} />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });
});

// ---------------------------------------------------------------------------
// h60-mobile-1: on phones tapping "Karşılaştır" inserted the visible hint
// BEFORE the button inside one inline-flex flex-wrap span, so the button (and
// "Düzeltme talebi") wrapped ~41 px down and the bias spectrum left the first
// screen. On phones the wrapper now dissolves (max-sm:contents) so its
// children join the page's actions row, and the visible hint drops to its own
// line at the END of that row. sm and up are unchanged.
// ---------------------------------------------------------------------------

describe("CompareButton — phone reflow (h60-mobile-1)", () => {
  function hintClass(tray: readonly string[], notice = ""): string {
    override = fakeTray(tray);
    const status = rootChildren(treeFor(ID, notice)).find(
      (c): c is El => !!c && c.props?.role === "status",
    );
    if (!status) throw new Error("no role=status element");
    return String(status.props?.className);
  }

  it("the wrapper class is the literal that dissolves it on phones, in every state", () => {
    for (const [name, tray, notice] of STATES) {
      override = fakeTray(tray);
      const root = treeFor(ID, notice) as El;
      expect(String(root.props?.className), name).toBe(
        "inline-flex flex-wrap items-center gap-2 max-sm:contents",
      );
    }
  });

  it.each([
    ["[current]", [ID]],
    ["[other]", [OTHER]],
    ["[other, third]", [OTHER, THIRD]],
  ] as Array<[string, readonly string[]]>)(
    "%s: the visible hint drops to its own line at the end of the row on phones",
    (_name, tray) => {
      const cls = hintClass(tray);
      expect(cls).toContain("max-sm:order-last");
      expect(cls).toContain("max-sm:basis-full");
      expect(cls).not.toContain("sr-only");
      expect(cls).toBe("text-[11px] text-muted-foreground max-sm:order-last max-sm:basis-full");
    },
  );

  it("the empty-tray region stays sr-only (and takes no phone layout classes)", () => {
    const cls = hintClass([]);
    expect(cls).toBe("sr-only");
    expect(cls).not.toContain("max-sm:");
  });

  it("the screen-reader-only confirmations stay sr-only", () => {
    expect(hintClass([OTHER, ID])).toBe("sr-only");
    expect(hintClass([], CLEARED)).toBe("sr-only");
    expect(hintClass([], WITHDRAWN)).toBe("sr-only");
  });

  it("keeps the 44 px targets on the button and the link", () => {
    override = fakeTray([ID]);
    expect(String(buttonWithText(treeFor(ID), "Vazgeç").props?.className)).toContain(
      "min-h-[44px]",
    );
    override = fakeTray([OTHER, ID]);
    const link = collectElements(treeFor(ID)).find((el) => typeof el.props?.href === "string");
    expect(String(link?.props?.className)).toContain("min-h-[44px]");
  });

  it("markup: the button precedes the live region in every state", () => {
    for (const [name, tray, notice] of STATES) {
      const markup = renderToStaticMarkup(
        <CompareButtonView
          clusterId={ID}
          tray={tray}
          add={add}
          remove={remove}
          clear={clear}
          notice={notice}
        />,
      );
      expect(markup.indexOf("<button"), name).toBeGreaterThan(-1);
      expect(markup.indexOf("<button"), name).toBeLessThan(markup.indexOf('role="status"'));
      expect(markup, name).toContain("max-sm:contents");
    }
  });
});

describe("CompareButtonView — invalid ids", () => {
  it("renders nothing for an id that is not a UUID", () => {
    expect(treeFor("<script>")).toBeNull();
    expect(treeFor("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hit targets (WCAG 2.5.5 / 2.5.8): every control is at least 44px tall.
// ---------------------------------------------------------------------------

describe("CompareButton — 44px hit targets", () => {
  it("the text buttons ('Vazgeç' / 'Temizle') are at least 44px tall", () => {
    override = fakeTray([ID]);
    expect(String(buttonWithText(treeFor(ID), "Vazgeç").props?.className)).toContain(
      "min-h-[44px]",
    );
    override = fakeTray([OTHER, ID]);
    expect(String(buttonWithText(treeFor(ID), "Temizle").props?.className)).toContain(
      "min-h-[44px]",
    );
  });

  it("the chip button and the 'Karşılaştır (2)' link are at least 44px tall too", () => {
    override = fakeTray([]);
    expect(String(buttonWithText(treeFor(ID), "Karşılaştır").props?.className)).toContain(
      "min-h-[44px]",
    );
    override = fakeTray([OTHER, ID]);
    const link = collectElements(treeFor(ID)).find((el) => typeof el.props?.href === "string");
    expect(String(link?.props?.className)).toContain("min-h-[44px]");
  });

  it("keeps the shared chip look (rounded pill, 11px label) on those taller controls", () => {
    override = fakeTray([]);
    const cls = String(buttonWithText(treeFor(ID), "Karşılaştır").props?.className);
    expect(cls).toContain("rounded-full");
    expect(cls).toContain("text-[11px]");
    expect(cls).toContain("touch-manipulation");
  });
});

// ---------------------------------------------------------------------------
// The wrapper owns the hook and the `notice` state. It is called inside a probe
// component so its hooks run in a real render; the element it returns is the
// view, whose handlers we then invoke.
// ---------------------------------------------------------------------------

describe("CompareButton — wrapper wiring", () => {
  function viewPropsOf(tray: readonly string[]) {
    override = fakeTray(tray);
    let captured: { props: Record<string, unknown> } | null = null;
    function Probe() {
      captured = CompareButton({ clusterId: ID }) as unknown as {
        props: Record<string, unknown>;
      };
      return null;
    }
    renderToStaticMarkup(<Probe />);
    if (!captured) throw new Error("CompareButton returned nothing");
    return (captured as { props: Record<string, unknown> }).props;
  }

  it("renders the view with the tray, the id and an empty notice", () => {
    const props = viewPropsOf([OTHER]);
    expect(props.clusterId).toBe(ID);
    expect(props.tray).toEqual([OTHER]);
    expect(props.notice).toBe("");
  });

  it("forwards add / remove / clear to the tray hook", () => {
    const props = viewPropsOf([]);
    (props.add as (id: string) => void)(ID);
    expect(add).toHaveBeenCalledExactlyOnceWith(ID);
    (props.remove as (id: string) => void)(ID);
    expect(remove).toHaveBeenCalledExactlyOnceWith(ID);
    (props.clear as () => void)();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
