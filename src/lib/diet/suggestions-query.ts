import { getPoliticsClusters } from "@/lib/clusters/politics-query";
import { pickZoneSuggestions, type ZoneSuggestions } from "./suggestions";
import { DIET_ZONES } from "./diet";

/**
 * Loads the per-zone "least-read nudge" suggestion lists from the same
 * cached politics feed the homepage uses. `getPoliticsClusters` retries
 * once live and then throws on a sustained outage; this catch degrades
 * that to `null` (no suggestions).
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
