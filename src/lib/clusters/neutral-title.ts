// Extractive neutral headline for a cluster: pick the member headline that
// sits closest to the centre of the cluster, penalise sensational framing,
// then strip the outlet's house-style markers from it.
//
// This is the zero-cost fallback the headline cron uses when no LLM key is
// configured. It never invents text, so it can't hallucinate — the price is
// that it is one outlet's wording with the framing sanded off, not a
// synthesis. The LLM path overwrites it when enabled.

// Written to clusters.title_neutral_model so readers can tell an extractive
// pick from an LLM rewrite. Bump the suffix when the selection or cleaning
// rules change in a way that alters output.
export const EXTRACTIVE_MODEL_ID = "extractive-v1";

export interface MemberTitle {
  title: string;
  source?: string | null;
}

const DIACRITICS: Record<string, string> = {
  ş: "s", ı: "i", ü: "u", ö: "o", ç: "c", ğ: "g", â: "a", î: "i", û: "u",
};

const STOP = new Set([
  "ve", "ile", "bir", "bu", "da", "de", "ki", "icin", "ama", "gibi", "kadar",
  "daha", "cok", "olan", "olarak", "var", "yok", "oldu", "dedi", "son", "dakika",
  "haber", "haberi", "sonra", "once", "iste", "icin",
]);

function tokens(title: string): Set<string> {
  let s = "";
  // Locale-aware lowercasing matches cleanHeadline's toLocaleUpperCase("tr")
  // below: plain toLowerCase() turns "İ" into "i" + a combining dot-above
  // (U+0307) instead of "i", which the a-z0-9 filter then strips, silently
  // corrupting tokens for any title starting a word with a dotted capital I.
  for (const ch of title.toLocaleLowerCase("tr")) s += DIACRITICS[ch] ?? ch;
  const out = new Set<string>();
  for (const t of s.replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Each hit is one unit of "this outlet is selling, not reporting".
const FRAMING: RegExp[] = [
  /!/,
  /\?/,
  /son\s*dakika/i,
  /\b(flaş|flas|canlı|canli)\b/i,
  /\b(bomba|şok|sok|skandal|rezalet|çarpıcı|carpici|olay|dev|kritik|müjde|mujde)\b/i,
  /dikkat çeken|dikkat ceken|işte o|iste o|işte detaylar|iste detaylar|bakın|bakin/i,
  /\bbaşkan erdoğan\b/i, // A Haber / Sabah house style for the president
  /\b[A-ZÇĞİÖŞÜ]{4,}\b/, // shouted words
  /\|/, // "Outlet | headline" prefixes
  /\.\.\.$/,
];

function framingPenalty(title: string): number {
  let n = 0;
  for (const re of FRAMING) if (re.test(title)) n++;
  return n;
}

export function cleanHeadline(title: string): string {
  let t = title.trim();
  // Outlet prefixes and "Son dakika" lead-ins.
  t = t.replace(/^[^|│]{0,25}[|│]\s*/, "");
  t = t.replace(/^(son\s*dakika|flaş|flas|canlı|canli)\s*[!:.…|│\-–—]*\s*/i, "");
  t = t.replace(/^(son\s*dakika|flaş|flas)\s*[!:.…|│\-–—]*\s*/i, "");
  // House style.
  t = t.replace(/\bBaşkan Erdoğan\b/g, "Cumhurbaşkanı Erdoğan");
  // Exclamation marks: sentence break inside, dropped at the end.
  t = t.replace(/!+\s+/g, ". ").replace(/!+$/g, "");
  // Trailing ellipsis / colon / dash.
  t = t.replace(/[\s.:…\-–—]+$/g, "");
  // Wrapping quotes around the whole headline.
  t = t.replace(/^["'“‘](.+)["'”’]$/, "$1");
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > 0) t = t[0]!.toLocaleUpperCase("tr") + t.slice(1);
  return t;
}

/**
 * Returns the cleaned headline of the most central, least sensational
 * member, or null when there is nothing to choose from.
 */
export function pickNeutralTitle(members: MemberTitle[]): string | null {
  const items = members
    .map((m) => ({ ...m, title: (m.title ?? "").trim() }))
    .filter((m) => m.title.length > 0);
  if (items.length === 0) return null;

  const toks = items.map((m) => tokens(m.title));
  let best = -Infinity;
  let bestIdx = 0;
  for (let i = 0; i < items.length; i++) {
    let sim = 0;
    for (let j = 0; j < items.length; j++) if (j !== i) sim += jaccard(toks[i]!, toks[j]!);
    const centrality = items.length > 1 ? sim / (items.length - 1) : 0;
    const len = items[i]!.title.length;
    const score =
      centrality - 0.12 * framingPenalty(items[i]!.title) - 0.002 * Math.max(0, len - 90);
    if (score > best) {
      best = score;
      bestIdx = i;
    }
  }

  const cleaned = cleanHeadline(items[bestIdx]!.title);
  // A headline that lost most of itself to cleaning wasn't a headline.
  return cleaned.length >= 20 ? cleaned : items[bestIdx]!.title;
}
