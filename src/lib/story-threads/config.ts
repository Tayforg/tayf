// "Gelişen hikaye" threads (migration 098). Pinned constants mirrored as
// literals in supabase/migrations/098_story_threads.sql and parity-tested by
// tests/migrations/098-story-threads.test.ts. Nothing is ever published
// automatically: the nightly job only PROPOSES cluster pairs.

export const STORY_THREAD_WINDOW_DAYS = 14;
export const STORY_THREAD_MIN_ARTICLES = 3;
export const STORY_THREAD_MAX_HOURS_APART = 72;
export const STORY_THREAD_TOP_TERMS = 5;
export const STORY_THREAD_MIN_SHARED_TERMS = 2;
export const STORY_THREAD_MIN_TERM_LEN = 4;
export const STORY_THREAD_DF_CAP_SHARE = 0.02;
export const STORY_THREAD_MIN_CONFIDENCE = 0.4;
export const STORY_THREAD_RUN_CAP = 500;
export const STORY_THREAD_MIN_PUBLISH_MEMBERS = 3;
export const STORY_THREAD_TITLE_MIN = 8;
export const STORY_THREAD_TITLE_MAX = 140;
/** UTC. 01:53 UTC = 04:53 TRT, a free slot. */
export const STORY_THREAD_CRON = "53 1 * * *";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Trimmed title, or null when not a string, out of 8..140 or has control chars. */
export function validateThreadTitle(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < STORY_THREAD_TITLE_MIN || t.length > STORY_THREAD_TITLE_MAX) return null;
  if (CONTROL_CHARS.test(t)) return null;
  return t;
}

const TR_MAP: Record<string, string> = {
  ç: "c", Ç: "c", ğ: "g", Ğ: "g", ı: "i", İ: "i", ö: "o", Ö: "o",
  ş: "s", Ş: "s", ü: "u", Ü: "u", â: "a", Â: "a", î: "i", Î: "i", û: "u", Û: "u",
};

export function threadSlug(title: string, id: string): string {
  const hex = id.replace(/-/g, "").slice(0, 6).toLowerCase();
  const translit = title.replace(/[çÇğĞıİöÖşŞüÜâÂîÎûÛ]/g, (ch) => TR_MAP[ch] ?? ch);
  const base = translit
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  if (base.length < 3) return `hikaye-${hex}`;
  return `${base}-${hex}`;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidThreadSlug(s: unknown): s is string {
  return typeof s === "string" && s.length >= 3 && s.length <= 80 && SLUG_RE.test(s);
}

/** Kill switch. Read OUTSIDE any "use cache" body. */
export function isStoryThreadsEnabled(): boolean {
  return process.env.STORY_THREADS !== "off";
}
