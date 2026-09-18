import { describe, it, expect } from "vitest";
import type { ReactNode } from "react";

import { DenominatorNote } from "./denominator-note";

// ---------------------------------------------------------------------------
// A-M4: no test file existed for DenominatorNote before, despite it backing
// every "N/M kaynak" share footnote on /sources and /blindspots. Covers the
// numbers / no-numbers / total===0 (A-M1) / link-href branches.
// ---------------------------------------------------------------------------

/** Collects every string/number leaf under a React element tree. */
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

/** Collects every `href` prop found anywhere in a React element tree. */
function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { href?: unknown; children?: ReactNode } };
    if (typeof el.props?.href === "string") out.push(el.props.href);
    if (el.props?.children !== undefined) collectHrefs(el.props.children, out);
  }
  return out;
}

describe("DenominatorNote", () => {
  it("renders the N/M figures and names the voting population when both numbers are known", () => {
    const tree = DenominatorNote({ delivering: 59, total: 96 });
    const text = collectText(tree).join("");
    expect(text).toContain("59");
    expect(text).toContain("96");
    expect(text).toContain("yanlılık dağılımına sayılan");
    expect(text).toContain("son 72 saatte");
  });

  it("always links to /kaynaklar/durum, with numbers known", () => {
    const tree = DenominatorNote({ delivering: 59, total: 96 });
    expect(collectHrefs(tree)).toContain("/kaynaklar/durum");
  });

  it("always links to /kaynaklar/durum, with numbers unknown", () => {
    const tree = DenominatorNote({ delivering: null, total: null });
    expect(collectHrefs(tree)).toContain("/kaynaklar/durum");
  });

  it("degrades to wording-without-numbers when delivering is null", () => {
    const tree = DenominatorNote({ delivering: null, total: 96 });
    const text = collectText(tree).join("");
    expect(text).not.toContain("96");
    expect(text).toContain("yanlılık dağılımına sayılan");
  });

  it("degrades to wording-without-numbers when total is null", () => {
    const tree = DenominatorNote({ delivering: 59, total: null });
    const text = collectText(tree).join("");
    expect(text).not.toContain("59");
  });

  it("A-M1: degrades to wording-without-numbers when total is 0, rather than publishing '0/0 kaynak' as authoritative", () => {
    const tree = DenominatorNote({ delivering: 0, total: 0 });
    const text = collectText(tree).join("");
    expect(text).not.toContain("0/0");
    expect(text).toContain("yanlılık dağılımına sayılan");
  });
});
