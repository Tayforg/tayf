import { connection } from "next/server";

import { ALLOW_GET_ONLY, apiMethodNotAllowed, apiOptionsAllow } from "@/lib/api/errors";
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

// Every other method gets the JSON 405 with `Allow` (RFC 9110 15.5.6) instead of
// Next's bodyless default, and OPTIONS is explicit: without it Next's automatic
// OPTIONS would advertise POST, PUT, PATCH and DELETE. HEAD is derived from GET.
// The refusals read no request state and open no connection, so the GET keeps
// its own rendering mode.
const refuse = async () => apiMethodNotAllowed(ALLOW_GET_ONLY);
export const POST = refuse;
export const PUT = refuse;
export const PATCH = refuse;
export const DELETE = refuse;

export function OPTIONS(): Response {
  return apiOptionsAllow(ALLOW_GET_ONLY);
}
