import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useHydrated } from "./use-hydrated";

// Separate from the component tests because it wraps `react`'s
// useSyncExternalStore to record the three functions the hook hands it. The
// repo has no jsdom / RTL, so the client snapshot (true) cannot be observed by
// rendering; the recorded arguments are the contract instead, and a real
// server render (which always reads the server snapshot) covers the other half.
type Subscribe = (onChange: () => void) => () => void;
interface Call {
  subscribe: Subscribe;
  getSnapshot: () => boolean;
  getServerSnapshot: () => boolean;
}
const calls = vi.hoisted(() => [] as Call[]);

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: (
      subscribe: Subscribe,
      getSnapshot: () => boolean,
      getServerSnapshot: () => boolean,
    ) => {
      calls.push({ subscribe, getSnapshot, getServerSnapshot });
      return actual.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    },
  };
});

function Probe() {
  return createElement("b", null, String(useHydrated()));
}

beforeEach(() => {
  calls.length = 0;
});

describe("useHydrated", () => {
  it("is false in server-rendered markup (and so during hydration)", () => {
    expect(typeof window).toBe("undefined");
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<b>false</b>");
  });

  it("hands useSyncExternalStore a true client snapshot and a false server snapshot", () => {
    renderToStaticMarkup(createElement(Probe));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.getSnapshot()).toBe(true);
    expect(calls[0]!.getServerSnapshot()).toBe(false);
  });

  it("never subscribes to anything: the unsubscribe is a function and onChange is not called", () => {
    renderToStaticMarkup(createElement(Probe));
    const onChange = vi.fn();
    const unsubscribe = calls[0]!.subscribe(onChange);
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("passes the same subscribe function on every render (a new one would resubscribe each time)", () => {
    renderToStaticMarkup(createElement(Probe));
    renderToStaticMarkup(createElement(Probe));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.subscribe).toBe(calls[0]!.subscribe);
    expect(calls[1]!.getSnapshot).toBe(calls[0]!.getSnapshot);
  });
});

describe("useHydrated adoption (source guard)", () => {
  const root = join(__dirname, "..", "..", "..");
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");

  it("is a client module that exports the hook", () => {
    const src = read("src/lib/hooks/use-hydrated.ts");
    expect(src.startsWith('"use client";')).toBe(true);
    expect(src).toMatch(/export function useHydrated\(\): boolean/);
  });

  it.each(["src/components/follow/follow-feed.tsx", "src/components/bookmark/saved-list.tsx"])(
    "%s imports the shared hook instead of defining its own",
    (rel) => {
      const src = read(rel);
      expect(src).toMatch(
        /import\s*\{\s*useHydrated\s*\}\s*from\s*["']@\/lib\/hooks\/use-hydrated["']/,
      );
      expect(src).not.toMatch(/function useHydrated/);
      expect(src).not.toContain("subscribeNever");
      expect(src).not.toContain("useSyncExternalStore");
      expect(src).toContain("useHydrated()");
    },
  );
});
