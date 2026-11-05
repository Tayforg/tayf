import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";

// ---------------------------------------------------------------------------
// h41-resilience-1 (merged a11y-2): the in-page "Tekrar dene" must not drop
// keyboard focus while the refresh is pending (a `disabled` button loses
// focus; `aria-disabled` keeps it) and must announce pending/failed state in
// an always-mounted polite live region. The repo has no jsdom, so the pending
// state is driven by mocking `useTransition`, and the click handler is read
// off the element tree the component returns.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  pending: false,
  startTransition: vi.fn((cb: () => void) => cb()),
  refresh: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useTransition: () => [h.pending, h.startTransition] as const,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));

import { RetryButton, retryStatusText, nextRetryPhase } from "./retry-button";

beforeEach(() => {
  h.pending = false;
  h.startTransition.mockClear();
  h.refresh.mockClear();
});

const STATUS_SPAN = /<span role="status" aria-live="polite" class="sr-only">([^<]*)<\/span>/;

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

  it("idle: no disabled attribute, aria-disabled=false, empty polite live region", () => {
    const markup = renderToStaticMarkup(<RetryButton />);
    expect(markup).not.toContain(" disabled=");
    expect(markup).not.toMatch(/\sdisabled(\s|>|=)/);
    expect(markup).toContain('aria-disabled="false"');
    const status = STATUS_SPAN.exec(markup);
    expect(status).not.toBeNull();
    expect(status?.[1]).toBe("");
  });

  it("pending: stays focusable (aria-disabled=true, no disabled), swaps the label and announces it", () => {
    h.pending = true;
    const markup = renderToStaticMarkup(<RetryButton />);
    expect(markup).not.toMatch(/\sdisabled(\s|>|=)/);
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("Yükleniyor…");
    expect(markup).not.toContain(">Tekrar dene<");
    expect(STATUS_SPAN.exec(markup)?.[1]).toBe("Yeniden yükleniyor…");
  });

  it("pending: a custom label is also replaced by the pending label", () => {
    h.pending = true;
    const markup = renderToStaticMarkup(<RetryButton label="Yeniden yükle" />);
    expect(markup).not.toContain("Yeniden yükle<");
    expect(markup).toContain("Yükleniyor…");
  });

  it("keeps the button as the last child so a Tailwind 4 space-y-* parent adds no margin under it", () => {
    // Tailwind 4 emits `:where(.space-y-6 > :not(:last-child)) { margin-block-end }`.
    // The status span is position:absolute (sr-only) and takes no space, but if
    // it came after the button it would make the button a non-last child and the
    // parent's spacing margin would land under the button.
    const markup = renderToStaticMarkup(<RetryButton />);
    expect(markup.endsWith("</button>")).toBe(true);
    const statusAt = markup.indexOf('<span role="status"');
    expect(statusAt).toBeGreaterThanOrEqual(0);
    expect(statusAt).toBeLessThan(markup.indexOf("<button"));
  });

  it("className replaces the default classes but keeps aria-disabled:opacity-60 available to the caller", () => {
    const markup = renderToStaticMarkup(
      <RetryButton className="custom-a custom-b aria-disabled:opacity-60" />,
    );
    expect(markup).toContain('class="custom-a custom-b aria-disabled:opacity-60"');
    expect(markup).not.toContain("min-h-[44px]");
  });

  it("without className the default classes (including aria-disabled:opacity-60) are used", () => {
    const markup = renderToStaticMarkup(<RetryButton />);
    expect(markup).toContain("min-h-[44px]");
    expect(markup).toContain("aria-disabled:opacity-60");
  });
});

describe("retryStatusText", () => {
  it.each([
    ["idle", ""],
    ["pending", "Yeniden yükleniyor…"],
    ["failed", "Hâlâ yüklenemedi. Biraz sonra yeniden deneyin."],
  ] as const)("%s -> %j", (phase, expected) => {
    expect(retryStatusText(phase)).toBe(expected);
  });
});

describe("nextRetryPhase", () => {
  it("goes pending as soon as the transition starts, from any phase", () => {
    expect(nextRetryPhase("idle", true)).toBe("pending");
    expect(nextRetryPhase("failed", true)).toBe("pending");
    expect(nextRetryPhase("pending", true)).toBe("pending");
  });

  it("pending -> not pending while still mounted means the refresh did not recover: failed", () => {
    expect(nextRetryPhase("pending", false)).toBe("failed");
  });

  it("stays idle before any click and stays failed until the next click", () => {
    expect(nextRetryPhase("idle", false)).toBe("idle");
    expect(nextRetryPhase("failed", false)).toBe("failed");
  });
});

// Calls the component inside a throwaway render so its hooks have a
// dispatcher, then walks the returned element tree (no DOM needed).
function captureTree(props: { onRetry?: () => void } = {}): ReactNode {
  let captured: ReactNode = null;
  function Probe() {
    captured = RetryButton(props) as ReactNode;
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return captured;
}

function findButton(node: ReactNode): ReactElement<{ onClick?: () => void }> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findButton(n);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<{ onClick?: () => void; children?: ReactNode }>;
  if (el.type === "button") return el;
  return findButton(el.props.children);
}

describe("RetryButton — click handler", () => {
  it("idle: click refreshes the route inside a transition", () => {
    const button = findButton(captureTree());
    expect(button).not.toBeNull();
    button?.props.onClick?.();
    expect(h.startTransition).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("pending: a click (aria-disabled does not block clicks) is ignored", () => {
    h.pending = true;
    const button = findButton(captureTree());
    expect(button).not.toBeNull();
    button?.props.onClick?.();
    expect(h.startTransition).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("with onRetry: click calls onRetry once inside the transition and never router.refresh()", () => {
    const onRetry = vi.fn();
    // Record what onRetry sees, to prove it runs inside startTransition.
    let insideTransition = false;
    h.startTransition.mockImplementationOnce((cb: () => void) => {
      insideTransition = true;
      try {
        cb();
      } finally {
        insideTransition = false;
      }
    });
    let calledInside = false;
    onRetry.mockImplementation(() => {
      calledInside = insideTransition;
    });

    const button = findButton(captureTree({ onRetry }));
    expect(button).not.toBeNull();
    button?.props.onClick?.();

    expect(h.startTransition).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(calledInside).toBe(true);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("with onRetry and pending: a click calls neither onRetry nor router.refresh()", () => {
    h.pending = true;
    const onRetry = vi.fn();
    const button = findButton(captureTree({ onRetry }));
    expect(button).not.toBeNull();
    button?.props.onClick?.();
    expect(h.startTransition).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });
});

describe("RetryButton — source guard", () => {
  const source = readFileSync(resolve(__dirname, "retry-button.tsx"), "utf8");

  it("is a client component that calls router.refresh()", () => {
    expect(source.trimStart().startsWith('"use client"')).toBe(true);
    expect(source).toMatch(/router\.refresh\(\)/);
  });

  it("uses aria-disabled instead of the disabled attribute (keeps keyboard focus)", () => {
    // A bare `disabled=` JSX attribute (not the `-disabled=` of aria-disabled).
    expect(source).not.toMatch(/(?<![-\w])disabled=\{/);
    expect(source).toContain("aria-disabled={isPending}");
    expect(source).toContain("aria-disabled:opacity-60");
    expect(source).not.toMatch(/(^|[\s"'`])disabled:opacity-60/);
  });

  it("returns early from onClick while pending", () => {
    expect(source).toMatch(/if \(isPending\) return;/);
  });

  it("never moves focus programmatically", () => {
    expect(source).not.toMatch(/\.focus\(/);
    expect(source).not.toMatch(/autoFocus/);
  });
});
