import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createCpuClock, expectCpuUnder, expectLinear, rep } from "./linear-time";

// ---------------------------------------------------------------------------
// Unit tests for the CPU-time linear-ladder helper. Most cases drive it with
// an injected fake clock: fn advances a scripted time by a cost function of
// the input length, so the verdict never depends on the machine. Two smoke
// cases at the end use the real process.cpuUsage clock with a deliberately
// quadratic loop (must fail) and a linear loop (must pass), and the CPU-clock
// cases check that only the calling thread's CPU time is read.
// ---------------------------------------------------------------------------

/** A fake clock plus a `fn` that advances it by cost(input.length) ms per call. */
function scripted(cost: (len: number, call: number) => number) {
  let now = 0;
  const callsBySize = new Map<number, number>();
  const sizesSeen: number[] = [];
  return {
    clock: () => now,
    fn: (input: string) => {
      const call = (callsBySize.get(input.length) ?? 0) + 1;
      callsBySize.set(input.length, call);
      sizesSeen.push(input.length);
      now += cost(input.length, call);
    },
    sizesSeen,
    calls: () => sizesSeen.length,
  };
}

const SIZES = [10_000, 20_000, 40_000, 80_000];
const gen = rep("a");

describe("rep", () => {
  it("builds exactly n characters of the repeated unit", () => {
    expect(rep("ab")(5)).toBe("ababa");
    expect(rep("ab")(4)).toBe("abab");
    expect(rep("xyz")(1)).toBe("x");
    expect(rep("a")(0)).toBe("");
  });

  it("adds the prefix and suffix on top of the n characters", () => {
    expect(rep(" ", "kore", "işçi parti")(3)).toBe("kore   işçi parti");
    expect(rep(" ", "x\n", "y")(2)).toBe("x\n  y");
    expect(rep("a", "", "spor")(3)).toBe("aaaspor");
    expect(rep("ab", "[")(3)).toBe("[aba");
  });

  it("scales to large sizes without losing the length", () => {
    const s = rep("Kış lastiği ")(250_000);
    expect(s).toHaveLength(250_000);
    expect(s.startsWith("Kış lastiği Kış")).toBe(true);
  });

  it("refuses an empty unit instead of looping or throwing a RangeError", () => {
    expect(() => rep("")(10)).toThrow(/unit/);
  });
});

describe("expectLinear with a scripted clock", () => {
  it("passes a linear ladder and reports the per-rung minimum", () => {
    const s = scripted((len) => len / 100);
    const report = expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: s.clock });
    expect(report.sizes).toEqual(SIZES);
    expect(report.minMs).toEqual([100, 200, 400, 800]);
  });

  it("defaults the ladder to n/8, n/4, n/2, n", () => {
    const s = scripted((len) => len / 100);
    const report = expectLinear(gen, s.fn, { n: 80_000, ceilingMs: 5_000, clock: s.clock });
    expect(report.sizes).toEqual([10_000, 20_000, 40_000, 80_000]);
  });

  it("throws /super-linear/ when the cost grows x4 per doubling, naming the ladder", () => {
    const s = scripted((len) => 10 * (len / 10_000) ** 2);
    expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: s.clock })).toThrow(/super-linear/);
    let message = "";
    try {
      expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: s.clock });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("10000 -> 20000");
    expect(message).toContain("10000: 10.0 ms");
    expect(message).toContain("20000: 40.0 ms");
  });

  it("tolerates growth inside the slack and rejects it just outside", () => {
    // 1.4x per doubling extra: 2 x 1.4 = 2.8 per rung, under the 3.0 limit (slack 1.5).
    const inside = scripted((len) => 100 * 1.4 ** Math.log2(len / 10_000) * (len / 10_000));
    expect(() => expectLinear(gen, inside.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: inside.clock })).not.toThrow();
    // 1.6x extra: 3.2 per rung, over the limit.
    const outside = scripted((len) => 100 * 1.6 ** Math.log2(len / 10_000) * (len / 10_000));
    expect(() => expectLinear(gen, outside.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: outside.clock })).toThrow(/super-linear/);
    // The same 2.8x growth fails once the caller tightens slack to 1.2 (limit 2.4).
    expect(() => expectLinear(gen, inside.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, slack: 1.2, clock: inside.clock })).toThrow(/super-linear/);
  });

  it("throws /ceiling/ when a rung is over the absolute ceiling, and stops before the bigger rungs run", () => {
    const s = scripted((len) => len / 20); // 10k -> 500 ms
    expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 100, clock: s.clock })).toThrow(/ceiling/);
    // warm-up + the first timed rung only: nothing larger than the smallest size ran
    expect(Math.max(...s.sizesSeen)).toBe(10_000);
    expect(s.calls()).toBe(2);
  });

  it("fails fast on a middle rung before the largest one runs", () => {
    const s = scripted((len) => (len >= 40_000 ? 900 : 1));
    expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 500, clock: s.clock })).toThrow(/size 40000 took 900\.0 ms.*ceiling/);
    expect(s.sizesSeen).not.toContain(80_000);
  });

  it("does not trip the ceiling when the slowest rung sits exactly on it", () => {
    const s = scripted((len) => len / 100); // 80k -> 800 ms
    expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 800, clock: s.clock })).not.toThrow();
  });

  it("does not flag growth between rungs that all stay under floorMs (timer noise)", () => {
    // Quadratic, but the whole ladder costs 0.01 .. 0.64 ms: under the 2 ms floor.
    const tiny = scripted((len) => 0.01 * (len / 1_000) ** 2);
    const sizes = [1_000, 2_000, 4_000, 8_000];
    expect(() => expectLinear(gen, tiny.fn, { n: 8_000, sizes, ceilingMs: 5_000, clock: tiny.clock })).not.toThrow();
    // Lowering the floor makes the same ladder fail: the noise level was the floor, nothing else.
    expect(() => expectLinear(gen, tiny.fn, { n: 8_000, sizes, ceilingMs: 5_000, floorMs: 0.001, clock: tiny.clock })).toThrow(/super-linear/);
  });

  it("flags a pair as soon as the growth out of a rung at the floor is real", () => {
    // The pair rule alone (extendTop: false): these ladders define no rung past the top.
    // Rungs cost 0.5, 1.5 (both under 2 ms) then 3, 12: the 3 -> 12 step is x4.
    const costs: Record<number, number> = { 10_000: 0.5, 20_000: 1.5, 40_000: 3, 80_000: 12 };
    const s = scripted((len) => costs[len]!);
    expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, extendTop: false, clock: s.clock })).toThrow(/super-linear: 40000 -> 80000/);
  });

  it("flags a pair only when its cost beyond the linear allowance is more than timer noise (floorMs)", () => {
    // The pair rule alone (extendTop: false): these ladders define no rung past the top.
    // 2.0 ms -> 6.2 ms is 3.1x, over the 3.0x limit, but only 0.2 ms over the allowance: noise, not a regression.
    const costs: Record<number, number> = { 62_500: 2, 125_000: 6.2 };
    const noisy = scripted((len) => costs[len]!);
    expect(() => expectLinear(gen, noisy.fn, { n: 125_000, sizes: [62_500, 125_000], ceilingMs: 5_000, extendTop: false, clock: noisy.clock })).not.toThrow();
    // 20 ms -> 66 ms is the same 3.3x but 6 ms over the allowance: real.
    const real = scripted((len) => (len === 62_500 ? 20 : 66));
    expect(() => expectLinear(gen, real.fn, { n: 125_000, sizes: [62_500, 125_000], ceilingMs: 5_000, extendTop: false, clock: real.clock })).toThrow(/super-linear/);
    // A caller can tighten the noise level with floorMs: at 0.1 the 0.2 ms excess counts again.
    const tight = scripted((len) => costs[len]!);
    expect(() =>
      expectLinear(gen, tight.fn, { n: 125_000, sizes: [62_500, 125_000], ceilingMs: 5_000, floorMs: 0.1, extendTop: false, clock: tight.clock }),
    ).toThrow(/super-linear/);
  });

  it("flags a cliff out of a sub-floor rung", () => {
    // 0.8 ms and 1.9 ms are both under the 2 ms floor, then one doubling costs 790x more. The floor is the
    // noise level used as the minimum denominator, not a switch that turns the check off.
    const costs: Record<number, number> = { 10_000: 0.8, 20_000: 1.9, 40_000: 1_500 };
    const s = scripted((len) => costs[len]!);
    const sizes = [10_000, 20_000, 40_000];
    expect(() => expectLinear(gen, s.fn, { n: 40_000, sizes, ceilingMs: 2_000, clock: s.clock })).toThrow(/super-linear: 20000 -> 40000/);
  });

  it("measures the growth out of a sub-floor rung against the floor, not against the rung", () => {
    // The pair rule alone (extendTop: false): these ladders define no rung past the top.
    // 0.2 ms -> 3 ms: x15 against the rung, but only 1.5x against the 2 ms floor: noise, not a regression.
    const costs: Record<number, number> = { 10_000: 0.2, 20_000: 3 };
    const s = scripted((len) => costs[len]!);
    expect(() => expectLinear(gen, s.fn, { n: 20_000, sizes: [10_000, 20_000], ceilingMs: 2_000, extendTop: false, clock: s.clock })).not.toThrow();
    // 0.2 ms -> 30 ms is 15x the floor and 24 ms over the allowance: real.
    const big = scripted((len) => (len === 10_000 ? 0.2 : 30));
    expect(() => expectLinear(gen, big.fn, { n: 20_000, sizes: [10_000, 20_000], ceilingMs: 2_000, extendTop: false, clock: big.clock })).toThrow(
      /super-linear: 10000 -> 20000 grew 15\.00x/,
    );
  });

  it("stops after one pass when every rung but the top is under the floor and nothing looks wrong", () => {
    const costs: Record<number, number> = { 10_000: 0.5, 20_000: 1, 40_000: 1.5, 80_000: 3 };
    const s = scripted((len) => costs[len]!);
    const report = expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, runs: 5, clock: s.clock });
    expect(s.calls()).toBe(1 + SIZES.length); // one warm-up, one timed call per rung
    expect(report.minMs).toEqual([0.5, 1, 1.5, 3]);
    // A ladder of one rung needs no further samples either.
    const single = scripted(() => 5);
    expectLinear(gen, single.fn, { n: 1_000, sizes: [1_000], ceilingMs: 50, runs: 5, clock: single.clock });
    expect(single.calls()).toBe(2);
  });

  it("still takes every pass when a lower rung reaches the floor", () => {
    const costs: Record<number, number> = { 10_000: 1, 20_000: 2, 40_000: 3, 80_000: 5 };
    const s = scripted((len) => costs[len]!);
    expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, runs: 5, clock: s.clock });
    expect(s.calls()).toBe(1 + SIZES.length * 5);
  });

  it("still takes every pass, and confirms, when the top rung of a sub-floor ladder looks like a cliff", () => {
    // The pair rule alone (extendTop: false): these ladders define no rung past the top.
    // 0.5, 1, 1.5 ms then 12 ms: 12 / 2 = 6x over the floor, so the early return must not fire.
    const costs: Record<number, number> = { 10_000: 0.5, 20_000: 1, 40_000: 1.5, 80_000: 12 };
    const s = scripted((len) => costs[len]!);
    expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, runs: 5, extendTop: false, clock: s.clock })).toThrow(
      /super-linear: 40000 -> 80000/,
    );
    expect(s.calls()).toBeGreaterThan(1 + SIZES.length);
  });

  it("refuses a floorMs of 0 or less on a real clock (a 0 ms reading would divide by zero)", () => {
    expect(() => expectLinear((n) => n, () => undefined, { n: 4, sizes: [1, 2, 4], ceilingMs: 100, floorMs: 0 })).toThrow(/floorMs/);
    expect(() => expectLinear((n) => n, () => undefined, { n: 4, sizes: [1, 2, 4], ceilingMs: 100, floorMs: -1, clock: "wall" })).toThrow(/floorMs/);
  });

  it("takes the minimum of K runs, so one preempted sample cannot fail a linear function", () => {
    // The 40k rung is hit by a x6 stall on its first timed call only.
    const stall = (len: number, call: number) => (len / 100) * (len === 40_000 && call === 1 ? 6 : 1);
    const k5 = scripted(stall);
    expect(() => expectLinear(gen, k5.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, runs: 5, clock: k5.clock })).not.toThrow();
    // With a single run, no confirmation and a single attempt the stalled sample is the only one, and it reads as
    // super-linear (a second attempt would measure the 40k rung again, unstalled: see "measures a failing ladder once more").
    const k1 = scripted(stall);
    expect(() =>
      expectLinear(gen, k1.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, runs: 1, confirmRuns: 0, attempts: 1, clock: k1.clock }),
    ).toThrow(/super-linear/);
  });

  it("confirms a suspicious pair with extra samples: a stalled sample is forgiven, a real quadratic is not", () => {
    // 10 .. 80 ms ladder; the 40k rung is hit by a x6 stall on its first timed call only, and one run only is
    // asked for: the pair looks super-linear (20 ms -> 240 ms), the confirmation samples clear it.
    const stall = (len: number, call: number) => (len / 1_000) * (len === 40_000 && call === 1 ? 6 : 1);
    const stalled = scripted(stall);
    expect(() => expectLinear(gen, stalled.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, runs: 1, clock: stalled.clock })).not.toThrow();
    const unconfirmed = scripted(stall);
    expect(() =>
      expectLinear(gen, unconfirmed.fn, {
        n: 80_000,
        sizes: SIZES,
        ceilingMs: 5_000,
        runs: 1,
        confirmRuns: 0,
        attempts: 1, // the confirmation is what is under test here, not the second attempt
        clock: unconfirmed.clock,
      }),
    ).toThrow(/super-linear/);
    // A cost that is quadratic on EVERY sample stays quadratic after any number of extra samples.
    const quad = scripted((len) => (len / 10_000) ** 2);
    expect(() => expectLinear(gen, quad.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: quad.clock })).toThrow(/super-linear/);
    const quadPlain = scripted((len) => (len / 10_000) ** 2);
    expect(() =>
      expectLinear(gen, quadPlain.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, confirmRuns: 0, clock: quadPlain.clock }),
    ).toThrow(/super-linear/);
    // The confirmation really took more samples than the plain ladder does.
    expect(quad.calls()).toBeGreaterThan(quadPlain.calls());
  });

  describe("one constant-factor step (a cache or memory-tier cliff) is excused only when the cost is linear after it", () => {
    // 2 -> 3 -> 8 -> 28 ms then linear: the CI ladder of PR #225 (classify-category, 100k -> 200k grew 3.49x).
    const cliff = (len: number) => (len <= 40_000 ? len / 5_000 : (len / 80_000) * 28);

    it("passes when the rung after the step grows linearly again", () => {
      const s = scripted(cliff);
      expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: s.clock })).not.toThrow();
      // The extension built and sampled a 160k rung (at least three times).
      expect(s.sizesSeen.filter((len) => len === 160_000).length).toBeGreaterThanOrEqual(3);
    });

    it("still fails a cost that keeps growing super-linearly past the top rung", () => {
      // Linear at the bottom, then a quadratic term that dominates from 80k on: the step is not one-off.
      const s = scripted((len) => len / 5_000 + (len > 40_000 ? (len / 40_000) ** 2 * 8 : 0));
      let message = "";
      try {
        expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: s.clock });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/super-linear/);
      expect(message).toContain("160000");
    });

    it("excuses one step below the top when the next pair is linear again (the CI ladder 2 -> 3 -> 11.9 -> 24 ms)", () => {
      const costs: Record<number, number> = { 10_000: 2, 20_000: 3, 40_000: 11.9, 80_000: 24 };
      const s = scripted((len) => costs[len]!);
      expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: s.clock })).not.toThrow();
      expect(s.sizesSeen).not.toContain(160_000); // the next pair already shows the cost is linear again
      const off = scripted((len) => costs[len]!);
      expect(() => expectLinear(gen, off.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, extendTop: false, clock: off.clock })).toThrow(
        /super-linear: 20000 -> 40000/,
      );
    });

    it("does not excuse two steps in one ladder", () => {
      const costs: Record<number, number> = { 10_000: 4, 20_000: 16, 40_000: 32, 80_000: 120 };
      const s = scripted((len) => costs[len]!);
      expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: s.clock })).toThrow(
        /super-linear: 10000 -> 20000/,
      );
    });

    it("does not excuse a step of more than twice the limit, even when the cost is linear after it", () => {
      const s = scripted((len) => (len <= 20_000 ? len / 5_000 : (len / 40_000) * 28));
      expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: s.clock })).toThrow(
        /super-linear: 20000 -> 40000/,
      );
    });

    it("keeps today's verdict with extendTop: false or confirmRuns: 0", () => {
      const a = scripted(cliff);
      expect(() => expectLinear(gen, a.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, extendTop: false, clock: a.clock })).toThrow(
        /super-linear/,
      );
      expect(a.sizesSeen).not.toContain(160_000);
      const b = scripted(cliff);
      expect(() => expectLinear(gen, b.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, confirmRuns: 0, clock: b.clock })).toThrow(
        /super-linear/,
      );
      expect(b.sizesSeen).not.toContain(160_000);
    });

    it("fails with the ceiling message when the extended rung is over the ceiling", () => {
      const s = scripted((len) => (len <= 40_000 ? len / 5_000 : len <= 80_000 ? 28 : 500));
      expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 400, clock: s.clock })).toThrow(/ceiling/);
    });

    it("does not extend a slow top rung (hundreds of ms is already steady)", () => {
      const s = scripted((len) => 300 * (len / 10_000) ** 2);
      expect(() => expectLinear(gen, s.fn, { n: 20_000, sizes: [10_000, 20_000], ceilingMs: 50_000, clock: s.clock })).toThrow(
        /super-linear/,
      );
      expect(s.sizesSeen).not.toContain(40_000);
    });
  });

  it("takes no confirmation samples on a pair that passes, nor on a pair of slow rungs", () => {
    const ok = scripted((len) => len / 100);
    expectLinear(gen, ok.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: ok.clock });
    expect(ok.calls()).toBe(1 + 4 * 2); // 100 .. 800 ms rungs: two samples each, nothing more
    // 300 ms -> 1200 ms is x4 but both rungs are slow: the plain two samples decide (one attempt: a second one
    // would repeat the same 2 x 2 samples).
    const slow = scripted((len) => 300 * (len / 10_000) ** 2);
    expect(() =>
      expectLinear(gen, slow.fn, { n: 20_000, sizes: [10_000, 20_000], ceilingMs: 5_000, attempts: 1, clock: slow.clock }),
    ).toThrow(/super-linear/);
    expect(slow.calls()).toBe(1 + 2 * 2);
  });

  it("warms up once, untimed, on the smallest rung", () => {
    // A first call that costs 1000 ms must not count: it is the warm-up.
    const s = scripted((len, call) => (len === 10_000 && call === 1 ? 1_000 : len / 100));
    const report = expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: s.clock });
    expect(report.minMs[0]).toBe(100);
  });

  it("samples fast rungs `runs` times and slow rungs (20 ms and up) twice", () => {
    const fast = scripted((len) => len / 10_000); // 1, 2, 4, 8 ms
    expectLinear(gen, fast.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, runs: 5, clock: fast.clock });
    expect(fast.calls()).toBe(1 + 4 * 5);
    const slow = scripted((len) => len / 100); // 100 .. 800 ms
    expectLinear(gen, slow.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, runs: 5, clock: slow.clock });
    expect(slow.calls()).toBe(1 + 4 * 2);
  });

  it("checks nothing but the ceiling on a single-rung ladder", () => {
    const s = scripted(() => 5);
    const report = expectLinear(gen, s.fn, { n: 1_000, sizes: [1_000], ceilingMs: 50, clock: s.clock });
    expect(report.minMs).toEqual([5]);
    expect(() => expectLinear(gen, s.fn, { n: 1_000, sizes: [1_000], ceilingMs: 4, clock: s.clock })).toThrow(/ceiling/);
  });

  it("builds every input once, outside the timed region", () => {
    const built: number[] = [];
    const s = scripted((len) => len / 100);
    expectLinear(
      (n) => {
        built.push(n);
        return gen(n);
      },
      s.fn,
      { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: s.clock },
    );
    expect(built).toEqual(SIZES);
  });

  it("passes the generated input to fn unchanged (non-string inputs too)", () => {
    const seen: number[] = [];
    let now = 0;
    expectLinear(
      (n) => Array.from({ length: n }, (_, i) => i),
      (input: number[]) => {
        seen.push(input.length);
        now += input.length / 100;
      },
      { n: 800, sizes: [200, 400, 800], ceilingMs: 5_000, floorMs: 0, clock: () => now },
    );
    expect([...new Set(seen)]).toEqual([200, 400, 800]);
  });

  it("rejects an empty, non-ascending or non-positive ladder before running anything", () => {
    const s = scripted(() => 1);
    expect(() => expectLinear(gen, s.fn, { n: 10, sizes: [], ceilingMs: 100, clock: s.clock })).toThrow(/sizes/);
    expect(() => expectLinear(gen, s.fn, { n: 10, sizes: [20, 10], ceilingMs: 100, clock: s.clock })).toThrow(/ascending/);
    expect(() => expectLinear(gen, s.fn, { n: 10, sizes: [10, 10], ceilingMs: 100, clock: s.clock })).toThrow(/ascending/);
    expect(() => expectLinear(gen, s.fn, { n: 10, sizes: [0, 10], ceilingMs: 100, clock: s.clock })).toThrow(/ascending/);
    expect(s.calls()).toBe(0);
  });

  it("propagates an error thrown by fn (a wrong answer is a failure, not a timing)", () => {
    const s = scripted(() => 1);
    expect(() =>
      expectLinear(
        gen,
        () => {
          throw new Error("not a category");
        },
        { n: 100, ceilingMs: 100, clock: s.clock },
      ),
    ).toThrow("not a category");
  });

  it("does not import vitest: it throws plain Errors", () => {
    const s = scripted((len) => 10 * (len / 10_000) ** 2);
    try {
      expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: s.clock });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).constructor).toBe(Error);
    }
  });
});

// ---------------------------------------------------------------------------
// h178-testhealth-2: one measuring pass has no second chance. On main (CI run 42596460729) a linear classify-category
// ladder read 4, 6, 14, 30 ms and then 93 ms on the 400k extension rung: 3.10x against a 3.00x limit, a cache tier
// hit on the one rung that decided the verdict. A real quadratic is slow on EVERY sample of EVERY attempt; a noisy
// rung is not. So a ladder that fails 'super-linear' is measured once more, from scratch, before the helper throws.
// The scripted clock hands cost(len, call) the per-size call number, which counts across attempts: a rung that is
// noisy for its first K calls is noisy for all of attempt 1 and clean in attempt 2.
// ---------------------------------------------------------------------------

describe("expectLinear measures a failing ladder once more before it throws (attempts)", () => {
  const TOP = 80_000;
  const OPTS = { n: TOP, sizes: SIZES, ceilingMs: 20_000 };
  const callsAt = (s: { sizesSeen: number[] }, size: number) => s.sizesSeen.filter((len) => len === size).length;
  const messageOf = (run: () => unknown): string => {
    try {
      run();
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };

  /** How many samples of `size` ONE failing attempt takes when they are all slow: the sample count the noise must cover. */
  function samplesPerFailingAttempt(cost: (len: number) => number, size: number): number {
    const probe = scripted(cost);
    expect(() => expectLinear(gen, probe.fn, { ...OPTS, attempts: 1, clock: probe.clock })).toThrow(/super-linear/);
    return callsAt(probe, size);
  }

  it("(a) a first attempt that is noisy on the top rung passes by default and still throws with attempts: 1", () => {
    // Linear: 10, 20, 40, 80 ms, the 160k extension size linear too. The top rung reads 10x for its first K calls.
    const linearCost = (len: number) => len / 1_000;
    const K = samplesPerFailingAttempt((len) => linearCost(len) * (len === TOP ? 10 : 1), TOP);
    expect(K).toBeGreaterThan(1);
    const noisy = (len: number, call: number) => linearCost(len) * (len === TOP && call <= K ? 10 : 1);

    const single = scripted(noisy);
    expect(() => expectLinear(gen, single.fn, { ...OPTS, attempts: 1, clock: single.clock })).toThrow(/super-linear/);

    const twice = scripted(noisy);
    const report = expectLinear(gen, twice.fn, { ...OPTS, clock: twice.clock });
    expect(twice.sizesSeen.filter((len) => len === TOP).length).toBeGreaterThan(K);
    // The report is the passing attempt's own: a fresh `min`, not the noisy readings of attempt 1.
    expect(report.minMs).toEqual([10, 20, 40, 80]);
  });

  it("(b) replays CI run 42596460729: a noisy extension rung read 3.10x, a second attempt is clean", () => {
    // classify-category read 25k 4, 50k 6, 100k 14, 200k 30 and, on the 400k extension rung, 93 ms. Scaled to the test
    // ladder 10k .. 80k with a 160k extension. The top rung reads 45 ms while the base ladder is confirmed (14 -> 45 is
    // 3.2x: one step, so the extension rung is timed) and 30 ms once the extension loop samples it again, as on CI:
    // 93 / 30 = 3.10x after a step of 2.14x.
    const fixed: Record<number, number> = { 10_000: 4, 20_000: 6, 40_000: 14, 160_000: 93 };
    const K = (() => {
      // Samples of the top rung up to the extension: the same sample count as a one-step ladder that cannot extend.
      const probe = scripted((len) => (len === TOP ? 45 : fixed[len]!));
      expect(() => expectLinear(gen, probe.fn, { ...OPTS, extendTop: false, attempts: 1, clock: probe.clock })).toThrow(
        /super-linear: 40000 -> 80000/,
      );
      return callsAt(probe, TOP);
    })();
    const ci = (len: number, call: number) => (len === TOP ? (call <= K ? 45 : 30) : fixed[len]!);

    const single = scripted(ci);
    expect(() => expectLinear(gen, single.fn, { ...OPTS, attempts: 1, clock: single.clock })).toThrow(
      /super-linear: 80000 -> 160000 grew 3\.10x after a 40000 -> 80000 step of 2\.14x/,
    );
    expect(callsAt(single, 160_000)).toBeGreaterThanOrEqual(3); // it really was the extension rung that decided

    const twice = scripted(ci);
    const report = expectLinear(gen, twice.fn, { ...OPTS, clock: twice.clock });
    expect(report.minMs).toEqual([4, 6, 14, 30]);
    expect(callsAt(twice, 160_000)).toBe(callsAt(single, 160_000)); // attempt 2 needed no extension rung
  });

  it("(c) a true quadratic still throws by default, after both attempts, and the message shows the first ladder", () => {
    const quadratic = (len: number) => (len / 1_000) ** 2; // 100, 400, 1600, 6400 ms
    const single = scripted(quadratic);
    expect(() => expectLinear(gen, single.fn, { ...OPTS, attempts: 1, clock: single.clock })).toThrow(/super-linear/);

    const twice = scripted(quadratic);
    const message = messageOf(() => expectLinear(gen, twice.fn, { ...OPTS, clock: twice.clock }));
    expect(message).toMatch(/^super-linear: /);
    expect(message).toContain("attempt 2 of 2");
    expect(message).toContain("[attempt 2 of 2; attempt 1: 10000: 100.0 ms, 20000: 400.0 ms, 40000: 1600.0 ms, 80000: 6400.0 ms]");
    // Both attempts took every sample (a quadratic is slow on all of them): the measuring body ran twice. The JIT
    // warm-up is the one call outside it and runs once, so the total is 2 x the single attempt's calls minus one.
    expect(twice.calls()).toBe(1 + 2 * (single.calls() - 1));
  });

  it("with attempts: 1 the message is the single attempt's own, with no attempt suffix", () => {
    const s = scripted((len) => (len / 1_000) ** 2);
    const message = messageOf(() => expectLinear(gen, s.fn, { ...OPTS, attempts: 1, clock: s.clock }));
    expect(message).toMatch(/^super-linear: /);
    expect(message).not.toContain("attempt");
  });

  it("(d) a ceiling breach is never retried: the runaway backstop stays fail-fast", () => {
    const single = scripted((len) => len / 20); // 10k -> 500 ms, over the 100 ms ceiling
    expect(() => expectLinear(gen, single.fn, { n: TOP, sizes: SIZES, ceilingMs: 100, attempts: 1, clock: single.clock })).toThrow(/over the .* ceiling/);
    const dflt = scripted((len) => len / 20);
    const message = messageOf(() => expectLinear(gen, dflt.fn, { n: TOP, sizes: SIZES, ceilingMs: 100, clock: dflt.clock }));
    expect(message).toMatch(/over the .* ceiling/);
    expect(message).not.toContain("attempt");
    expect(dflt.calls()).toBe(single.calls()); // warm-up + one timed call: no second attempt ran
    expect(dflt.calls()).toBe(2);
  });

  it("(d) a ceiling breach in the second attempt propagates as a ceiling error, not as a super-linear one", () => {
    // Attempt 1: the top rung reads 10x for its first K calls (super-linear). Attempt 2: the top rung is over the ceiling.
    const base = (len: number) => len / 1_000;
    const K = samplesPerFailingAttempt((len) => base(len) * (len === TOP ? 10 : 1), TOP);
    const s = scripted((len, call) => (len === TOP ? (call <= K ? base(len) * 10 : 9_000) : base(len)));
    const message = messageOf(() => expectLinear(gen, s.fn, { ...OPTS, ceilingMs: 5_000, clock: s.clock }));
    expect(message).toMatch(/size 80000 took 9000\.0 ms, over the 5000 ms ceiling/);
    expect(message).not.toContain("attempt");
  });

  it.each([0, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "(e) rejects attempts: %s with a validation error before running anything",
    (attempts) => {
      const s = scripted(() => 1);
      expect(() => expectLinear(gen, s.fn, { ...OPTS, attempts, clock: s.clock })).toThrow(/^expectLinear: attempts must be an integer >= 1/);
      expect(s.calls()).toBe(0);
    },
  );

  it("attempts: 3 gives a third chance, and its message says N of N", () => {
    const base = (len: number) => len / 1_000;
    const K = samplesPerFailingAttempt((len) => base(len) * (len === TOP ? 10 : 1), TOP);
    // Noisy through the first TWO attempts' samples of the top rung: a third attempt is the first clean one.
    const noisyTwice = (len: number, call: number) => base(len) * (len === TOP && call <= 2 * K ? 10 : 1);
    const two = scripted(noisyTwice);
    expect(messageOf(() => expectLinear(gen, two.fn, { ...OPTS, attempts: 2, clock: two.clock }))).toContain("[attempt 2 of 2; attempt 1: 10000: 10.0 ms");
    const three = scripted(noisyTwice);
    expect(expectLinear(gen, three.fn, { ...OPTS, attempts: 3, clock: three.clock }).minMs).toEqual([10, 20, 40, 80]);
    const quad = scripted((len) => (len / 1_000) ** 2);
    expect(messageOf(() => expectLinear(gen, quad.fn, { ...OPTS, attempts: 3, clock: quad.clock }))).toContain("attempt 3 of 3");
  });

  it("starts every attempt from a fresh `min` and a fresh confirmation budget", () => {
    // Attempt 1 spends the whole 1000 ms confirmation budget on the quadratic pair (2 rounds of 500 ms on the 10k and
    // 20k rungs), so an attempt 2 that inherited the spent budget would take no confirmation samples on them.
    const twice = scripted((len) => (len / 1_000) ** 2);
    expect(() => expectLinear(gen, twice.fn, { ...OPTS, clock: twice.clock })).toThrow(/attempt 2 of 2/);
    const once = scripted((len) => (len / 1_000) ** 2);
    expect(() => expectLinear(gen, once.fn, { ...OPTS, attempts: 1, clock: once.clock })).toThrow(/super-linear/);
    // Every rung is sampled exactly as often in attempt 2 as in attempt 1 (the warm-up is one extra call on the smallest rung).
    for (const size of SIZES) {
      const warm = size === SIZES[0] ? 1 : 0;
      expect(callsAt(twice, size) - warm, `rung ${size}`).toBe(2 * (callsAt(once, size) - warm));
    }
    // The confirmation samples really happened in attempt 1: warm-up + 2 plain samples (a rung of 20 ms and up) + 2 rounds.
    expect(callsAt(once, 10_000)).toBe(1 + 2 + 2);
  });

  it("builds the extension input once even when both attempts reach the extension rung", () => {
    // Constant costs 4, 6, 14, 45, 140: a step of 3.2x at the top, then 3.11x again after it. The cost keeps growing
    // faster than linear past the step, so the extension rung fails it in EVERY attempt.
    const costs: Record<number, number> = { 10_000: 4, 20_000: 6, 40_000: 14, 80_000: 45, 160_000: 140 };
    const s = scripted((len) => costs[len]!);
    const built: number[] = [];
    const message = messageOf(() =>
      expectLinear(
        (n) => {
          built.push(n);
          return gen(n);
        },
        s.fn,
        { ...OPTS, clock: s.clock },
      ),
    );
    expect(message).toMatch(/^super-linear: 80000 -> 160000 grew 3\.11x after a 40000 -> 80000 step of 3\.21x/);
    // Both attempts reached the extension rung (so the retry really happened), the input was built a single time.
    expect(message).toContain("[attempt 2 of 2; attempt 1: 10000: 4.0 ms, 20000: 6.0 ms, 40000: 14.0 ms, 80000: 45.0 ms, 160000: 140.0 ms]");
    expect(built).toEqual([10_000, 20_000, 40_000, 80_000, 160_000]);
  });
});

// ---------------------------------------------------------------------------
// Real process.cpuUsage clock. A busy loop does the same amount of CPU work
// whether the machine is idle or loaded, which is the point of the helper.
// ---------------------------------------------------------------------------

let sink = 0;

/** O(n^2): n outer steps, each doing n inner steps. */
function quadratic(n: number): void {
  let acc = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) acc = (acc + (i ^ j)) | 0;
  sink ^= acc;
}

/** O(n): n outer steps, each doing a fixed 2000 inner steps (same cost as quadratic at n = 2000). */
function linear(n: number): void {
  let acc = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < 2_000; j++) acc = (acc + (i ^ j)) | 0;
  sink ^= acc;
}

// vitest's testTimeout is wall clock, while this fixture burns CPU on a size ladder (about 1 s alone,
// 4.8 s on a loaded CI runner, 13.4 s once, which timed out at 10 s): 60 s is 4.5x the worst run seen.
// The sizes, ceiling and assertion of the quadratic loop (the one that burns that CPU) are unchanged.
// It runs a single attempt (`attempts: 1`): the retry of a failing ladder is proven with the scripted clock above,
// and a second attempt would double this CPU and halve the headroom.
//
// Which of these can flake on a shared runner (h89-flaky-1), and how each is kept steady:
//   - quadratic loop must throw: runner noise only makes a rung slower, which reads as MORE super-linear, so it
//     cannot turn the expected throw into a pass. Left as it was.
//   - linear loop must pass: the old real-clock verdict over 2000 .. 16000 could flake. It is now a smoke test of
//     the real CPU clock. Every rung is far under a 10 ms floor, so the detector returns after the warm-up and one
//     sample per rung (the sub-floor early return) and never reaches the later passes, confirmation or the top
//     extension. It does not measure real-clock false positives: it would pass a quadratic loop at these sizes too.
//   - absolute ceiling must throw: noise only raises the reading above a 0.001 ms ceiling. Left as it was.
//   - wall clock / injected clock: the wall part used to assert a verdict on real wall time. It now asserts that a
//     sleep shows up in the wall clock, a lower bound that load can only widen.
//   - asleep: asserts the CPU readings directly instead of running the detector over a long real-CPU ladder.
describe("expectLinear with the real CPU clock", { timeout: 60_000 }, () => {
  const realSizes = [2_000, 4_000, 8_000, 16_000];
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  it("fails a deliberately quadratic loop with /super-linear/", () => {
    expect(() => expectLinear((n) => n, quadratic, { n: 16_000, sizes: realSizes, ceilingMs: 20_000, floorMs: 1, attempts: 1 })).toThrow(/super-linear/);
  });

  it("passes a linear loop under the noise floor (real-clock smoke test)", () => {
    // A small ladder, every rung far under a 10 ms noise floor: about 0.15, 0.3, 0.6 and 1.2 ms of CPU per call here
    // (1.5 ms for the top rung on the CI runner of PR #245). The old ladder (2000 .. 16000, floorMs 1, about 10 ms a
    // call at the top) failed on that runner when the machine slowed down for seconds, 1.6x on one rung and 13x on
    // the 32000 extension rung, which no number of samples can average out. Now a linear loop reads as super-linear
    // only if the top rung reads 40 ms or more (3 x the floor, plus the floor), 25x or more its own cost, on every
    // sample. What this checks is that the real CPU clock gives finite readings and that a ladder under the floor is
    // accepted after pass 0 (the warm-up and one sample per rung). It is not evidence about real-clock false
    // positives. At these sizes it would pass a quadratic loop too (about 0.02 .. 1 ms per call), and the later
    // passes, confirmation and top extension never run. How the verdict scales with size is proven with a scripted
    // clock above and with the quadratic loop below.
    const sizes = [250, 500, 1_000, 2_000];
    const report = expectLinear((n) => n, linear, { n: 2_000, sizes, ceilingMs: 20_000, floorMs: 10 });
    expect(report.sizes).toEqual(sizes);
    expect(report.minMs).toHaveLength(4);
    // CPU time of the smallest rung can round to 0 ms on a fast runner (PR #237 CI):
    // only a negative or non-finite timing is wrong here.
    expect(report.minMs.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true);
  });

  it("fails a loop that is over the absolute ceiling", () => {
    expect(() => expectLinear((n) => n, quadratic, { n: 4_000, sizes: [4_000], ceilingMs: 0.001 })).toThrow(/ceiling/);
  });

  it("accepts the wall clock and an injected clock function", () => {
    // The wall clock counts time spent asleep, which is what tells it apart from the CPU clock: a 30 ms sleep reads at
    // least half of it (a timer never fires early, the margin is for rounding; load only adds to it). One rung, so
    // the verdict is only the ceiling and does not depend on how noisy the machine is.
    const asleep = expectLinear((n) => n, () => sleep(30), { n: 1, sizes: [1], ceilingMs: 20_000, clock: "wall" });
    expect(asleep.minMs).toHaveLength(1);
    expect(asleep.minMs[0]).toBeGreaterThanOrEqual(15);
    let calls = 0;
    const report = expectLinear((n) => n, () => undefined, { n: 4, sizes: [1, 2, 4], ceilingMs: 100, clock: () => ++calls });
    expect(report.minMs.every((ms) => ms === 1)).toBe(true);
  });

  it("ignores time spent asleep: a quadratic wall-time cost on top of linear CPU work still passes", () => {
    // Every call sleeps 40, 160 and 640 ms (quadratic in n) on top of microseconds of linear CPU work. Sleeping adds
    // wall time but no CPU time, like a descheduled process, so the CPU clock must read the work only. The signal is
    // the readings themselves: each rung must read a small fraction of its own sleep. (This used to run the detector
    // over 2000 .. 16000 plus a 32000 extension rung of real CPU, where a runner slowdown made a linear loop read
    // 323 ms: PR #245.) The CPU readings are about 0.1 ms, so a slowdown would have to inflate them about 70x (the
    // readings check) or 400x (the detector, floorMs 10) before either noticed. On a wall clock every rung reads at
    // least its sleep and the ladder is quadratic, so the detector throws and the readings check fails (the
    // wall-clock test above is the control that this sleep really is visible to a wall clock).
    const sizes = [2_000, 4_000, 8_000];
    const sleepMs = (n: number) => 40 * (n / 2_000) ** 2;
    const report = expectLinear(
      (n) => n,
      (n: number) => {
        linear(n / 100);
        sleep(sleepMs(n));
      },
      { n: 8_000, sizes, ceilingMs: 20_000, floorMs: 10 },
    );
    expect(report.sizes).toEqual(sizes);
    sizes.forEach((n, i) => expect(report.minMs[i], `rung ${n}`).toBeLessThan(sleepMs(n) / 5));
  });
});

describe("the CPU clock reads the calling thread only", () => {
  const usage = (user: number, system: number): NodeJS.CpuUsage => ({ user, system });
  const spinningWorker = () => {
    // Resolves once the worker thread is running, and keeps it busy for 3 s unless terminated.
    const flag = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(
      `const { workerData } = require("node:worker_threads");
       const flag = new Int32Array(workerData);
       Atomics.store(flag, 0, 1);
       Atomics.notify(flag, 0);
       const end = Date.now() + 3000;
       let x = 0;
       while (Date.now() < end) x = (x + 1) | 0;`,
      { eval: true, workerData: flag.buffer },
    );
    Atomics.wait(flag, 0, 0, 5_000);
    expect(Atomics.load(flag, 0)).toBe(1);
    return worker;
  };

  it("uses process.threadCpuUsage (user + system, in ms) when it exists", () => {
    const clock = createCpuClock({
      threadCpuUsage: () => usage(1_500, 500),
      cpuUsage: () => usage(9_000_000, 9_000_000),
      isMainThread: true,
    });
    expect(clock()).toBe(2);
  });

  it("falls back to the process-wide process.cpuUsage on the main thread", () => {
    const clock = createCpuClock({ cpuUsage: () => usage(3_000, 1_000), isMainThread: true });
    expect(clock()).toBe(4);
  });

  it("refuses the process-wide fallback off the main thread, where it counts other test files", () => {
    const clock = createCpuClock({ cpuUsage: () => usage(3_000, 1_000), isMainThread: false });
    expect(() => clock()).toThrow(/process-wide/);
    expect(() => clock()).toThrow(/forks/);
  });

  it("the default clock reads a finite, non-decreasing number of ms on this thread", () => {
    const clock = createCpuClock();
    const a = clock();
    let acc = 0;
    for (let i = 0; i < 2_000_000; i++) acc = (acc + (i ^ 3)) | 0;
    const b = clock();
    expect(Number.isFinite(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(typeof acc).toBe("number");
  });

  it.skipIf(typeof process.threadCpuUsage !== "function")(
    "ignores a worker thread spinning at full speed while this thread sleeps",
    async () => {
      const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const worker = spinningWorker();
      try {
        // 4 x 40 ms of sleep with a second core burning: process.cpuUsage would read ~40 ms per call.
        expect(() => expectCpuUnder(() => sleep(40), 20)).not.toThrow();
        expect(() =>
          expectLinear(
            (n) => n,
            (n: number) => sleep(n),
            { n: 40, sizes: [10, 20, 40], ceilingMs: 20, floorMs: 1, runs: 2 },
          ),
        ).not.toThrow();
      } finally {
        await worker.terminate();
      }
    },
  );
});

describe("expectCpuUnder", () => {
  it("returns the best CPU time of the runs when under the ceiling", () => {
    const best = expectCpuUnder(() => linear(500), 5_000);
    // A per-thread CPU clock can read 0 for a run this short (coarse on Linux CI).
    expect(Number.isFinite(best)).toBe(true);
    expect(best).toBeGreaterThanOrEqual(0);
    expect(best).toBeLessThan(5_000);
  });

  it("runs fn once to warm up and then `runs` times (default 3)", () => {
    let calls = 0;
    expectCpuUnder(() => void calls++, 1_000);
    expect(calls).toBe(1 + 3);
    calls = 0;
    expectCpuUnder(() => void calls++, 1_000, 5);
    expect(calls).toBe(1 + 5);
  });

  it("throws /ceiling/ when even the best run is over it", () => {
    expect(() => expectCpuUnder(() => linear(2_000), 0.001)).toThrow(/ceiling/);
  });

  it("is not fooled by time spent asleep: only CPU time counts", () => {
    const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    expect(() => expectCpuUnder(() => sleep(40), 20)).not.toThrow();
  });

  it("propagates an error thrown by fn", () => {
    expect(() =>
      expectCpuUnder(() => {
        throw new Error("boom");
      }, 100),
    ).toThrow("boom");
  });

  it("keeps `sink` observable so the loops cannot be optimised away", () => {
    linear(10);
    quadratic(10);
    expect(typeof sink).toBe("number");
  });
});
