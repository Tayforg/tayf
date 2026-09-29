// Story thread loading skeleton. Provides the Suspense boundary for PPR.

export default function StoryThreadLoading() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl space-y-8">
      <div className="space-y-3">
        <div className="h-3 w-28 rounded bg-muted/40 animate-pulse" />
        <div className="h-8 w-3/4 rounded bg-muted/60 animate-pulse" />
        <div className="h-3 w-56 rounded bg-muted/30 animate-pulse" />
      </div>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-3">
          <div className="h-5 w-40 rounded bg-muted/60 animate-pulse" />
          <div className="h-2 w-full rounded bg-muted/40 animate-pulse" />
          <div className="h-4 w-2/3 rounded bg-muted/40 animate-pulse" />
        </div>
      ))}
    </div>
  );
}
