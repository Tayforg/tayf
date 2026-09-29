"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { EmptyState, StatusBadge } from "@/components/admin/admin-ui";
import { fmtDateTime } from "@/lib/admin/format";
import type { AdminClusterRef, AdminThread, ThreadCandidate } from "@/lib/story-threads/admin-query";

/**
 * Admin controls for /admin/hikayeler (migration 098): approve/reject the
 * nightly proposed cluster pairs (POST /api/admin/story-threads/candidates)
 * and edit threads (POST /api/admin/story-threads/thread). Modeled on
 * api-webhooks-actions.tsx: the server's response text is never shown, only
 * the fixed Turkish lines below. Nothing publishes without the explicit
 * "Yayınla" press.
 */

const GENERIC_ERROR = "İşlem başarısız, tekrar deneyin.";
const APPROVE_409 = "Bu iki küme farklı hikayelerde; önce birinden çıkarın.";
const PUBLISH_409 = "Yayınlamak için başlık ve en az 3 küme gerekir.";

const BTN = "h-9 sm:h-7 px-3 text-xs";

function useAdminPost() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function post(url: string, body: unknown, conflictMessage: string, onOk?: () => void) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setError(res.status === 409 ? conflictMessage : GENERIC_ERROR);
          return;
        }
        onOk?.();
        router.refresh();
      } catch {
        setError(GENERIC_ERROR);
      }
    });
  }

  return { isPending, error, post };
}

function ClusterSide({ c }: { c: AdminClusterRef }) {
  return (
    <div className="min-w-0 space-y-1 text-sm">
      <a
        href={`/cluster/${c.id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium hover:underline underline-offset-2"
      >
        {c.title}
      </a>
      <p className="text-xs text-muted-foreground">
        {fmtDateTime(c.firstPublished)} · {c.articleCount} haber
      </p>
      {c.thread && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Hikayede: {c.thread.title ?? "Taslak"}
        </p>
      )}
    </div>
  );
}

export function StoryThreadCandidates({ candidates }: { candidates: ThreadCandidate[] }) {
  const { isPending, error, post } = useAdminPost();

  function act(id: number, action: "approve" | "reject") {
    post("/api/admin/story-threads/candidates", { id, action }, APPROVE_409);
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-destructive">{error}</p>}
      {candidates.length === 0 ? (
        <EmptyState>Bekleyen aday yok.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {candidates.map((c) => (
            <li key={c.id} className="space-y-3 rounded-lg border border-border/60 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone="neutral">Güven %{Math.round(c.confidence * 100)}</StatusBadge>
                <span className="text-xs text-muted-foreground">{c.hoursApart} sa arayla</span>
                {c.sharedTerms.map((t) => (
                  <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs">
                    {t}
                  </span>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <ClusterSide c={c.a} />
                <ClusterSide c={c.b} />
              </div>
              <div className="flex gap-2">
                <Button type="button" size="sm" className={BTN} disabled={isPending} onClick={() => act(c.id, "approve")}>
                  Onayla
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`${BTN} text-destructive/60 hover:text-destructive`}
                  disabled={isPending}
                  onClick={() => act(c.id, "reject")}
                >
                  Reddet
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThreadCard({ thread }: { thread: AdminThread }) {
  const { isPending, error, post } = useAdminPost();
  const [title, setTitle] = useState(thread.title ?? "");
  const published = thread.status === "published";
  const url = "/api/admin/story-threads/thread";

  return (
    <li className="space-y-3 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={published ? "ok" : "muted"}>{published ? "Yayında" : "Taslak"}</StatusBadge>
        {published && thread.slug && (
          <a href={`/hikaye/${thread.slug}`} className="text-xs underline underline-offset-2">
            /hikaye/{thread.slug}
          </a>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          post(url, { threadId: thread.id, action: "rename", title }, GENERIC_ERROR);
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Başlık
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isPending}
            placeholder={thread.suggestedTitle}
            maxLength={140}
            className="h-9 w-80 max-w-full rounded-lg border border-border/60 bg-background px-2 text-sm disabled:opacity-50"
          />
        </label>
        <Button type="submit" size="sm" variant="secondary" className={BTN} disabled={isPending}>
          Başlığı kaydet
        </Button>
        <Button
          type="button"
          size="sm"
          className={BTN}
          disabled={isPending}
          onClick={() =>
            post(url, { threadId: thread.id, action: published ? "unpublish" : "publish" }, PUBLISH_409)
          }
        >
          {published ? "Yayından kaldır" : "Yayınla"}
        </Button>
      </form>

      <ul className="space-y-2">
        {thread.members.map((m) => (
          <li key={m.id} className="flex items-start justify-between gap-2">
            <ClusterSide c={{ ...m, thread: null }} />
            {!published && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={`${BTN} text-destructive/60 hover:text-destructive`}
                disabled={isPending}
                onClick={() =>
                  post(url, { threadId: thread.id, action: "remove_member", clusterId: m.id }, GENERIC_ERROR)
                }
              >
                Çıkar
              </Button>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function StoryThreadCards({ threads }: { threads: AdminThread[] }) {
  if (threads.length === 0) return <EmptyState>Henüz hikaye yok.</EmptyState>;
  return (
    <ul className="space-y-3">
      {threads.map((t) => (
        <ThreadCard key={t.id} thread={t} />
      ))}
    </ul>
  );
}
