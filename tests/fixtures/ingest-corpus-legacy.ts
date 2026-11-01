// Frozen copy of the pre-hunt-11 text fingerprinting (A-ingest-cpu), taken
// verbatim from supabase/functions/_shared/cluster/fingerprint.ts BEFORE the
// hot-path rewrite (one regex replace for the diacritic fold, one
// normalisation per strictFingerprint). `articles.content_hash` is stored and
// deduplicated on, so the rewrite must stay byte-identical:
// tests/functions/_shared/ingest-corpus-equality.test.ts runs the live
// implementation against this copy over tests/fixtures/ingest-corpus.json.
//
// Do not "improve" anything in here. If the live behaviour is ever meant to
// change, that is a content_hash migration, not an edit to this file.

import { createHash } from "node:crypto";

const DIACRITIC_MAP: Record<string, string> = {
  ş: "s", Ş: "s",
  ı: "i", İ: "i", I: "i",
  ü: "u", Ü: "u",
  ö: "o", Ö: "o",
  ç: "c", Ç: "c",
  ğ: "g", Ğ: "g",
  â: "a", Â: "a",
  î: "i", Î: "i",
  û: "u", Û: "u",
};

const STOP_WORDS: Set<string> = new Set([
  "ve", "ile", "bir", "bu", "da", "de", "ki", "mi", "mı", "mu", "mü",
  "o", "ne", "için", "icin", "ama", "fakat", "ancak", "ya", "ya da",
  "ise", "gibi", "kadar", "daha", "çok", "cok", "az", "en", "her",
  "hiç", "hic", "bazı", "bazi", "olan", "olarak", "var", "yok",
  "oldu", "olduğu", "oldugu", "olan", "olması", "olmasi",
  "değil", "degil", "şu", "su", "o", "ben", "sen", "biz", "siz",
  "onlar", "şey", "sey", "yine", "de", "da", "te", "ta",
  "son", "dakika", "haber", "haberler",
]);

export function normalizeTurkish(text: string | null | undefined): string {
  if (!text) return "";
  let out = "";
  for (const ch of text) {
    out += DIACRITIC_MAP[ch] ?? ch;
  }
  out = out.toLowerCase();
  out = out.replace(/[^a-z0-9\s]/g, " ");
  const tokens = out
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => {
      if (!t) return false;
      if (STOP_WORDS.has(t)) return false;
      if (t.length < 2 && !/^\d$/.test(t)) return false;
      return true;
    });
  return tokens.join(" ");
}

export function shingleSet(
  title: string | null | undefined,
  description: string | null | undefined,
  n = 4,
): Set<string> {
  const norm = normalizeTurkish(`${title || ""} ${description || ""}`);
  const shingles = new Set<string>();
  if (!norm) return shingles;
  if (norm.length < n) {
    shingles.add(norm);
    return shingles;
  }
  for (let i = 0; i <= norm.length - n; i++) {
    shingles.add(norm.slice(i, i + n));
  }
  return shingles;
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export function strictFingerprint(
  title: string | null | undefined,
  description: string | null | undefined,
): string | null {
  const norm = normalizeTurkish(`${title || ""} ${description || ""}`);
  if (!norm) return null;
  const shingles = shingleSet(title, description, 4);
  if (shingles.size === 0) return sha1(norm);
  const sorted = [...shingles].sort().join("|");
  return sha1(sorted);
}
