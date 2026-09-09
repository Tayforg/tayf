"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatsGrid } from "@/components/admin/stats-grid";
import { WorkerStats } from "@/components/admin/worker-stats";
import { QuickActionsCard } from "@/components/admin/quick-actions-card";
import { SourceRow, type SourceItem } from "@/components/admin/source-row";
import { SourceDialog } from "@/components/admin/source-dialog";
import {
  ActionResultBanner,
  type ActionResult,
} from "@/components/admin/action-result-banner";
import { RefreshCw, Loader2, Plus, LogOut } from "lucide-react";
import { logoutAction } from "@/app/admin/login/actions";

interface Stats {
  articles: number;
  sources: number;
  clusters: number;
  missingImages: number;
  sourcesList: SourceItem[];
}

const EMPTY_SOURCE: SourceItem = {
  id: "",
  name: "",
  slug: "",
  url: "",
  rss_url: "",
  bias: "center",
  active: true,
};

export function AdminPanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ActionResult | null>(null);

  // Source dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"add" | "edit">("add");
  const [editSource, setEditSource] = useState<SourceItem>(EMPTY_SOURCE);

  // Promise-chained (not async/await): react-hooks/set-state-in-effect
  // flags a function that directly calls a setState setter as part of its
  // own synchronous body when that function is invoked from an effect —
  // which async/await bodies do (the setState calls sit in the same
  // function, just after an `await`). Nesting the setState calls inside
  // `.then()`/`.finally()` callbacks keeps this a genuine "sync external
  // system with an effect" pattern (per
  // https://react.dev/learn/you-might-not-need-an-effect#fetching-data)
  // without changing resolution order, error handling, or the
  // `Promise<void>` return type `await fetchStats()` callers below rely on.
  const fetchStats = useCallback(() => {
    return fetch("/api/admin")
      .then((res) => res.json())
      .then((data) => setStats(data))
      .catch(() => {
        // ignore
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  async function runAction(
    action: string,
    extraBody?: Record<string, unknown>
  ) {
    setActionLoading(action);
    setLastResult(null);
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extraBody }),
      });
      const data = await res.json();
      setLastResult(data);
      await fetchStats();
    } catch (e: unknown) {
      setLastResult({
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setActionLoading(null);
    }
  }

  function confirmAndRun(action: string, label: string) {
    if (window.confirm(`${label}\n\nBu işlem geri alınamaz. Emin misiniz?`)) {
      runAction(action);
    }
  }

  function openAddDialog() {
    setEditSource(EMPTY_SOURCE);
    setDialogMode("add");
    setDialogOpen(true);
  }

  function openEditDialog(source: SourceItem) {
    setEditSource({ ...source });
    setDialogMode("edit");
    setDialogOpen(true);
  }

  async function handleSaveSource() {
    const action = dialogMode === "add" ? "add_source" : "update_source";
    setActionLoading("save_source");
    setLastResult(null);

    // Auto-generate slug from name if empty
    const slug =
      editSource.slug ||
      editSource.name
        .toLowerCase()
        .replace(/[şŞ]/g, "s")
        .replace(/[çÇ]/g, "c")
        .replace(/[ğĞ]/g, "g")
        .replace(/[üÜ]/g, "u")
        .replace(/[öÖ]/g, "o")
        .replace(/[ıİ]/g, "i")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...editSource, slug }),
      });
      const data = await res.json();
      setLastResult(data);
      if (data.success) {
        setDialogOpen(false);
        await fetchStats();
      }
    } catch (e: unknown) {
      setLastResult({
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setActionLoading(null);
    }
  }

  function handleDeleteSource(source: SourceItem) {
    if (
      window.confirm(
        `"${source.name}" kaynağı ve tüm haberleri silinecek.\n\nEmin misiniz?`
      )
    ) {
      runAction("delete_source", { id: source.id });
    }
  }

  function handleToggleSource(source: SourceItem) {
    runAction("toggle_source", { slug: source.slug, active: !source.active });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 sm:px-6 py-8 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold font-serif">Admin Panel</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Dev tools for testing and managing Tayf
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchStats}
            className="text-xs"
          >
            <RefreshCw className="h-3 w-3 mr-1.5" />
            Yenile
          </Button>
          <form action={logoutAction}>
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
            >
              <LogOut className="h-3 w-3 mr-1.5" />
              Çıkış
            </Button>
          </form>
        </div>
      </div>

      <div className="mb-4">
        <WorkerStats />
      </div>

      <StatsGrid
        articles={stats?.articles ?? 0}
        sources={stats?.sources ?? 0}
        clusters={stats?.clusters ?? 0}
        missingImages={stats?.missingImages ?? 0}
      />

      {lastResult && <ActionResultBanner result={lastResult} />}

      <QuickActionsCard
        missingImages={stats?.missingImages ?? 0}
        actionLoading={actionLoading}
        onRun={runAction}
        onConfirmAndRun={confirmAndRun}
      />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-serif">Kaynaklar</CardTitle>
            <Button size="sm" className="text-xs h-7" onClick={openAddDialog}>
              <Plus className="h-3 w-3 mr-1" />
              Kaynak Ekle
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {stats?.sourcesList.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                actionLoading={actionLoading}
                onEdit={openEditDialog}
                onToggle={handleToggleSource}
                onDelete={handleDeleteSource}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <SourceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={dialogMode}
        source={editSource}
        onChange={setEditSource}
        onSave={handleSaveSource}
        saving={actionLoading === "save_source"}
      />
    </div>
  );
}
