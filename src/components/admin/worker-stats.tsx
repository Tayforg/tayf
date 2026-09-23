"use client";

import { useEffect, useState } from "react";
import { Activity, Newspaper, Layers, Image as ImageIcon } from "lucide-react";

interface Metrics {
  timestamp: string;
  articles: {
    total: number;
    last24h: number;
    lastHour: number;
    politicsNullImage: number;
    withImage: number;
  };
  clusters: {
    total: number;
    multiArticle: number;
    blindspots: number;
    avgArticlesPerCluster: number;
  };
  sources: { total: number; active: number };
}

export function WorkerStats() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchMetrics() {
      try {
        const res = await fetch("/api/metrics", { cache: "no-store" });
        if (!res.ok) return;
        const data: Metrics = await res.json();
        if (!cancelled) setMetrics(data);
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchMetrics();
    // Refresh every 60s. Each tick hits /api/metrics which runs ~10
    // parallel count(*) queries against Supabase — at 15s that burned
    // ~2.4k queries/hour while /admin sat open in a tab. 60s cuts it to
    // 600/h without meaningfully degrading the admin feel (these are
    // slow-moving totals, not live counters).
    const interval = setInterval(fetchMetrics, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading || !metrics) {
    return (
      <div className="rounded-xl border border-border/60 bg-card/40 p-4 space-y-3 animate-pulse">
        <div className="h-3 w-32 rounded bg-muted/60" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 rounded bg-muted/40" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 text-emerald-500" />
          Canlı metrikler (60 sn&apos;de bir yenilenir)
        </h3>
        <span className="text-xs text-muted-foreground">
          {new Date(metrics.timestamp).toLocaleTimeString("tr-TR")}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatBox icon={Newspaper} label="Haber (toplam)" value={metrics.articles.total} />
        <StatBox icon={Newspaper} label="Son 1 saat" value={metrics.articles.lastHour} tone="emerald" />
        <StatBox icon={Layers} label="Kümeler" value={metrics.clusters.multiArticle} />
        <StatBox icon={ImageIcon} label="Görselsiz" value={metrics.articles.politicsNullImage} tone="amber" />
      </div>
    </div>
  );
}

function StatBox({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  tone?: "default" | "emerald" | "amber";
}) {
  const toneClass =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "amber"
      ? "text-amber-600 dark:text-amber-400"
      : "text-foreground";
  return (
    <div className="rounded-lg bg-muted/40 border border-border/40 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <p className={`text-xl font-bold tabular-nums mt-1 ${toneClass}`}>
        {value.toLocaleString("tr-TR")}
      </p>
    </div>
  );
}
