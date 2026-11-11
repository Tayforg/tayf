import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// /source/[slug] -- the zone-history flag reaches the label card
// (h122-sourcepages-3).
//
// source-profile-query.ts marks a failed source_zone_history read as
// `historyUnavailable` (pinned in source-profile-query.test.ts) and LabelCard
// prints "Etiket geçmişi şu anda okunamadı." for it (pinned in
// label-card.test.tsx). This file pins the one hop in between: the page hands
// the flag to <LabelCard> as a plain boolean. Everything the page reads is
// mocked at its module boundary, and the tree is walked without rendering
// children (same approach as page.test.tsx next to it).
// ---------------------------------------------------------------------------

vi.mock("@/lib/sources/source-profile-query", () => ({
  getSourceProfile: vi.fn(),
}));
vi.mock("@/lib/game/agreement", () => ({
  getSourceAgreement: vi.fn(async () => null),
}));
vi.mock("@/lib/sources/karne", () => ({
  getSourceKarne: vi.fn(async () => null),
}));
vi.mock("@/lib/sources/reliability", () => ({
  getSourceReliability: vi.fn(async () => null),
}));
vi.mock("@/lib/sources/clickbait", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sources/clickbait")>();
  return {
    ...actual,
    isClickbaitPublic: vi.fn(() => false),
    getClickbaitKarne: vi.fn(async () => null),
  };
});

import SourceProfilePage from "./page";
import { LabelCard } from "@/components/source/label-card";
import { getSourceProfile, type SourceProfile } from "@/lib/sources/source-profile-query";

function profileOf(extra: Partial<SourceProfile>): SourceProfile {
  return {
    source: {
      id: "src-1",
      name: "Örnek Gazete",
      slug: "ornek-gazete",
      url: "https://www.ornek.example/",
      rss_url: "https://www.ornek.example/rss",
      bias: "center",
      logo_url: null,
      active: true,
      kind: "outlet",
      image_allowed: true,
      excerpt_allowed: true,
      zone_rationale: null,
      zone_rationale_at: null,
      trustee_since: null,
      trustee_note: null,
      fetch_quarantined_until: null,
    },
    quarantined: false,
    feedFrozen: false,
    newestFeedItemAt: null,
    articleCount7d: 0,
    articles: [],
    zoneHistory: [],
    ...extra,
  };
}

type El = { type?: unknown; props?: { children?: unknown; [k: string]: unknown } };

function findByType(node: unknown, type: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) findByType(child, type, out);
  } else if (node && typeof node === "object") {
    const el = node as El;
    if (el.type === type) out.push(el);
    if (el.props?.children !== undefined) findByType(el.props.children, type, out);
  }
  return out;
}

async function labelCardProps(profile: SourceProfile) {
  vi.mocked(getSourceProfile).mockResolvedValue(profile);
  const tree = await SourceProfilePage({ params: Promise.resolve({ slug: profile.source.slug }) });
  const cards = findByType(tree, LabelCard);
  expect(cards).toHaveLength(1);
  return cards[0]!.props as unknown as Parameters<typeof LabelCard>[0];
}

beforeEach(() => {
  vi.mocked(getSourceProfile).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/source/[slug] -- LabelCard receives the zone-history flag (h122-sourcepages-3)", () => {
  it("a failed history read reaches the card as historyUnavailable=true with an empty history", async () => {
    const props = await labelCardProps(profileOf({ zoneHistory: [], historyUnavailable: true }));
    expect(props.historyUnavailable).toBe(true);
    expect(props.history).toEqual([]);
  });

  it("a successful read reaches the card as historyUnavailable=false", async () => {
    const props = await labelCardProps(profileOf({ historyUnavailable: false }));
    expect(props.historyUnavailable).toBe(false);
  });

  it("a profile that predates the field reads as a successful history read (false, never undefined)", async () => {
    const props = await labelCardProps(profileOf({}));
    expect(props.historyUnavailable).toBe(false);
  });

  it("recorded rows are passed through untouched", async () => {
    const zoneHistory = [
      {
        oldBias: "center" as const,
        newBias: "opposition_leaning" as const,
        reason: null,
        rater: null,
        changedAt: "2026-10-05T00:00:00Z",
      },
    ];
    const props = await labelCardProps(profileOf({ zoneHistory, historyUnavailable: false }));
    expect(props.history).toEqual(zoneHistory);
  });
});
