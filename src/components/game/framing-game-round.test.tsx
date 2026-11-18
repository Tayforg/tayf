import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FRAMING_VOTE_LABELS_TR } from "@/lib/game/framing";

// ---------------------------------------------------------------------------
// h201-game-2: a vote POST has no deadline of its own. When the 60 s clock ends
// the round while the last vote is still in flight and the player taps
// "Yeniden Oyna" at once, the old response used to land in the NEW round's
// entries (recordEntry was unconditional), so the new summary counted a vote cast
// in the previous round.
//
// The repo has neither jsdom nor @testing-library, so the real component runs on
// a small hook runtime (same idea as the copy-flow suite in daily-game.test.tsx):
// while a test has one mounted it replaces the hooks FramingGame uses; with none
// mounted every hook is React's own. Separate file because it mocks `react`
// (framing-game.test.tsx scripts useState with a different mock).
// ---------------------------------------------------------------------------

const rt = vi.hoisted(() => {
  interface Slot {
    value?: unknown;
    current?: unknown;
    deps?: readonly unknown[];
    cleanup?: unknown;
  }

  const sameDeps = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((d, i) => Object.is(d, b[i]));

  class Runtime {
    /** Every committed output, one entry per render pass. */
    readonly outputs: unknown[] = [];
    private readonly slots: Slot[] = [];
    private cursor = 0;
    private pending: Array<() => void> = [];
    private dirty = false;
    private flushing = false;

    constructor(private readonly component: () => unknown) {}

    render(): void {
      this.flushing = true;
      try {
        do {
          this.dirty = false;
          this.cursor = 0;
          this.pending = [];
          const outer = state.current;
          state.current = this;
          try {
            this.outputs.push(this.component());
          } finally {
            state.current = outer;
          }
          for (const effect of this.pending) effect();
        } while (this.dirty);
      } finally {
        this.flushing = false;
      }
    }

    unmount(): void {
      for (const slot of this.slots) {
        if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
        slot.cleanup = undefined;
      }
    }

    private slot(init: () => Slot): Slot {
      const slot = (this.slots[this.cursor] ??= init());
      this.cursor++;
      return slot;
    }

    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const slot = this.slot(() => ({
        value: typeof initial === "function" ? (initial as () => unknown)() : initial,
      }));
      const set = (next: unknown) => {
        const value = typeof next === "function" ? (next as (prev: unknown) => unknown)(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        if (this.flushing) this.dirty = true;
        else this.render();
      };
      return [slot.value, set];
    }

    useRef(initial: unknown): { current: unknown } {
      return this.slot(() => ({ current: initial })) as { current: unknown };
    }

    useCallback(fn: unknown, deps: readonly unknown[]): unknown {
      const slot = this.slot(() => ({ value: fn, deps }));
      if (!sameDeps(slot.deps, deps)) {
        slot.value = fn;
        slot.deps = deps;
      }
      return slot.value;
    }

    useEffect(effect: () => unknown, deps?: readonly unknown[]): void {
      const first = this.slots[this.cursor] === undefined;
      const slot = this.slot(() => ({}));
      if (!first && deps !== undefined && sameDeps(slot.deps, deps)) return;
      slot.deps = deps;
      this.pending.push(() => {
        if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
        slot.cleanup = effect();
      });
    }
  }

  const state: { current: Runtime | null } = { current: null };
  return { state, Runtime };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const live = () => rt.state.current;
  return {
    ...actual,
    default: actual,
    useState: (initial: unknown) => (live() ? live()!.useState(initial) : actual.useState(initial as never)),
    useRef: (initial: unknown) => (live() ? live()!.useRef(initial) : actual.useRef(initial as never)),
    useCallback: (fn: unknown, deps: readonly unknown[]) =>
      live() ? live()!.useCallback(fn, deps) : actual.useCallback(fn as never, deps as never),
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) =>
      live() ? live()!.useEffect(effect, deps) : actual.useEffect(effect as never, deps as never),
    useId: () => (live() ? "id" : actual.useId()),
  };
});

import { FramingGame } from "./framing-game";

type El = { type?: unknown; props?: Record<string, unknown> };

function walk(node: unknown, visit: (el: El) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
  } else if (node && typeof node === "object") {
    const el = node as El;
    if (el.type !== undefined) visit(el);
    walk(el.props?.children, visit);
  }
}

function find(node: unknown, pred: (el: El) => boolean): El | undefined {
  let hit: El | undefined;
  walk(node, (el) => {
    if (hit === undefined && pred(el)) hit = el;
  });
  return hit;
}

const text = (node: unknown): string =>
  Array.isArray(node)
    ? node.map(text).join("")
    : typeof node === "string" || typeof node === "number"
      ? String(node)
      : node && typeof node === "object"
        ? text((node as El).props?.children)
        : "";

/** The slice of a fetch Response the component reads (status, headers, ok, json). */
const answer = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

const TOTALS = { ok: true, totals: { n: 5, iktidar: 3, muhalefet: 1, none: 1 } };

/**
 * A network where every headline draw answers at once with a new headline and
 * every vote POST stays pending until the test settles it. Any other URL throws,
 * so nothing here can reach a live endpoint.
 */
function stubNetwork() {
  const votes: Array<{ ok: () => void; fail: () => void }> = [];
  let draws = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/oyun/cerceve/next") {
        draws += 1;
        return Promise.resolve(
          answer({ article_id: `00000000-0000-4000-8000-${String(draws).padStart(12, "0")}`, title: `Başlık ${draws}` }),
        );
      }
      if (url === "/api/oyun/cerceve") {
        return new Promise((resolve, reject) => {
          votes.push({ ok: () => resolve(answer(TOTALS)), fail: () => reject(new TypeError("network")) });
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  vi.stubGlobal("window", {
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  });
  vi.stubGlobal("document", { activeElement: null, body: {} });
  return { votes };
}

function mount() {
  const app = new rt.Runtime(() => FramingGame());
  app.render();
  const tree = () => app.outputs[app.outputs.length - 1];
  return {
    screen: () => text(tree()),
    async press(label: string) {
      const button = find(tree(), (el) => el.type === "button" && text(el) === label);
      expect(button, `a "${label}" button`).toBeDefined();
      (button!.props!.onClick as () => void)();
      await vi.advanceTimersByTimeAsync(0);
    },
    /** Lets the 60 s round clock run out (the countdown ticks every second). */
    async endRoundByClock() {
      await vi.advanceTimersByTimeAsync(61_000);
    },
    /** "N" of the finished screen's "bu turda N başlık oyladın". */
    votedInSummary(): number {
      const m = /bu turda (\d+) başlık oyladın/.exec(text(tree()));
      expect(m, "a round summary on screen").not.toBeNull();
      return Number(m![1]);
    },
  };
}

const VOTE = FRAMING_VOTE_LABELS_TR.iktidar;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("FramingGame — a vote answered after the round changed [h201-game-2]", () => {
  it.each([
    ["resolves", "ok"],
    ["fails", "fail"],
  ] as const)(
    "a previous round's vote POST that %s during the next round is not counted in the next round's summary",
    async (_label, how) => {
      const { votes } = stubNetwork();
      const game = mount();

      // Round 1: one vote whose POST stays pending while the clock runs out.
      await game.press("Başla");
      await game.press(VOTE);
      expect(votes).toHaveLength(1);
      await game.endRoundByClock();
      expect(game.votedInSummary()).toBe(0);

      // Round 2 starts at once; the round-1 POST finally answers while it plays.
      await game.press("Yeniden Oyna");
      votes[0]![how]();
      await vi.advanceTimersByTimeAsync(0);

      // The player casts exactly one vote of their own in round 2.
      await game.press(VOTE);
      expect(votes).toHaveLength(2);
      votes[1]!.ok();
      await vi.advanceTimersByTimeAsync(0);
      await game.endRoundByClock();

      expect(game.votedInSummary()).toBe(1);
    },
  );

  it("a late answer that lands after its own round ended, before any restart, still counts for that round", async () => {
    const { votes } = stubNetwork();
    const game = mount();

    await game.press("Başla");
    await game.press(VOTE);
    await game.endRoundByClock();
    expect(game.votedInSummary()).toBe(0);

    votes[0]!.ok();
    await vi.advanceTimersByTimeAsync(0);

    expect(game.votedInSummary()).toBe(1);
  });

  it("votes answered within their own round are all counted (no over-reach of the guard)", async () => {
    const { votes } = stubNetwork();
    const game = mount();

    await game.press("Başla");
    await game.press(VOTE);
    votes[0]!.ok();
    await vi.advanceTimersByTimeAsync(0);
    await game.press("Sonraki");
    await game.press(VOTE);
    votes[1]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    await game.endRoundByClock();

    expect(game.votedInSummary()).toBe(2);
  });
});
