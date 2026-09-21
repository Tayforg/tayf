"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { ShareLinkRow } from "@/lib/reports/share";

/**
 * Admin controls for a cluster's Yelpaze Raporu share links (migration
 * 069, B9). Modeled on src/components/admin/corrections-actions.tsx:
 * useTransition, fetch, router.refresh() on success, and a generic
 * Turkish error that never echoes the server's response text (the
 * response body is a plain `{ error }` string anyway, but this component
 * has no auth logic of its own and shouldn't grow any — POST
 * /api/admin/rapor/share and /revoke are admin-session gated server-side).
 *
 * Only type-imports from "@/lib/reports/share" (never a value) — that
 * module reaches for `node:crypto`, which must not enter the client
 * bundle.
 */

interface CreateShareResponse {
  ok: true;
  token: string;
  url: string;
  expires_at: string;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Istanbul",
  });
}

function isActive(link: ShareLinkRow): boolean {
  return link.revoked_at === null && new Date(link.expires_at).getTime() > Date.now();
}

export function ReportSharePanel({
  clusterId,
  links,
}: {
  clusterId: string;
  links: ShareLinkRow[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState(false);
  const [justCreated, setJustCreated] = useState<CreateShareResponse | null>(null);

  const activeLinks = links.filter(isActive);

  function handleCreate() {
    setError(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/rapor/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cluster_id: clusterId }),
        });
        if (!res.ok) {
          setError(true);
          return;
        }
        const data = (await res.json()) as CreateShareResponse;
        setJustCreated(data);
        router.refresh();
      } catch {
        setError(true);
      }
    });
  }

  function handleRevoke(token: string) {
    if (!window.confirm("Bu paylaşım bağlantısı iptal edilecek. Emin misiniz?")) {
      return;
    }
    setError(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/rapor/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) {
          setError(true);
          return;
        }
        setJustCreated((prev) => (prev?.token === token ? null : prev));
        router.refresh();
      } catch {
        setError(true);
      }
    });
  }

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-card/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide">
          Etkin paylaşım bağlantıları
        </h2>
        <button
          type="button"
          onClick={handleCreate}
          disabled={isPending}
          className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:opacity-50"
        >
          {isPending ? "Oluşturuluyor…" : "Paylaşım bağlantısı oluştur (7 gün)"}
        </button>
      </div>

      {justCreated && (
        <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
          <code className="select-all">{justCreated.url}</code>
        </p>
      )}

      {error && (
        <p className="text-[11px] text-destructive">İşlem başarısız, tekrar deneyin.</p>
      )}

      {activeLinks.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Etkin paylaşım bağlantısı yok.</p>
      ) : (
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">
                Bağlantı
              </th>
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">
                Oluşturma
              </th>
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">
                Bitiş
              </th>
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal">
                Görüntüleme
              </th>
              <th scope="col" className="border-b border-border/40 py-1 pr-3 font-normal" />
            </tr>
          </thead>
          <tbody>
            {activeLinks.map((link) => (
              <tr key={link.token}>
                <td className="border-b border-border/30 py-1 pr-3">
                  <code className="select-all">{`/rapor/${link.token}`}</code>
                </td>
                <td className="border-b border-border/30 py-1 pr-3 tabular-nums">
                  {fmtDate(link.created_at)}
                </td>
                <td className="border-b border-border/30 py-1 pr-3 tabular-nums">
                  {fmtDate(link.expires_at)}
                </td>
                <td className="border-b border-border/30 py-1 pr-3 tabular-nums">
                  {link.views}
                </td>
                <td className="border-b border-border/30 py-1 pr-3 text-right">
                  <button
                    type="button"
                    onClick={() => handleRevoke(link.token)}
                    disabled={isPending}
                    className="text-destructive/70 hover:text-destructive disabled:opacity-50"
                  >
                    İptal et
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
