import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BLINDSPOT } from "@/lib/bias/config";
import { BLINDSPOTS_FEED_MAX_ITEMS } from "@/lib/feeds/blindspots-feed";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt 63, h63-feeds-1): the "Topic and blindspot RSS
// feeds" section of docs/api.md must state the item caps the feed code
// enforces and what is special about the kör-nokta feeds.
//
//   (a) The "Item cap" bullet carries BLINDSPOTS_FEED_MAX_ITEMS. It said "30 per
//       feed" for all three feeds after h53-consistency-1 raised the kör-nokta
//       cap to 60 (30 cards + up to 30 compact rows) without a docs update.
//   (b) The same bullet carries the topic cap, read from the MAX_ITEMS constant
//       of src/app/rss/[topic]/route.ts. A route file cannot export extra names,
//       so the source text is parsed instead of importing the constant.
//   (c) The /rss/kor-noktalar.xml table row carries BLINDSPOT.feedDelayHours:
//       a claim enters the feed only once its story is that old, so every
//       pubDate (first_published) is at least that far in the past, and
//       lastBuildDate (the newest item's pubDate, which buildRssXml takes from
//       the items) trails real time by at least that long and does not record
//       when a claim was added. It is NOT frozen: a claim that crosses the
//       threshold usually lifts it to its own first_published.
//
// Docs only: the guard changes no feed behaviour. Every number is read from the
// code, so a later cap or delay change fails here until the prose follows.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const DOC = readFileSync(resolve(ROOT, "docs", "api.md"), "utf8");
const TOPIC_ROUTE = readFileSync(resolve(ROOT, "src", "app", "rss", "[topic]", "route.ts"), "utf8");

/** The text from the first line equal to `heading` up to the next heading of the same or a higher level. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  if (start < 0) return "";
  const level = heading.length - heading.trimStart().replace(/^#+/, "").length;
  const out: string[] = [];
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (!inFence) {
      let hashes = 0;
      while (line[hashes] === "#") hashes++;
      if (hashes > 0 && hashes <= level && line[hashes] === " ") break;
    }
    out.push(line);
  }
  return out.join("\n");
}

const FEEDS = section(DOC, "### Topic and blindspot RSS feeds");
const ITEM_CAP = FEEDS.split("\n").find((l) => l.startsWith("- **Item cap**")) ?? "";
const KOR_NOKTA_ROW =
  FEEDS.split("\n").find((l) => l.startsWith("|") && l.includes("`/rss/kor-noktalar.xml`")) ?? "";

describe("docs/api.md: RSS item caps and the kör-nokta feed (h63-feeds-1)", () => {
  it("finds the section, the Item cap bullet and the kör-nokta table row", () => {
    expect(FEEDS).not.toBe("");
    expect(ITEM_CAP).not.toBe("");
    expect(KOR_NOKTA_ROW).not.toBe("");
  });

  it("(a) the Item cap bullet carries the kör-nokta cap, BLINDSPOTS_FEED_MAX_ITEMS", () => {
    expect(ITEM_CAP).toContain(String(BLINDSPOTS_FEED_MAX_ITEMS));
  });

  it("(b) the Item cap bullet carries the topic cap parsed from the route's MAX_ITEMS", () => {
    const m = /const MAX_ITEMS = (\d+)/.exec(TOPIC_ROUTE);
    expect(m, "MAX_ITEMS not found in src/app/rss/[topic]/route.ts").not.toBeNull();
    const topicCap = m![1] as string;
    expect(ITEM_CAP).toContain(`**Item cap**: ${topicCap} per topic feed`);
    // The kör-nokta cap is a different number and is named separately.
    expect(topicCap).not.toBe(String(BLINDSPOTS_FEED_MAX_ITEMS));
  });

  it("(b) does not leave a blanket 'per feed' cap that covers the kör-nokta feeds", () => {
    expect(ITEM_CAP).not.toMatch(/per feed\b/);
  });

  it("(c) the kör-nokta row carries BLINDSPOT.feedDelayHours", () => {
    expect(KOR_NOKTA_ROW).toContain(String(BLINDSPOT.feedDelayHours));
  });

  it("(c) the kör-nokta row says the order is the page's, not pubDate, and that guid detects new items", () => {
    // Code spans are stripped: the doc writes identifiers as `pubDate`, `guid`.
    const prose = KOR_NOKTA_ROW.replaceAll("`", "");
    expect(prose).toContain("order (its cards, then its compact rows), not pubDate");
    expect(prose).toContain(
      "lastBuildDate is the newest item's pubDate (its first_published), so it trails real time by at least 24 h and does not record when a claim was added",
    );
    expect(prose).not.toContain("does not move when a claim is added");
    expect(prose).toContain("key on guid to detect new items");
  });

  it("the topic row still promises newest-first by pubDate (that feed is ordered that way)", () => {
    const topicRow = FEEDS.split("\n").find((l) => l.startsWith("|") && l.includes("`/rss/{topic}.xml`")) ?? "";
    expect(topicRow).toContain("newest-first by `pubDate`");
  });
});
