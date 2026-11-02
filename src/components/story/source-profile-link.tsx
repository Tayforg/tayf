import Link from "next/link";

import { isValidSourceSlug } from "@/lib/validation/source-input";

/**
 * `<SourceProfileLink>` - Server Component that renders a source name as an
 * internal link to that outlet's profile (`/source/<slug>`, the per-outlet
 * bias karne). Used by the cluster page's "Kaynak künyesi" rows so a reader
 * can reach an outlet's profile from the story where it appears.
 *
 * Behavior:
 *   - Valid slug -> `<Link href="/source/<slug>" prefetch={false}>`. Same tab
 *     (no target/rel). `prefetch={false}` because a large cluster lists dozens
 *     of sources and `/source/*` is DB-backed.
 *   - Missing/invalid slug -> plain `<span>` with the same text classes, so we
 *     never link a slug the profile route rejects. The gate is
 *     `isValidSourceSlug`, the same one `getSourceProfile` applies.
 *   - Blank name -> renders nothing.
 *
 * The accessible name is the visible source name: no aria-label / title.
 * Tailwind classes are literal strings so the JIT picks them up.
 */

/** Profile URL for `slug`, or null when the profile route would reject it. */
export function sourceProfileHref(slug: unknown): string | null {
  return isValidSourceSlug(slug) ? `/source/${slug}` : null;
}

export const SOURCE_PROFILE_LINK_CLASS =
  "inline-flex items-center max-sm:min-h-11 rounded-sm font-mono text-[10px] uppercase tracking-wider text-foreground/80 underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const SOURCE_NAME_TEXT_CLASS =
  "font-mono text-[10px] uppercase tracking-wider text-foreground/80";

export function SourceProfileLink({
  slug,
  name,
}: {
  slug: string | null | undefined;
  name: string;
}) {
  if (typeof name !== "string" || name.trim() === "") return null;

  const href = sourceProfileHref(slug);
  if (href === null) {
    return <span className={SOURCE_NAME_TEXT_CLASS}>{name}</span>;
  }

  return (
    <Link href={href} prefetch={false} className={SOURCE_PROFILE_LINK_CLASS}>
      {name}
    </Link>
  );
}
