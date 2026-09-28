import { connection, NextResponse } from "next/server";

import { requireCronBearer } from "@/lib/api/bearer";
import { withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { getBlindspots, type BlindspotBundle } from "@/lib/clusters/blindspots-query";
import { getPoliticsClusters, type ClusterBundle } from "@/lib/clusters/politics-query";
import { getZoneFeedHealth } from "@/lib/clusters/feed-health";
import { createServerClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/site-url";
import {
  readSocialConfig,
  type SocialChannel,
  type BlueskyConfig,
  type TelegramConfig,
} from "@/lib/social/config";
import {
  selectBlindspotsToPost,
  selectTopStory,
  SOCIAL_DAILY_CAP,
  type FreshClusterRow,
  type SocialCandidateBundle,
} from "@/lib/social/select";
import {
  composeBlueskyBlindspot,
  composeBlueskyTopStory,
  composeTelegramBlindspot,
  composeTelegramTopStory,
} from "@/lib/social/compose";
import { postToTelegram } from "@/lib/social/telegram";
import { createBlueskySession, postToBluesky, type BlueskySession } from "@/lib/social/bluesky";

// Vercel cron — owned-channels auto-poster. Posts at most 2 blindspots and
// 1 top story PER CHANNEL per tick (see vercel.ts, every 20 min
// 08:00-23:40 TRT). Every gate in src/lib/social/select.ts is fail-closed;
// this route additionally re-reads the candidate clusters fresh right
// before claiming (never trusts the 5-minute-cached bundle alone for a
// public blindspot claim), and never posts without a non-null claim id
// from `social_post_claim` (migration 079).

export const maxDuration = 60;

const cronSocialLimit = createRateLimiter("cron-social", {
  capacity: 6,
  refillPerSecond: 1 / 600,
});

const LEDGER_WINDOW_MS = 72 * 60 * 60 * 1000;
const FRESH_SELECT =
  "id, is_blindspot, blindspot_recall_veto, blindspot_recall_suspect, blindspot_recall_checked_at, is_archived";

interface LedgerRow {
  channel: SocialChannel;
  cluster_id: string;
  kind: "blindspot" | "top_story";
  created_at: string;
}

interface PlannedPost {
  channel: SocialChannel;
  kind: "blindspot" | "top_story";
  clusterId: string;
  text: string;
  postUrl: string;
  blueskyEmbed?: { uri: string; title: string; description: string };
}

function toCandidateBundle(b: BlindspotBundle | ClusterBundle): SocialCandidateBundle {
  return {
    cluster: {
      id: b.cluster.id,
      title_tr: b.cluster.title_tr,
      first_published: b.cluster.first_published,
    },
    sources: b.sources,
    effectiveArticleCount: b.effectiveArticleCount,
    isWireRedistribution: "isWireRedistribution" in b ? b.isWireRedistribution : undefined,
  };
}

function planChannel(
  channel: SocialChannel,
  blindspotBundles: readonly BlindspotBundle[],
  topBundles: readonly ClusterBundle[],
  fresh: ReadonlyMap<string, FreshClusterRow>,
  health: Awaited<ReturnType<typeof getZoneFeedHealth>>,
  ledger: readonly LedgerRow[],
  nowMs: number,
): PlannedPost[] {
  const postedIds = new Set(
    ledger.filter((r) => r.channel === channel).map((r) => r.cluster_id),
  );
  const lastTopStoryAtMs = ledger
    .filter((r) => r.channel === channel && r.kind === "top_story")
    .reduce<number | null>((max, r) => {
      const ms = new Date(r.created_at).getTime();
      return max === null || ms > max ? ms : max;
    }, null);

  const bsCandidates = blindspotBundles.map((b) => ({
    ...toCandidateBundle(b),
    dominantZone: b.dominantZone,
    dominantPct: b.dominantPct,
  }));

  const chosenBlindspots = selectBlindspotsToPost({
    bundles: bsCandidates,
    fresh,
    health,
    nowMs,
    postedIds,
  });

  const topCandidates = topBundles.map((b) => ({
    ...toCandidateBundle(b),
    isBlindspot: b.cluster.is_blindspot,
  }));

  const topStory = selectTopStory({
    bundles: topCandidates,
    nowMs,
    postedIds,
    lastTopStoryAtMs,
  });

  const posts: PlannedPost[] = [];
  const base = siteUrl();

  for (const bundle of chosenBlindspots) {
    const original = blindspotBundles.find((b) => b.cluster.id === bundle.cluster.id);
    if (!original) continue;
    const clusterUrl = `${base}/cluster/${bundle.cluster.id}`;
    if (channel === "telegram") {
      const { text } = composeTelegramBlindspot({
        title: bundle.cluster.title_tr,
        clusterUrl,
        dominantZone: original.dominantZone,
        sources: original.sources,
      });
      posts.push({ channel, kind: "blindspot", clusterId: bundle.cluster.id, text, postUrl: clusterUrl });
    } else {
      const { text, embed } = composeBlueskyBlindspot({
        title: bundle.cluster.title_tr,
        clusterUrl,
        dominantZone: original.dominantZone,
        sources: original.sources,
      });
      posts.push({
        channel,
        kind: "blindspot",
        clusterId: bundle.cluster.id,
        text,
        postUrl: clusterUrl,
        blueskyEmbed: embed,
      });
    }
  }

  if (topStory) {
    const original = topBundles.find((b) => b.cluster.id === topStory.cluster.id);
    if (original) {
      const clusterUrl = `${base}/cluster/${topStory.cluster.id}`;
      if (channel === "telegram") {
        const { text } = composeTelegramTopStory({
          title: topStory.cluster.title_tr,
          clusterUrl,
          sources: original.sources,
        });
        posts.push({ channel, kind: "top_story", clusterId: topStory.cluster.id, text, postUrl: clusterUrl });
      } else {
        const { text, embed } = composeBlueskyTopStory({
          title: topStory.cluster.title_tr,
          clusterUrl,
          sources: original.sources,
        });
        posts.push({
          channel,
          kind: "top_story",
          clusterId: topStory.cluster.id,
          text,
          postUrl: clusterUrl,
          blueskyEmbed: embed,
        });
      }
    }
  }

  return posts;
}

async function runChannel(
  channel: SocialChannel,
  posts: readonly PlannedPost[],
  supabase: ReturnType<typeof createServerClient>,
  telegramCfg: TelegramConfig | null,
  blueskyCfg: BlueskyConfig | null,
): Promise<{ posted: number; skipped: Record<string, number> }> {
  let posted = 0;
  const skipped: Record<string, number> = {};
  const bump = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  let blueskySession: BlueskySession | null = null;

  // Sequential within a channel: the daily cap and the session are both
  // per-channel state that must not race itself.
  for (const post of posts) {
    const { data: claimId, error: claimError } = await supabase.rpc("social_post_claim", {
      p_channel: post.channel,
      p_kind: post.kind,
      p_cluster_id: post.clusterId,
      p_body: post.text,
      p_daily_cap: SOCIAL_DAILY_CAP,
    });

    if (claimError || claimId === null || claimId === undefined) {
      bump("claim_failed");
      continue;
    }

    if (channel === "telegram" && telegramCfg) {
      const result = await postToTelegram(telegramCfg, { text: post.text, url: post.postUrl });
      if (result.ok) {
        posted++;
        await supabase.rpc("social_post_finish", {
          p_id: claimId,
          p_status: "posted",
          p_external_id: result.externalId,
          p_error: null,
        });
      } else {
        bump("post_failed");
        await supabase.rpc("social_post_finish", {
          p_id: claimId,
          p_status: "failed",
          p_external_id: null,
          p_error: result.error,
        });
      }
    } else if (channel === "bluesky" && blueskyCfg) {
      try {
        if (!blueskySession) {
          blueskySession = await createBlueskySession(blueskyCfg);
        }
        const embed = post.blueskyEmbed;
        const result = await postToBluesky(blueskySession, blueskyCfg, {
          text: post.text,
          url: embed?.uri ?? post.postUrl,
          title: embed?.title ?? "",
          description: embed?.description ?? "",
        });
        if (result.ok) {
          posted++;
          await supabase.rpc("social_post_finish", {
            p_id: claimId,
            p_status: "posted",
            p_external_id: result.externalId,
            p_error: null,
          });
        } else {
          bump("post_failed");
          await supabase.rpc("social_post_finish", {
            p_id: claimId,
            p_status: "failed",
            p_external_id: null,
            p_error: result.error,
          });
        }
      } catch (err) {
        bump("post_failed");
        const message = err instanceof Error ? err.message : String(err);
        await supabase.rpc("social_post_finish", {
          p_id: claimId,
          p_status: "failed",
          p_external_id: null,
          p_error: message.slice(0, 500),
        });
      }
    } else {
      bump("no_config");
    }
  }

  return { posted, skipped };
}

export const GET = withApiErrors(async (request: Request) => {
  await connection();

  const auth = requireCronBearer(request);
  if (!auth.ok) return auth.response;

  const rl = cronSocialLimit(clientKey(request));
  if (!rl.allowed) {
    return NextResponse.json(
      { skipped: true, reason: "rate limited", retryAfterMs: rl.retryAfterMs },
      { status: 429 },
    );
  }

  const cfg = readSocialConfig();

  if (cfg.disabled) {
    return NextResponse.json({ skipped: true, reason: "disabled" });
  }

  const channels: SocialChannel[] = [];
  if (cfg.telegram) channels.push("telegram");
  if (cfg.bluesky) channels.push("bluesky");

  if (channels.length === 0) {
    console.log("[social] no channels configured; nothing posted");
    return NextResponse.json({ skipped: true, reason: "no channels configured" });
  }

  const health = await getZoneFeedHealth();
  if (health === null) {
    console.log("[social] feed health unknown; skipping this tick");
    return NextResponse.json({ skipped: true, reason: "feed health unknown" });
  }

  let blindspotBundles: BlindspotBundle[];
  let topBundles: ClusterBundle[];
  try {
    const [blindspotResult, politicsResult] = await Promise.all([
      getBlindspots(),
      getPoliticsClusters(),
    ]);
    blindspotBundles = blindspotResult.bundles;
    topBundles = politicsResult.bundles;
  } catch {
    return NextResponse.json({ skipped: true, reason: "source data unavailable" });
  }

  const supabase = createServerClient();
  const nowMs = Date.now();

  const candidateIds = Array.from(
    new Set([
      ...blindspotBundles.map((b) => b.cluster.id),
      ...topBundles.map((b) => b.cluster.id),
    ]),
  );

  const { data: freshRows } = candidateIds.length
    ? await supabase.from("clusters").select(FRESH_SELECT).in("id", candidateIds).returns<FreshClusterRow[]>()
    : { data: [] as FreshClusterRow[] };
  const fresh = new Map((freshRows ?? []).map((r) => [r.id, r]));

  const sinceIso = new Date(nowMs - LEDGER_WINDOW_MS).toISOString();
  const { data: ledgerRows } = await supabase
    .from("social_posts")
    .select("channel, cluster_id, kind, created_at")
    .gte("created_at", sinceIso)
    .returns<LedgerRow[]>();
  const ledger = ledgerRows ?? [];

  const plans = channels.flatMap((channel) =>
    planChannel(channel, blindspotBundles, topBundles, fresh, health, ledger, nowMs),
  );

  if (cfg.dryRun) {
    return NextResponse.json({
      dryRun: true,
      previews: plans.map((p) => ({
        channel: p.channel,
        kind: p.kind,
        clusterId: p.clusterId,
        text: p.text,
      })),
    });
  }

  const results = await Promise.all(
    channels.map((channel) =>
      runChannel(
        channel,
        plans.filter((p) => p.channel === channel),
        supabase,
        cfg.telegram,
        cfg.bluesky,
      ),
    ),
  );

  let posted = 0;
  const skipped: Record<string, number> = {};
  for (const result of results) {
    posted += result.posted;
    for (const [reason, count] of Object.entries(result.skipped)) {
      skipped[reason] = (skipped[reason] ?? 0) + count;
    }
  }

  return NextResponse.json({ ok: true, posted, skipped });
});
