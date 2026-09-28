import { getPoliticsClusters } from "@/lib/clusters/politics-query";
import { pickZoneSuggestions, type ZoneSuggestions } from "./suggestions";
import { DIET_ZONES } from "./diet";

/**
 * Loads the per-zone "least-read nudge" suggestion lists from the same
 * cached politics feed the homepage uses. `getPoliticsClusters` never
 * throws (see src/lib/cache-resilience.ts) and already retries once
 * internally on failure — this try/catch is defence in depth only, kept
 * so a future change to that contract can't surface an unhandled
 * rejection here.
 */
export async function loadZoneSuggestions(): Promise<ZoneSuggestions | null> {
  try {
    const { bundles } = await getPoliticsClusters();
    const suggestions = pickZoneSuggestions(bundles);
    return DIET_ZONES.some((zone) => suggestions[zone].length > 0) ? suggestions : null;
  } catch (err) {
    console.warn("[diyetim] suggestions unavailable", err);
    return null;
  }
}
