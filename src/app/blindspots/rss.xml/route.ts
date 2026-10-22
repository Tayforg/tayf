import { connection } from "next/server";

import { blindspotsFeedResponse } from "@/lib/feeds/blindspots-feed";

// GET /blindspots/rss.xml — the roadmap URL for the blindspots feed. Same
// implementation as /rss/kor-noktalar.xml (src/lib/feeds/blindspots-feed.ts),
// so the two cannot drift; only the atom:link self URL differs. Not
// prerendered: a transient read failure must surface as a 503, not be baked
// into the build.
export async function GET(): Promise<Response> {
  await connection();
  return blindspotsFeedResponse("/blindspots/rss.xml");
}
