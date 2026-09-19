import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ReactNode } from "react";

import { DataNote } from "./data-note";

// ---------------------------------------------------------------------------
// Pack E / worker E2: DataNote is the shared "Fiyat verisi ... yatırım
// tavsiyesi değildir." footnote required on both /ekonomi and
// /ekonomi/[ticker]. The exact sentence is load-bearing (deck M-09 follow-up
// / SEC risk register), so it is asserted verbatim rather than via a loose
// `toContain`. Rendering the full pages with live finance fakes to prove the
// import is impractical here (they pull in quotes/Supabase plumbing well
// beyond this component's concern), so per the worker brief this file also
// does a lightweight source-grep to prove both page files import and render
// `<DataNote />`.
// ---------------------------------------------------------------------------

const EXACT_SENTENCE =
  "Fiyat verisi Yahoo Finance'ten alınır ve gecikmeli olabilir; KAP bildirimleri kap.org.tr'den. Bu sayfa yatırım tavsiyesi değildir.";

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

const HERE = dirname(fileURLToPath(import.meta.url));
const EKONOMI_PAGE = resolve(HERE, "../../app/ekonomi/page.tsx");
const TICKER_PAGE = resolve(HERE, "../../app/ekonomi/[ticker]/page.tsx");

describe("DataNote", () => {
  it("renders the exact required sentence, verbatim", () => {
    const tree = DataNote();
    const text = collectText(tree).join("");
    expect(text).toBe(EXACT_SENTENCE);
  });
});

describe("DataNote — required on both Ekonomi pages", () => {
  it("/ekonomi imports and renders <DataNote />", () => {
    const src = readFileSync(EKONOMI_PAGE, "utf8");
    expect(src).toMatch(/import\s*\{[^}]*\bDataNote\b[^}]*\}\s*from\s*["']@\/components\/finance\/data-note["']/);
    expect(src).toMatch(/<DataNote\s*\/>/);
  });

  it("/ekonomi/[ticker] imports and renders <DataNote />", () => {
    const src = readFileSync(TICKER_PAGE, "utf8");
    expect(src).toMatch(/import\s*\{[^}]*\bDataNote\b[^}]*\}\s*from\s*["']@\/components\/finance\/data-note["']/);
    expect(src).toMatch(/<DataNote\s*\/>/);
  });
});
