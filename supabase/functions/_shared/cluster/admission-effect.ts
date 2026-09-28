// Politics-admission editorial-effect helper (migration 089, "ADMIT").
// Answers "what did adding this one source do to the cluster's blindspot
// verdict and zone coverage?" -- used only to fill the `jev_politics_admissions`
// bookkeeping row (blindspot_before/after, zone_added) recorded by
// cluster-consumer's recordAdmission(). Never imported by src/ -- Deno/vitest
// only, same discipline as the rest of _shared/cluster/*.

import { detectBlindspot, BIAS_TO_ZONE, type BiasKey } from "./blindspot.ts";
import { votingBiasKeys } from "./source-kind.ts";

export interface AdmissionEffect {
  blindspotBefore: boolean;
  blindspotAfter: boolean;
  zoneAdded: boolean;
}

type Voter = { bias: BiasKey | null; kind?: unknown } | null | undefined;

function buildBiasDistribution(biasLabels: BiasKey[]): Partial<Record<BiasKey, number>> {
  const dist: Partial<Record<BiasKey, number>> = {};
  for (const b of biasLabels) {
    dist[b] = (dist[b] ?? 0) + 1;
  }
  return dist;
}

export function admissionEffect(
  before: ReadonlyArray<Voter>,
  added: Voter,
): AdmissionEffect {
  const beforeVotes = votingBiasKeys(before);
  const blindspotBefore = detectBlindspot(buildBiasDistribution(beforeVotes)).is_blindspot;

  const addedVotes = votingBiasKeys([added]);
  const afterVotes = [...beforeVotes, ...addedVotes];
  const blindspotAfter = detectBlindspot(buildBiasDistribution(afterVotes)).is_blindspot;

  let zoneAdded = false;
  if (addedVotes.length > 0) {
    const addedZone = BIAS_TO_ZONE[addedVotes[0] as BiasKey];
    const beforeZones = new Set(beforeVotes.map((b) => BIAS_TO_ZONE[b]));
    zoneAdded = !beforeZones.has(addedZone);
  }

  return { blindspotBefore, blindspotAfter, zoneAdded };
}
