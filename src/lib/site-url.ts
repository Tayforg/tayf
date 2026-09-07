/**
 * Public site origin, no trailing slash. Mirrors the fallback chain already
 * used for `metadata.metadataBase` in `src/app/layout.tsx`: explicit env var
 * first, then Vercel's auto-populated production URL, then localhost for
 * local dev. Routes that build absolute links (newsletter confirm/unsubscribe
 * mails, the digest cron) should call this instead of re-deriving the origin.
 */
export function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000")
  );
}
