import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// next/image needs the App Router image pipeline, absent when a component
// function is rendered in isolation; a plain <img> keeps the card's own JSX
// under test (same approach as cluster-card-image.test.tsx).
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

import { ClusterCard, type ClusterCardCluster } from "./cluster-card";

// h34-perf-1: the card's time-ago badge. Pages that cache their render
// (/gundem/[key], via a "use cache" read) pass `nowMs`; the badge is then the
// client RelativeTime, which re-bases a stale cached age to the reader's
// clock. Pages that omit `nowMs` render per request and keep the plain server
// string. Only the badge markup is asserted, not the whole card.

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const FIRST_PUBLISHED = new Date(NOW - 13 * HOUR).toISOString();

const cluster: ClusterCardCluster = {
  id: "b3551cdb-0000-4000-8000-000000000001",
  title_tr: "Anayasa Mahkemesi kararını açıkladı",
  summary_tr: "Özet",
  bias_distribution: {
    pro_government: 0,
    gov_leaning: 0,
    state_media: 0,
    center: 1,
    opposition_leaning: 0,
    opposition: 0,
    nationalist: 0,
    islamist_conservative: 0,
    pro_kurdish: 0,
    international: 0,
  },
  is_blindspot: false,
  blindspot_side: null,
  article_count: 2,
  first_published: FIRST_PUBLISHED,
  updated_at: FIRST_PUBLISHED,
};

/** The time-ago pill's content after its clock icon, from a rendered card. */
function badge(nowMs?: number): string {
  const html = renderToStaticMarkup(
    <ClusterCard cluster={cluster} articles={[]} sources={[]} index={3} nowMs={nowMs} />,
  );
  const m = /lucide-clock[^>]*>[\s\S]*?<\/svg>([\s\S]*?)<\/span>/.exec(html);
  if (!m) throw new Error("no time-ago badge in card markup");
  return m[1] ?? "";
}

describe("ClusterCard time-ago badge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a <time> badge (the client RelativeTime) when nowMs is given", () => {
    expect(badge(NOW)).toBe(`<time dateTime="${FIRST_PUBLISHED}">13 saat önce</time>`);
  });

  it("measures the age against nowMs, not the clock, on the server pass", () => {
    // The cached render is an hour old by the time the clock reads NOW.
    expect(badge(NOW - HOUR)).toBe(`<time dateTime="${FIRST_PUBLISHED}">12 saat önce</time>`);
  });

  it("still renders the badge when nowMs is 0 (given, not falsy-skipped)", () => {
    // nowMs 0 is earlier than first_published: the age clamps to 0 -> "az önce".
    expect(badge(0)).toBe(`<time dateTime="${FIRST_PUBLISHED}">az önce</time>`);
  });

  it("keeps the plain server string, with no <time>, when nowMs is omitted", () => {
    expect(badge(undefined)).toBe("13 saat önce");
  });
});
