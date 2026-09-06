import type { BiasDistribution } from "@/types";

const EMPTY_DISTRIBUTION: BiasDistribution = {
  pro_government: 0,
  gov_leaning: 0,
  state_media: 0,
  center: 0,
  opposition_leaning: 0,
  opposition: 0,
  nationalist: 0,
  islamist_conservative: 0,
  pro_kurdish: 0,
  international: 0,
};

export function emptyBiasDistribution(): BiasDistribution {
  return { ...EMPTY_DISTRIBUTION };
}
