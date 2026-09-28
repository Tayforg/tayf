// Env-var reader for the owned-channels auto-poster (Telegram + Bluesky).
// Never logs a value — every call site that needs to report "no channels
// configured" reports the ABSENCE, never the (possibly-still-partial)
// contents.

/** The two channels the auto-poster can post to. Mirrored by migration
 * 079's `social_posts.channel` check constraint — pinned in
 * tests/migrations/079-social-posts.test.ts. */
export const SOCIAL_CHANNELS = ["telegram", "bluesky"] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];

export interface TelegramConfig {
  token: string;
  chatId: string;
}

export interface BlueskyConfig {
  handle: string;
  appPassword: string;
  service: string;
}

export interface SocialConfig {
  disabled: boolean;
  dryRun: boolean;
  telegram: TelegramConfig | null;
  bluesky: BlueskyConfig | null;
}

const DEFAULT_BLUESKY_SERVICE = "https://bsky.social";

function nonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.length > 0;
}

export function readSocialConfig(
  env: Record<string, string | undefined> = process.env,
): SocialConfig {
  const telegram =
    nonEmpty(env.TELEGRAM_BOT_TOKEN) && nonEmpty(env.TELEGRAM_CHANNEL_ID)
      ? { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHANNEL_ID }
      : null;

  const bluesky =
    nonEmpty(env.BLUESKY_HANDLE) && nonEmpty(env.BLUESKY_APP_PASSWORD)
      ? {
          handle: env.BLUESKY_HANDLE,
          appPassword: env.BLUESKY_APP_PASSWORD,
          service: env.BLUESKY_SERVICE_URL?.startsWith("https://")
            ? env.BLUESKY_SERVICE_URL
            : DEFAULT_BLUESKY_SERVICE,
        }
      : null;

  return {
    disabled: env.SOCIAL_POST_DISABLED === "1",
    dryRun: env.SOCIAL_POST_DRY_RUN === "1",
    telegram,
    bluesky,
  };
}
