import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { RetryButton } from "./retry-button";

describe("RetryButton", () => {
  it("renders a type=button with the default Turkish label", () => {
    const markup = renderToStaticMarkup(<RetryButton />);
    expect(markup).toContain('type="button"');
    expect(markup).toContain("Tekrar dene");
  });

  it("renders a custom label when provided", () => {
    const markup = renderToStaticMarkup(<RetryButton label="Yeniden yükle" />);
    expect(markup).toContain("Yeniden yükle");
  });
});

describe("RetryButton — source guard", () => {
  it("is a client component that calls router.refresh()", () => {
    const source = readFileSync(
      resolve(__dirname, "retry-button.tsx"),
      "utf8",
    );
    expect(source.trimStart().startsWith('"use client"')).toBe(true);
    expect(source).toMatch(/router\.refresh\(\)/);
  });
});
