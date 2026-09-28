import { connection } from "next/server";

import { loadZoneSuggestions } from "@/lib/diet/suggestions-query";
import { LeastReadNudge } from "./least-read-nudge";

// Server component: fetches the (server-cached) per-zone suggestion lists
// and hands them, as plain data, to the client nudge — which picks the
// actual least-read zone from the device-local diet. `connection()` keeps
// a failed build-time fetch from freezing into the static shell (see
// blindspots/page.tsx for the same pattern); the page wraps this in
// <Suspense fallback={null}>.
export async function DietSuggestions() {
  await connection();
  const lists = await loadZoneSuggestions();
  return <LeastReadNudge lists={lists} />;
}
