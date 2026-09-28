// De-duplicates the owner-group label and the free-text `ownership` string
// on the LabelCard owner line. Without this, a tagged owner like
// `can-holding` shows its group label ("Can Holding (TMSF kayyum,
// 11.09.2025)") immediately followed by an `ownership` string that repeats
// "Can Holding" (and, with the trustee badge below it, repeats "kayyum" a
// third time).

const TRAILING_PAREN = /\s*\([^()]*\)\s*$/;
const TRAILING_KAYYUM_PAREN = /\s*\([^()]*kayyum[^()]*\)\s*$/i;

function stripTrailingKayyumParen(s: string): string {
  return s.replace(TRAILING_KAYYUM_PAREN, "").trim();
}

function stripTrailingParen(s: string): string {
  return s.replace(TRAILING_PAREN, "").trim();
}

export function ownerLineParts({
  groupLabel,
  ownership,
  hasTrusteeBadge,
}: {
  groupLabel: string;
  ownership?: string | null;
  hasTrusteeBadge: boolean;
}): { primary: string; secondary: string | null } {
  const strip = (s: string) => (hasTrusteeBadge ? stripTrailingKayyumParen(s) : s.trim());
  const group = strip(groupLabel);
  const own = ownership ? strip(ownership) : "";

  if (!own) return { primary: group, secondary: null };

  const base = stripTrailingParen(group);
  if (own === group || (base !== "" && own.startsWith(base))) {
    return { primary: own, secondary: null };
  }
  return { primary: group, secondary: own };
}
