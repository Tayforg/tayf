import type { Source } from "@/types";

// Projection of the source directory for the MediaDna chart.
//
// MediaDna is a Client Component, so every prop the cluster page hands it is
// serialised into the RSC payload that ships to the browser. The chart only
// reads five fields; sending the whole row would also ship url, rss_url,
// logo_url and active for every outlet in the directory (118+ rows) for
// nothing. The page therefore passes `toMediaDnaSources(allSources)`.
//
// This lives in its own plain module, not in media-dna.tsx: that file is a
// client module, and a Server Component that imports a function from a client
// module gets a client reference, not a callable function.

export type MediaDnaSource = Pick<Source, "id" | "name" | "slug" | "bias" | "kind">;

/** Narrows each source to the fields MediaDna reads, keeping order and count. */
export function toMediaDnaSources(sources: readonly Source[]): MediaDnaSource[] {
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    bias: s.bias,
    kind: s.kind,
  }));
}
