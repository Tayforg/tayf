import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { countNewSince, LAST_VISIT_KEY, shouldStampLastVisit } from "./last-visit";

const ts = ["2026-09-07T10:00:00Z", "2026-09-07T08:00:00Z", "2026-09-06T08:00:00Z"];

describe("countNewSince", () => {
  it("counts timestamps strictly after the stamp", () => {
    expect(countNewSince(ts, "2026-09-07T09:00:00Z")).toBe(1);
  });

  it("treats an equal timestamp as not new", () => {
    expect(countNewSince(ts, "2026-09-07T10:00:00Z")).toBe(0);
  });

  it("returns 0 for a null stamp (first visit)", () => {
    expect(countNewSince(ts, null)).toBe(0);
  });

  it("returns 0 for an unparseable stamp", () => {
    expect(countNewSince(ts, "garbage")).toBe(0);
  });

  it("ignores unparseable entries", () => {
    expect(countNewSince(["nope", ...ts], "2026-09-01T00:00:00Z")).toBe(3);
  });

  it("exposes the storage key", () => {
    expect(LAST_VISIT_KEY).toBe("tayf:last-visit");
  });
});

// h55-personal-3: the stamp is "the reader saw the feed", so only a render that
// actually showed it may write it. A search view, ?page=N and the outage shell
// used to stamp too, and the next session's pill then dropped every story
// published in between that the reader never saw on the feed.
describe("shouldStampLastVisit", () => {
  it("stamps page 1 without a search when the feed rendered", () => {
    expect(shouldStampLastVisit({ page: 1, q: undefined, feedOk: true })).toBe(true);
  });

  it("does not stamp ?page=N (page 2 is not the top of the feed)", () => {
    expect(shouldStampLastVisit({ page: 2, q: undefined, feedOk: true })).toBe(false);
  });

  it("does not stamp a /?q= search view", () => {
    expect(shouldStampLastVisit({ page: 1, q: "seçim", feedOk: true })).toBe(false);
  });

  it("does not stamp when the feed did not render (FeedUnavailable shell)", () => {
    expect(shouldStampLastVisit({ page: 1, q: undefined, feedOk: false })).toBe(false);
  });

  it("a search on a later page, or a failed feed with a search, never stamps", () => {
    expect(shouldStampLastVisit({ page: 3, q: "seçim", feedOk: true })).toBe(false);
    expect(shouldStampLastVisit({ page: 1, q: "seçim", feedOk: false })).toBe(false);
    expect(shouldStampLastVisit({ page: 2, q: undefined, feedOk: false })).toBe(false);
  });

  it("treats an empty-string query like no query (page.tsx maps blank to undefined)", () => {
    expect(shouldStampLastVisit({ page: 1, q: "", feedOk: true })).toBe(true);
  });
});

describe("the stamp is wired through the pill and the page (source guard: effects need a browser)", () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
  const page = read("../app/page.tsx");
  const pill = read("../components/home/new-since-last-visit.tsx");

  /** Opening tag of every <NewSinceLastVisit ...> mount, up to its closing "/>". */
  function mounts(src: string): string[] {
    const out: string[] = [];
    let from = src.indexOf("<NewSinceLastVisit");
    while (from !== -1) {
      const end = src.indexOf("/>", from);
      out.push(src.slice(from, end + 2));
      from = src.indexOf("<NewSinceLastVisit", end);
    }
    return out;
  }

  it("page.tsx has exactly two mounts, and both pass a stamp prop", () => {
    const all = mounts(page);
    expect(all).toHaveLength(2);
    for (const tag of all) expect(tag).toContain("stamp={");
  });

  it("the FeedUnavailable shell never stamps", () => {
    const shell = mounts(page).filter((tag) => tag.includes("timestamps={[]}"));
    expect(shell).toHaveLength(1);
    expect(shell[0]).toContain("stamp={false}");
  });

  it("the main mount stamps through shouldStampLastVisit with the clamped page and q", () => {
    const main = mounts(page).filter((tag) => tag.includes("renderedTimestamps"));
    expect(main).toHaveLength(1);
    expect(main[0]).toContain("stamp={shouldStampLastVisit({ page: safePage, q, feedOk: true })}");
    expect(page).toContain('import { shouldStampLastVisit } from "@/lib/last-visit";');
  });

  it("the pill takes a required boolean stamp and writes only when it is true", () => {
    expect(pill).toContain("stamp: boolean;");
    expect(pill).not.toContain("stamp?:");
    expect(pill).toContain("if (stamp) writeLastVisit(new Date().toISOString());");
    expect(pill).toContain("}, [stamp]);");
    // The guarded call is the only write: no unconditional one is left behind.
    expect(pill.split("writeLastVisit(").length - 1).toBe(1);
  });
});
