import { describe, it, expect } from "vitest";
import { SourceChips, ownershipLabel } from "./source-chips";

// SourceChips is a synchronous function component (no hooks, no async) so
// it can be called directly as a plain function and its returned React
// element tree walked without a DOM. NOTE: this file is `.test.ts`, not
// `.test.tsx` — tsconfig excludes `**/*.test.ts` from typecheck but NOT
// `.test.tsx`, and there is no jsdom/testing-library dependency in this
// repo to render a `.tsx` test anyway.

interface MinimalNode {
  props?: {
    children?: unknown;
    className?: string;
    title?: string;
  };
}

function isNode(value: unknown): value is MinimalNode {
  return typeof value === "object" && value !== null && "props" in value;
}

function collectText(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return [];
  }
  if (typeof node === "string" || typeof node === "number") {
    return [String(node)];
  }
  if (Array.isArray(node)) {
    return node.flatMap(collectText);
  }
  const maybe = node as MinimalNode;
  if (maybe && typeof maybe === "object" && "props" in maybe) {
    return collectText(maybe.props?.children);
  }
  return [];
}

// Walks the element tree (including the root `node` itself) and returns
// every node — element or child — matching `predicate`. Used to locate a
// specific chip (e.g. by its `title`) or a specific className fragment
// without a DOM.
function findAll(
  node: unknown,
  predicate: (n: MinimalNode) => boolean,
): MinimalNode[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((child) => findAll(child, predicate));
  }
  if (!isNode(node)) return [];
  const self = predicate(node) ? [node] : [];
  return self.concat(findAll(node.props?.children, predicate));
}

describe("SourceChips", () => {
  it("returns null for an unknown slug with no opt-in", () => {
    expect(SourceChips({ slug: "bilinmeyen-kaynak" })).toBeNull();
  });

  it("renders the 'sınıflandırılmamış' chip for an unknown slug when opted in", () => {
    const el = SourceChips({
      slug: "bilinmeyen-kaynak",
      showUnclassified: true,
    });
    expect(el).not.toBeNull();
    const text = collectText(el).join(" ");
    expect(text).toContain("sınıflandırılmamış");
  });

  it("does not show the unclassified chip for a tagged source, even opted in", () => {
    const el = SourceChips({ slug: "sabah", showUnclassified: true });
    const text = collectText(el).join(" ");
    expect(text).not.toContain("sınıflandırılmamış");
    expect(text).toContain("Karışık doğruluk");
  });

  it("the opt-in prop does not alter tagged sources (same output as no prop)", () => {
    const el = SourceChips({ slug: "sabah" });
    const text = collectText(el).join(" ");
    expect(text).not.toContain("sınıflandırılmamış");
    expect(text).toContain("Karışık doğruluk");
  });

  it("wraps the chip group instead of overflowing on one line", () => {
    const el = SourceChips({ slug: "sabah" }) as MinimalNode;
    expect(el.props?.className ?? "").toContain("flex-wrap");
  });

  it("truncates a long ownership chip label instead of overflowing", () => {
    const el = SourceChips({ slug: "sabah" });
    const [ownershipChip] = findAll(
      el,
      (n) =>
        typeof n.props?.title === "string" &&
        n.props.title.startsWith("Sahiplik:"),
    );
    expect(ownershipChip).toBeDefined();

    const truncatedLabel = findAll(
      ownershipChip?.props?.children,
      (n) =>
        typeof n.props?.className === "string" &&
        n.props.className.includes("truncate"),
    );
    expect(truncatedLabel.length).toBeGreaterThan(0);

    // The full label must still be present in the DOM (assistive tech reads
    // the real text, only the visual box clips it).
    expect(collectText(truncatedLabel[0]).join(" ")).toContain(
      "Turkuvaz Medya (Kalyon Grubu)",
    );
  });
});

describe("SourceChips — mobile künye wrap (B)", () => {
  it("the wrapper carries flex-wrap and min-w-0", () => {
    const el = SourceChips({ slug: "sabah" }) as MinimalNode;
    expect(el.props?.className ?? "").toContain("flex-wrap");
    expect(el.props?.className ?? "").toContain("min-w-0");
  });

  it("the ownership chip wraps on mobile and stays nowrap from sm: up", () => {
    const el = SourceChips({ slug: "sabah" });
    const [ownershipChip] = findAll(
      el,
      (n) =>
        typeof n.props?.title === "string" &&
        n.props.title.startsWith("Sahiplik:"),
    );
    expect(ownershipChip).toBeDefined();
    const chipClass = ownershipChip?.props?.className ?? "";
    expect(chipClass).toContain("whitespace-normal");
    expect(chipClass).toContain("sm:whitespace-nowrap");
    // twMerge must have removed the base 'whitespace-nowrap' utility.
    expect(chipClass).not.toMatch(/(?<!sm:)whitespace-nowrap/);
  });

  it("the ownership label does not use bare truncate", () => {
    const el = SourceChips({ slug: "sabah" });
    const [ownershipChip] = findAll(
      el,
      (n) =>
        typeof n.props?.title === "string" &&
        n.props.title.startsWith("Sahiplik:"),
    );
    const labels = findAll(
      ownershipChip?.props?.children,
      (n) => typeof n.props?.className === "string",
    );
    const labelClass = String(labels[0]?.props?.className ?? "");
    expect(labelClass).not.toMatch(/(?<!sm:)\btruncate\b/);
    expect(labelClass).toContain("sm:truncate");
  });

  it("the ownership chip still carries its Sahiplik title", () => {
    const el = SourceChips({ slug: "sabah" });
    const [ownershipChip] = findAll(
      el,
      (n) =>
        typeof n.props?.title === "string" &&
        n.props.title.startsWith("Sahiplik:"),
    );
    expect(ownershipChip).toBeDefined();
  });

  it("the factuality chip is unchanged", () => {
    const el = SourceChips({ slug: "sabah" });
    const [factChip] = findAll(
      el,
      (n) => n.props?.title === "Karışık doğruluk",
    );
    expect(factChip).toBeDefined();
    expect(String(factChip?.props?.className)).not.toContain("whitespace-normal");
  });
});

describe("ownershipLabel", () => {
  it("disambiguates the independent-owner value from the Bağımsız zone", () => {
    expect(ownershipLabel("Bağımsız")).toBe("Bağımsız sahiplik");
    expect(ownershipLabel("Bağımsız (hükümete yakın)")).toBe("Bağımsız sahiplik (hükümete yakın)");
    expect(ownershipLabel("Demirören Medya")).toBe("Demirören Medya");
  });
});
