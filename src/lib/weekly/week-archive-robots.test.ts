import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { weekArchiveRobots } from "./week-archive-robots";

const NOINDEX = { index: false, follow: true };

describe("weekArchiveRobots", () => {
  it("noindexes (follow kept) when the week read failed (null)", () => {
    expect(weekArchiveRobots(null)).toEqual(NOINDEX);
  });

  it("noindexes (follow kept) a week that was read fine but holds no rows", () => {
    expect(weekArchiveRobots({ rows: [] })).toEqual(NOINDEX);
  });

  it("leaves a week with rows indexable (undefined keeps the layout's default robots)", () => {
    expect(weekArchiveRobots({ rows: [{ id: "cl-1" }] })).toBeUndefined();
  });

  it("one row is enough, however many other fields the read carries", () => {
    expect(
      weekArchiveRobots({ rows: [{}], truncated: true, asOfMs: 1_790_000_000_000 } as {
        rows: readonly unknown[];
      }),
    ).toBeUndefined();
  });

  it("is pure and repeatable for the same input", () => {
    const read = { rows: [] as unknown[] };
    expect(weekArchiveRobots(read)).toEqual(weekArchiveRobots(read));
  });
});

describe("week-archive-robots — module hygiene", () => {
  it("has no next/* import (it is shared by generateMetadata and a plain unit test)", () => {
    const src = readFileSync(resolve(__dirname, "week-archive-robots.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']next(\/|["'])/);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/\bimport\(/);
  });
});
