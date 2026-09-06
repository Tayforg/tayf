import { track as vercelTrack } from "@vercel/analytics";

export type TrackEvent = "share" | "bookmark" | "cta_other_side" | "outbound" | "search";
export type TrackZone = "iktidar" | "bagimsiz" | "muhalefet";

// Fixed-vocabulary props only — never free text (no queries, titles, URLs).
export type TrackProps = { zone?: TrackZone; clusterId?: string; kind?: string };

// No-op on the server; swallows client errors so analytics can never break the UI.
export function track(event: TrackEvent, props?: TrackProps): void {
  if (typeof window === "undefined") return;
  try {
    vercelTrack(event, props);
  } catch {
    // ignore
  }
}
