import Link from "next/link";

// Small pill on /cluster/[id] pointing at the published "Gelişen hikaye"
// thread this cluster belongs to. Tailwind classes are literal so the JIT
// picks them up.
export function ThreadLink({ slug, title }: { slug: string; title: string }) {
  return (
    <Link
      href={`/hikaye/${slug}`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <span className="shrink-0 font-medium text-foreground">Bu hikayenin devamı</span>
      <span aria-hidden="true">·</span>
      <span className="truncate">{title}</span>
      <span aria-hidden="true">→</span>
    </Link>
  );
}
