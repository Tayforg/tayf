// sources-weight: the <Suspense> fallback of /sources while the weekly counts
// stream in (see SourceDirectoryWithCounts in page.tsx).
//
// It used to be a second, full <SourceDirectory> with placeholder count labels,
// so the HTML carried the 118-card directory twice (1.29 MB, 236 /source/ links
// on 2026-11-01). This placeholder holds no data, no links and no images: a few
// grey cards that reserve roughly the height of the first rows, so the footer
// does not jump when the real directory replaces it.
//
// Server component, no data imports. Literal Tailwind class strings only, and
// no text colour classes (nothing here is text a reader has to read).

export const SOURCE_SKELETON_CARDS = 8;

const CARD_INDEXES = Array.from({ length: SOURCE_SKELETON_CARDS }, (_, i) => i);

export function SourceDirectorySkeleton() {
  return (
    <div className="min-h-[60vh] space-y-3">
      {/* One polite announcement for assistive tech; the grey boxes below are
          decoration and stay hidden from it. */}
      <p role="status" className="sr-only">
        Kaynak listesi yükleniyor…
      </p>
      <section aria-hidden="true" className="space-y-3">
        <div className="h-6 w-40 rounded bg-muted/60 motion-safe:animate-pulse" />
        {/* Same grid classes as SourceDirectory, so the columns do not shift. */}
        <div className="grid grid-cols-1 min-[480px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {CARD_INDEXES.map((i) => (
            <div
              key={i}
              data-skeleton-card=""
              className="rounded-xl ring-1 ring-border/60 bg-card/60 p-4"
            >
              <div className="flex items-start gap-3">
                <div className="h-8 w-8 rounded shrink-0 bg-muted/60" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-3/4 rounded bg-muted/60" />
                  <div className="h-3 w-1/2 rounded bg-muted/40" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
