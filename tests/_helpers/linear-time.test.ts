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
    // Rungs cost 0.5, 1.5 (both under 2 ms) then 3, 12: the 3 -> 12 step is x4.
    const costs: Record<number, number> = { 10_000: 0.5, 20_000: 1.5, 40_000: 3, 80_000: 12 };
    const s = scripted((len) => costs[len]!);
    expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: s.clock })).toThrow(/super-linear: 40000 -> 80000/);
  });

  it("flags a pair only when its cost beyond the linear allowance is more than timer noise (floorMs)", () => {
    // 2.0 ms -> 6.2 ms is 3.1x, over the 3.0x limit, but only 0.2 ms over the allowance: noise, not a regression.
    const costs: Record<number, number> = { 62_500: 2, 125_000: 6.2 };
    const noisy = scripted((len) => costs[len]!);
    expect(() => expectLinear(gen, noisy.fn, { n: 125_000, sizes: [62_500, 125_000], ceilingMs: 5_000, clock: noisy.clock })).not.toThrow();
    // 20 ms -> 66 ms is the same 3.3x but 6 ms over the allowance: real.
    const real = scripted((len) => (len === 62_500 ? 20 : 66));
    expect(() => expectLinear(gen, real.fn, { n: 125_000, sizes: [62_500, 125_000], ceilingMs: 5_000, clock: real.clock })).toThrow(/super-linear/);
    // A caller can tighten the noise level with floorMs: at 0.1 the 0.2 ms excess counts again.
    const tight = scripted((len) => costs[len]!);
    expect(() =>
      expectLinear(gen, tight.fn, { n: 125_000, sizes: [62_500, 125_000], ceilingMs: 5_000, floorMs: 0.1, clock: tight.clock }),
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
    // 0.2 ms -> 3 ms: x15 against the rung, but only 1.5x against the 2 ms floor: noise, not a regression.
    const costs: Record<number, number> = { 10_000: 0.2, 20_000: 3 };
    const s = scripted((len) => costs[len]!);
    expect(() => expectLinear(gen, s.fn, { n: 20_000, sizes: [10_000, 20_000], ceilingMs: 2_000, clock: s.clock })).not.toThrow();
    // 0.2 ms -> 30 ms is 15x the floor and 24 ms over the allowance: real.
    const big = scripted((len) => (len === 10_000 ? 0.2 : 30));
    expect(() => expectLinear(gen, big.fn, { n: 20_000, sizes: [10_000, 20_000], ceilingMs: 2_000, clock: big.clock })).toThrow(
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
    // 0.5, 1, 1.5 ms then 12 ms: 12 / 2 = 6x over the floor, so the early return must not fire.
    const costs: Record<number, number> = { 10_000: 0.5, 20_000: 1, 40_000: 1.5, 80_000: 12 };
    const s = scripted((len) => costs[len]!);
    expect(() => expectLinear(gen, s.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, runs: 5, clock: s.clock })).toThrow(
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
    // With a single run and no confirmation the stalled sample is the only one, and it reads as super-linear.
    const k1 = scripted(stall);
    expect(() =>
      expectLinear(gen, k1.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, runs: 1, confirmRuns: 0, clock: k1.clock }),
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
      expectLinear(gen, unconfirmed.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, runs: 1, confirmRuns: 0, clock: unconfirmed.clock }),
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

  it("takes no confirmation samples on a pair that passes, nor on a pair of slow rungs", () => {
    const ok = scripted((len) => len / 100);
    expectLinear(gen, ok.fn, { n: 80_000, sizes: SIZES, ceilingMs: 5_000, clock: ok.clock });
    expect(ok.calls()).toBe(1 + 4 * 2); // 100 .. 800 ms rungs: two samples each, nothing more
    // 300 ms -> 1200 ms is x4 but both rungs are slow: the plain two samples decide.
    const slow = scripted((len) => 300 * (len / 10_000) ** 2);
    expect(() => expectLinear(gen, slow.fn, { n: 20_000, sizes: [10_000, 20_000], ceilingMs: 5_000, clock: slow.clock })).toThrow(/super-linear/);
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

describe("expectLinear with the real CPU clock", () => {
  const realSizes = [2_000, 4_000, 8_000, 16_000];

  it("fails a deliberately quadratic loop with /super-linear/", () => {
    expect(() => expectLinear((n) => n, quadratic, { n: 16_000, sizes: realSizes, ceilingMs: 20_000, floorMs: 1 })).toThrow(/super-linear/);
  });

  it("passes a linear loop", () => {
    const report = expectLinear((n) => n, linear, { n: 16_000, sizes: realSizes, ceilingMs: 20_000, floorMs: 1 });
    expect(report.minMs).toHaveLength(4);
    expect(report.minMs.every((ms) => ms > 0)).toBe(true);
  });

  it("fails a loop that is over the absolute ceiling", () => {
    expect(() => expectLinear((n) => n, quadratic, { n: 4_000, sizes: [4_000], ceilingMs: 0.001 })).toThrow(/ceiling/);
  });

  it("accepts the wall clock and an injected clock function", () => {
    expect(() => expectLinear((n) => n, linear, { n: 800, sizes: [200, 400, 800], ceilingMs: 20_000, clock: "wall" })).not.toThrow();
    let calls = 0;
    const report = expectLinear((n) => n, () => undefined, { n: 4, sizes: [1, 2, 4], ceilingMs: 100, clock: () => ++calls });
    expect(report.minMs.every((ms) => ms === 1)).toBe(true);
  });

  it("ignores time spent asleep: a quadratic wall-time cost on top of linear CPU work still passes", () => {
    // Sleeping adds wall time (quadratic in n) but no CPU time, like a descheduled process.
    const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    expect(() =>
      expectLinear(
        (n) => n,
        (n: number) => {
          linear(n);
          sleep((n / 2_000) ** 2);
        },
        { n: 16_000, sizes: realSizes, ceilingMs: 20_000, floorMs: 1 },
      ),
    ).not.toThrow();
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
    expect(best).toBeGreaterThan(0);
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
