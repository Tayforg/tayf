// Sources directory loading skeleton for PPR.

export default function SourcesLoading() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl space-y-6">
      <div className="space-y-2">
        <div className="h-4 w-40 rounded bg-muted/60 animate-pulse" />
        <div className="h-8 w-36 rounded bg-muted/60 animate-pulse" />
        <div className="h-4 w-72 rounded bg-muted/40 animate-pulse" />
      </div>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="space-y-3">
          <div className="h-6 w-40 rounded bg-muted/60 animate-pulse" />
          <div className="grid grid-cols-1 min-[480px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {Array.from({ length: 4 }, (_, j) => (
              <div
                key={j}
                className="rounded-xl ring-1 ring-border/60 bg-card/60 p-4 space-y-2"
              >
                <div className="flex items-start gap-3">
                  <div className="h-8 w-8 rounded shrink-0 bg-muted/40 animate-pulse" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-4 w-3/4 rounded bg-muted/60 animate-pulse" />
                    <div className="h-4 w-16 rounded-full bg-muted/40 animate-pulse" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
