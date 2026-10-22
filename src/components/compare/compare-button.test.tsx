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

import { CompareButton } from "./compare-button";

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

/** Calls the (hook-mocked) function component directly and returns its tree. */
function treeFor(clusterId: string): ReactNode {
  return (CompareButton as (p: { clusterId: string }) => ReactNode)({ clusterId });
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

const STATES: Array<[string, readonly string[]]> = [
  ["empty tray", []],
  ["other id only", [OTHER]],
  ["current id only", [ID]],
  ["two ids incl. current", [OTHER, ID]],
  ["full tray without current", [OTHER, THIRD]],
];

function buttonSlot(children: Array<El | null | false>): number {
  return children.findIndex((c) => c && c.type === "button");
}

describe("CompareButton — focus stays put across state changes", () => {
  it("keeps the same slot count and the <button> at the same slot in every state", () => {
    const shapes = STATES.map(([, tray]) => {
      override = fakeTray(tray);
      const children = rootChildren(treeFor(ID));
      return { length: children.length, button: buttonSlot(children) };
    });
    const first = shapes[0];
    expect(first?.button).toBeGreaterThanOrEqual(0);
    for (const shape of shapes) expect(shape).toEqual(first);
  });

  it("renders exactly one <button> in every state", () => {
    for (const [, tray] of STATES) {
      override = fakeTray(tray);
      const buttons = collectElements(treeFor(ID)).filter((el) => el.type === "button");
      expect(buttons).toHaveLength(1);
    }
  });

  it("never gives the activated <button> a state-dependent key", () => {
    for (const [, tray] of STATES) {
      override = fakeTray(tray);
      const children = rootChildren(treeFor(ID));
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
  function statusOf(tray: readonly string[]): El {
    override = fakeTray(tray);
    const status = rootChildren(treeFor(ID)).find(
      (c): c is El => !!c && c.props?.role === "status",
    );
    if (!status) throw new Error("no role=status element");
    return status;
  }

  it("mounts a polite live region in every state", () => {
    for (const [, tray] of STATES) {
      const status = statusOf(tray);
      expect(status.props?.["aria-live"]).toBe("polite");
    }
  });

  it("keeps the live region at the same slot in every state", () => {
    const slots = STATES.map(([, tray]) => {
      override = fakeTray(tray);
      return rootChildren(treeFor(ID)).findIndex((c) => !!c && c.props?.role === "status");
    });
    expect(slots[0]).toBeGreaterThanOrEqual(0);
    expect(new Set(slots).size).toBe(1);
  });

  it("empty tray: region is present but empty and visually hidden", () => {
    const status = statusOf([]);
    expect(collectText(status.props?.children).join("")).toBe("");
    expect(String(status.props?.className)).toContain("sr-only");
  });

  it("[current]: the visible hint lives inside the live region", () => {
    const status = statusOf([ID]);
    expect(collectText(status.props?.children).join("")).toBe(
      "Karşılaştırmaya eklendi · ikinci haberi açıp “Karşılaştır”a dokunun",
    );
    expect(String(status.props?.className)).not.toContain("sr-only");
  });

  it("two ids: announces readiness to screen readers without extra visual clutter", () => {
    const status = statusOf([OTHER, ID]);
    expect(collectText(status.props?.children).join("")).toBe(
      "İki haber seçildi · karşılaştırmaya hazır",
    );
    expect(String(status.props?.className)).toContain("sr-only");
  });

  it("markup carries role=status and aria-live=polite in all states", () => {
    for (const [, tray] of STATES) {
      override = fakeTray(tray);
      const markup = renderToStaticMarkup(<CompareButton clusterId={ID} />);
      expect(markup).toContain('role="status"');
      expect(markup).toContain('aria-live="polite"');
    }
  });
});
