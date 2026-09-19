// Suspense boundary for the admin finance page (session cookie read +
// live view queries make the whole segment dynamic).

export default function AdminEkonomiLoading() {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 space-y-4">
      <div className="h-4 w-40 bg-muted/60 animate-pulse" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-20 rounded-xl bg-muted/20 animate-pulse" />
        ))}
      </div>
      <div className="h-10 border border-border bg-muted/10 animate-pulse" />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="h-[420px] border border-border bg-muted/10 animate-pulse" />
        <div className="h-[420px] border border-border bg-muted/10 animate-pulse" />
      </div>
    </div>
  );
}
