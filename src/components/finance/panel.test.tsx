import { describe, expect, it } from "vitest";

import { Panel, PanelEmpty } from "./panel";

// Walks the element tree the way ticker-chip.test.tsx does: vitest runs in a
// plain node environment (no jsdom/RTL) and Panel is a pure function component,
// so it is called directly and the returned element inspected.
type El = { type: unknown; props: Record<string, unknown> };

function collect(node: unknown, out: El[] = []): El[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.props !== undefined) {
    out.push({ type: el.type, props: el.props });
    collect(el.props.children, out);
  }
  return out;
}

function byType(root: unknown, type: string): El[] {
  return collect(root).filter((e) => e.type === type);
}

function classOf(el: El | undefined): string {
  return typeof el?.props.className === "string" ? el.props.className : "";
}

function tokens(el: El | undefined): string[] {
  return classOf(el).split(/\s+/).filter(Boolean);
}

// h11-mobile-1: at 375 px the meta of "son 2 gün, haber sayısına göre" (198 px
// of text in a 189 px slot) and "devre kesiciler hariç, en yeni üstte" (238 in
// 213) was cut off by `truncate` with no title attribute, and the h2 wrapped to
// a second line. The header now wraps and the meta takes its full text.
describe("Panel header (h11-mobile-1)", () => {
  const root = Panel({
    title: "Haber akışı",
    meta: "devre kesiciler hariç, en yeni üstte",
    children: <p>içerik</p>,
  });
  const header = byType(root, "header")[0];
  const metaSpan = byType(header, "span")[0];

  it("wraps the meta below the title instead of squeezing it", () => {
    expect(header).toBeDefined();
    const t = tokens(header);
    expect(t).toContain("flex");
    expect(t).toContain("flex-wrap");
    expect(t).toContain("items-baseline");
    expect(t).toContain("justify-between");
    expect(t).toContain("gap-x-3");
    expect(t).toContain("gap-y-1");
  });

  it("keeps the rest of the terminal title-bar styling", () => {
    expect(classOf(header)).toBe(
      "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border bg-foreground/[0.04] px-3 py-1.5 font-mono text-[11px] leading-none",
    );
  });

  it("renders the meta without truncate, with min-w-0 and the muted colour", () => {
    expect(metaSpan).toBeDefined();
    const t = tokens(metaSpan);
    expect(t).not.toContain("truncate");
    expect(t).not.toContain("overflow-hidden");
    expect(t).not.toContain("text-ellipsis");
    expect(t).not.toContain("whitespace-nowrap");
    expect(t).toContain("min-w-0");
    expect(t).toContain("text-muted-foreground");
    expect(classOf(metaSpan)).toBe("min-w-0 text-muted-foreground leading-tight");
    expect(metaSpan?.props.children).toBe("devre kesiciler hariç, en yeni üstte");
  });

  it("still renders the title in the brand h2 and the children in the body", () => {
    const h2 = byType(header, "h2")[0];
    expect(h2?.props.children).toBe("Haber akışı");
    expect(tokens(h2)).toContain("text-brand");
    expect(classOf(root as El)).toContain("min-w-0");
    expect(byType(root, "p").some((p) => p.props.children === "içerik")).toBe(true);
  });

  it("omits the meta span when no meta is given", () => {
    const bare = Panel({ title: "Başlık", children: <p>x</p> });
    expect(byType(byType(bare, "header")[0], "span")).toHaveLength(0);
  });

  it("merges a caller className onto the section", () => {
    const withClass = Panel({ title: "T", className: "lg:col-span-2", children: null });
    expect(classOf(withClass as unknown as El)).toContain("lg:col-span-2");
  });
});

describe("PanelEmpty", () => {
  it("is unchanged: a muted mono paragraph with the empty-state padding", () => {
    const el = PanelEmpty({ children: "Veri yok" }) as unknown as El;
    expect(el.type).toBe("p");
    expect(el.props.className).toBe(
      "px-3 py-6 font-mono text-[12px] leading-relaxed text-muted-foreground",
    );
    expect(el.props.children).toBe("Veri yok");
  });
});
