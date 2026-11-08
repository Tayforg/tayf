// Load-robust replacement for "fn(hugeInput) must finish in < B ms".
//
// A blow-up (a quadratic scan, a backtracking regex) is a property of how the
// time GROWS with the input size, not of the absolute wall clock. A wall-clock
// budget fails on a busy machine (the scheduler preempts the process mid-call,
// so the elapsed time inflates 3x or more) and passes a mild regression on an
// idle one. This helper measures the growth instead:
//
//   - the clock is CPU time (user + system), which a descheduled process does
//     not accumulate. It is read with process.threadCpuUsage(), the CPU time of
//     the calling thread only, so another test file in a worker thread, or a V8
//     helper thread (GC, concurrent compile), is not billed to the test. Where
//     Node lacks it, the fallback is process.cpuUsage(), which is per PROCESS: it
//     is exact only when vitest runs a file in its own forked process (the
//     `pool: "forks"` in vitest.config.ts), so off the main thread the fallback
//     refuses to run instead of reporting other files' CPU.
//   - every rung of a size ladder is timed as the minimum of K runs, with the
//     rungs interleaved so a load spike hits all of them alike;
//   - for each adjacent pair, the growth must stay within slack x the size ratio
//     (doubling: linear 2x, limit 3x at the default slack, quadratic 4x);
//   - a pair that looks super-linear is CONFIRMED before it fails: the two rungs
//     get a burst of extra samples (the minimum only goes down), so one noisy
//     rung on a loaded machine cannot fail the test while a real quadratic, whose
//     every sample is slow, still does;
//   - a generous absolute ceiling (rule of thumb: 20 x the old wall-clock budget)
//     stays as a backstop and makes a runaway fail fast, before the next, larger
//     rung runs.
//
// The helper throws plain Errors (no vitest import), so it can be used from any
// test runner and its messages name the whole ladder.

import { isMainThread } from "node:worker_threads";

export type Gen<I = string> = (n: number) => I;

/** A clock in milliseconds. `"cpu"` is the default, `"wall"` is performance.now(). */
export type Clock = "cpu" | "wall" | (() => number);

/** rep(unit, prefix, suffix)(n): exactly n characters of the repeated unit, plus the affixes. */
export const rep =
  (unit: string, prefix = "", suffix = ""): Gen =>
  (n) => {
    if (unit.length === 0) throw new Error("rep: the unit must not be empty");
    return prefix + unit.repeat(Math.ceil(n / unit.length)).slice(0, n) + suffix;
  };

export interface LinearOptions {
  /** Largest size: the literal the old test used (100_000, 250_000 ...). Ignored when `sizes` is given. */
  n: number;
  /** Absolute ceiling for any single call, ms. Rule of thumb: min(20 x the old budget, 8000). */
  ceilingMs: number;
  /** Ascending ladder of sizes. Default n/8, n/4, n/2, n. Pass small explicit sizes for exponential-class guards. */
  sizes?: number[];
  /** Samples per rung (the minimum is kept). Rungs of 20 ms and up are sampled twice. Default 5. */
  runs?: number;
  /** Allowed slack over exact linear growth between rungs. Doubling: limit 2 x slack = 3x at the default. */
  slack?: number;
  /**
   * The timer-noise level, ms. A rung faster than this is measured against the floor instead of its own tiny time (the
   * smallest denominator the growth ratio uses), so a cliff out of a sub-floor rung is still caught, and a pair is flagged
   * only when its cost beyond the linear allowance is at least this much. Must be positive on a real clock. Default 2 ms.
   */
  floorMs?: number;
  /** Most extra samples per rung taken when a pair looks super-linear (fewer when the rungs are slow: about a second of CPU in all). 0 turns confirmation off. Default 15. */
  confirmRuns?: number;
  /**
   * Excuse ONE constant-factor step (a cache or memory-tier cliff): a single violating pair whose growth is at most twice
   * the limit, when the cost grows linearly again after it (the next pair, or for the top pair one more rung timed at
   * twice the top size, under the ceiling). A super-linear cost keeps growing at every later doubling and still fails.
   * Off when `confirmRuns` is 0; never for a slow top rung. Default true.
   */
  extendTop?: boolean;
  /** Default "cpu": CPU time of the calling thread, immune to the scheduler preempting a loaded machine. */
  clock?: Clock;
}

export interface LinearReport {
  sizes: number[];
  minMs: number[];
}

const wallNow = () => performance.now();

/** What the CPU clock reads from; injectable so the fallback rules can be tested on any Node. */
export interface CpuClockEnv {
  /** process.threadCpuUsage: CPU time of the calling thread only. Absent on a Node that lacks it. */
  threadCpuUsage?: (() => NodeJS.CpuUsage) | undefined;
  /** process.cpuUsage: CPU time of the whole process, every thread included. */
  cpuUsage: () => NodeJS.CpuUsage;
  isMainThread: boolean;
}

const processEnv = (): CpuClockEnv => ({
  threadCpuUsage: typeof process.threadCpuUsage === "function" ? () => process.threadCpuUsage() : undefined,
  cpuUsage: () => process.cpuUsage(),
  isMainThread,
});

/** A clock in ms: thread CPU time when Node has it, else process CPU time on the main thread, else an error. */
export function createCpuClock(env: CpuClockEnv = processEnv()): () => number {
  const { threadCpuUsage, cpuUsage } = env;
  return () => {
    if (threadCpuUsage) {
      const t = threadCpuUsage(); // user + system microseconds of THIS thread
      return (t.user + t.system) / 1000;
    }
    if (!env.isMainThread) {
      throw new Error(
        "linear-time: process.cpuUsage() is process-wide and counts other test files in a worker thread; run vitest with pool 'forks' or on Node with process.threadCpuUsage()",
      );
    }
    const u = cpuUsage();
    return (u.user + u.system) / 1000;
  };
}

const cpuNow = createCpuClock();

function pickClock(clock: Clock): () => number {
  if (typeof clock === "function") return clock;
  return clock === "wall" ? wallNow : cpuNow;
}

export function expectLinear<I>(gen: Gen<I>, fn: (input: I) => unknown, o: LinearOptions): LinearReport {
  const sizes = o.sizes ?? [o.n / 8, o.n / 4, o.n / 2, o.n].map(Math.round);
  const runs = o.runs ?? 5;
  const slack = o.slack ?? 1.5;
  const floorMs = o.floorMs ?? 2;
  const confirmRuns = o.confirmRuns ?? 15;
  const extendTop = o.extendTop ?? true;
  const now = pickClock(o.clock ?? "cpu");

  if (!(floorMs > 0) && typeof o.clock !== "function") {
    // A real clock can read 0 ms for a tiny rung; with no floor the growth ratio out of it is infinite.
    throw new Error(`expectLinear: floorMs must be positive on a real clock, got ${floorMs}`);
  }
  if (sizes.length === 0) throw new Error("expectLinear: sizes must not be empty");
  for (let i = 0; i < sizes.length; i++) {
    if (!(sizes[i]! > 0) || (i > 0 && !(sizes[i]! > sizes[i - 1]!))) {
      throw new Error(`expectLinear: sizes must be positive and strictly ascending, got [${sizes.join(", ")}]`);
    }
  }

  const inputs = sizes.map((s) => gen(s)); // built once, never timed
  const min = sizes.map(() => Infinity);
  const ladder = () => sizes.map((s, i) => `${s}: ${min[i]!.toFixed(1)} ms`).join(", ");

  fn(inputs[0]!); // warm the JIT on the smallest rung

  /**
   * Is the pair (i-1, i) super-linear? The growth is measured from max(rung i-1, floorMs): a rung under the noise level
   * is not a trustworthy denominator, but it is not a free pass either (0.8 ms -> 1.9 ms -> 1500 ms is a cliff).
   * Super-linear only if the growth is over the limit AND the cost beyond the linear allowance is more than timer noise:
   * 2.0 ms -> 6.2 ms is 3.1x but only 0.2 ms over the allowance, which a loaded cache explains.
   */
  const lowerOf = (i: number) => Math.max(min[i - 1]!, floorMs);
  const allowedAt = (i: number) => slack * (sizes[i]! / sizes[i - 1]!);
  const violatesAt = (i: number) => min[i]! / lowerOf(i) > allowedAt(i) && min[i]! - allowedAt(i) * lowerOf(i) >= floorMs;

  /** One timed call on rung i; the rung keeps the minimum. */
  const sample = (i: number) => {
    const t = now();
    fn(inputs[i]!);
    min[i] = Math.min(min[i]!, now() - t);
  };

  // Pass 0 is ascending and fail-fast: a real blow-up stops here, before the next (bigger) rung runs.
  for (let i = 0; i < sizes.length; i++) {
    sample(i);
    if (min[i]! > o.ceilingMs) {
      throw new Error(`size ${sizes[i]} took ${min[i]!.toFixed(1)} ms, over the ${o.ceilingMs} ms ceiling (${ladder()})`);
    }
  }

  // Nothing more to learn: a single rung, or every rung but the top is already under the noise level and no pair looks
  // super-linear. More samples can only LOWER a rung, so a pair that passes now still passes, and the floor (not the
  // rung) is the denominator of every pair whose lower rung is under it.
  if (min.slice(0, -1).every((m) => m < floorMs) && !sizes.some((_, i) => i > 0 && violatesAt(i))) {
    return { sizes, minMs: min };
  }

  // Later passes are interleaved across rungs so a load spike hits every rung alike; keep the minimum.
  for (let k = 1; k < runs; k++) {
    for (let i = 0; i < sizes.length; i++) {
      if (k >= 2 && min[i]! >= 20) continue; // slow rungs: two samples are plenty above the noise
      sample(i);
    }
  }

  // A pair that looks super-linear gets extra samples on both rungs before it fails, as many as fit in about a
  // second of CPU (so a cheap, noisy pair gets all `confirmRuns` and a pair of slow rungs gets none: a rung of
  // hundreds of ms is already steady). A cost that is really super-linear is slow on every sample and still fails.
  const CONFIRM_BUDGET_MS = 1000;

  const failAt = (i: number): never => {
    const fromFloor = min[i - 1]! < floorMs ? `, measured from the ${floorMs} ms floor` : "";
    throw new Error(
      `super-linear: ${sizes[i - 1]} -> ${sizes[i]} grew ${(min[i]! / lowerOf(i)).toFixed(2)}x${fromFloor}, limit ${allowedAt(i).toFixed(2)}x (${ladder()})`,
    );
  };

  // One confirmation budget for the whole call, so a real quadratic fails in about a second of extra CPU however many
  // of its pairs look wrong.
  let budgetMs = CONFIRM_BUDGET_MS;
  const confirm = (i: number) => {
    if (confirmRuns <= 0) return;
    const perRound = lowerOf(i) + min[i]!;
    const extra = Math.min(confirmRuns, Math.floor(budgetMs / perRound));
    for (let k = 0; k < extra; k++) {
      sample(i - 1);
      sample(i);
    }
    budgetMs -= extra * perRound;
  };

  // h64-testhealth-1: on CI a 25k .. 200k ladder sometimes steps up ONCE while every other pair doubles cleanly
  // (classify-category: 3 -> 11.9 -> 24 ms at 50k -> 100k -> 200k; 8 -> 28 ms and 11 -> 46 ms at the top): the working
  // set leaving the runner's cache, a constant-factor step. A cost that is really super-linear (a + b*n^2, backtracking)
  // grows FASTER at every later doubling, so once a pair violates every pair above it violates too. So one violating
  // pair is excused when (a) it is the only one, (b) the step is at most twice the limit, and (c) the cost grows
  // linearly again after it: the next pair passes, or, for the top pair, a rung at twice the top size timed now. Pairs
  // are judged in ascending order and the first proof of super-linearity fails at once.
  let candidate = -1;
  for (let i = 1; i < sizes.length; i++) {
    if (!violatesAt(i)) continue;
    confirm(i);
    if (!violatesAt(i)) continue;
    if (candidate >= 0) return failAt(candidate); // a second step: the growth continues
    const oneOff = extendTop && confirmRuns > 0 && min[i]! / lowerOf(i) <= 2 * allowedAt(i);
    if (!oneOff) return failAt(i);
    candidate = i;
  }
  if (candidate < 0) return { sizes, minMs: min };
  const i = candidate;
  const top = sizes.length - 1;
  if (i < top) return { sizes, minMs: min };
  // The top pair: only a cheap top rung is extended (at least three samples of the extended rung fit in the budget).
  if (min[i]! > CONFIRM_BUDGET_MS / 6) return failAt(i);
  const extSize = sizes[i]! * 2;
  const extInput = gen(extSize); // built once, never timed
  let extMin = Infinity;
  const extSamples = Math.max(3, Math.min(confirmRuns, Math.floor(CONFIRM_BUDGET_MS / (2 * min[i]! || 1))));
  for (let k = 0; k < extSamples; k++) {
    sample(i);
    const t = now();
    fn(extInput);
    extMin = Math.min(extMin, now() - t);
    if (k === 0 && extMin > o.ceilingMs) {
      throw new Error(`size ${extSize} took ${extMin.toFixed(1)} ms, over the ${o.ceilingMs} ms ceiling (${ladder()})`);
    }
  }
  const lower = Math.max(min[i]!, floorMs);
  const allowed = slack * 2;
  // Written as "not linear" so an unusable reading (NaN) fails closed instead of passing.
  if (!(extMin / lower <= allowed || extMin - allowed * lower < floorMs)) {
    throw new Error(
      `super-linear: ${sizes[i]} -> ${extSize} grew ${(extMin / lower).toFixed(2)}x after a ${sizes[i - 1]} -> ${sizes[i]} step of ${(min[i]! / lowerOf(i)).toFixed(2)}x, limit ${allowed.toFixed(2)}x (${ladder()}, ${extSize}: ${extMin.toFixed(1)} ms)`,
    );
  }
  return { sizes, minMs: min };
}

/**
 * For plain budgets tied to a CPU limit (an edge isolate has 2 s of CPU) rather than to a growth law:
 * the minimum CPU time of `runs` calls, after one warm-up, must stay under a generous ceiling.
 */
export function expectCpuUnder(fn: () => unknown, ceilingMs: number, runs = 3): number {
  fn(); // warm
  let best = Infinity;
  for (let k = 0; k < runs; k++) {
    const t = cpuNow();
    fn();
    best = Math.min(best, cpuNow() - t);
  }
  if (best > ceilingMs) throw new Error(`CPU time ${best.toFixed(1)} ms is over the ${ceilingMs} ms ceiling`);
  return best;
}
