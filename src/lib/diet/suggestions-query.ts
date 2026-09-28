import { getPoliticsClusters } from "@/lib/clusters/politics-query";
import { pickZoneSuggestions, type ZoneSuggestions } from "./suggestions";
import { DIET_ZONES } from "./diet";

/**
 * Loads the per-zone "least-read nudge" suggestion lists from the same
 * cached politics feed the homepage uses. `getPoliticsClusters` is
 * `"use cache"` and throws on failure rather than caching an empty result,
 * so this function is deliberately NOT itself `"use cache"` — it just
 * shields the nudge from ever surfacing a fetch error.
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
