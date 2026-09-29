// Pure, client-safe builder for the "Sitene ekle" embed snippet.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALT = "Tayf yelpazesi: bu haberi hangi medya bölgeleri yazdı";

export function buildEmbedSnippet(
  origin: string,
  clusterId: string,
): { html: string; markdown: string } | null {
  if (!UUID_RE.test(clusterId)) return null;
  const img = `${origin}/rozet/${clusterId}.svg`;
  const link = `${origin}/cluster/${clusterId}?utm_source=embed&utm_medium=badge&utm_campaign=cluster`;
  return {
    html: `<a href="${link.replace(/&/g, "&amp;")}"><img src="${img}" alt="${ALT}" width="320" height="48" loading="lazy"></a>`,
    markdown: `[![${ALT}](${img})](${link})`,
  };
}
