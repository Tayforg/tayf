import { createServerClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CorrectionActions } from "@/components/admin/corrections-actions";
import { correctionStatusLabel } from "@/lib/corrections/status";

interface CorrectionRow {
  id: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  url: string;
  message: string;
  email: string | null;
}

export async function CorrectionsList() {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("corrections")
    .select("id, status, created_at, reviewed_at, url, message, email")
    .order("created_at", { ascending: false })
    .limit(50);

  const corrections = (error ? [] : (data as CorrectionRow[] | null)) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Düzeltme bildirimleri</CardTitle>
      </CardHeader>
      <CardContent>
        {corrections.length === 0 ? (
          <p className="text-sm text-muted-foreground">Henüz bildirim yok.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {corrections.map((c) => (
              <li
                key={c.id}
                className="rounded-lg border border-border/60 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-full border border-border/60 px-2 py-0.5 font-medium">
                      {correctionStatusLabel(c.status)}
                    </span>
                    <span>{new Date(c.created_at).toLocaleString("tr-TR")}</span>
                    {c.reviewed_at && (
                      <span>
                        İncelendi: {new Date(c.reviewed_at).toLocaleString("tr-TR")}
                      </span>
                    )}
                    {c.email && <span>{c.email}</span>}
                  </div>
                  <CorrectionActions id={c.id} status={c.status} />
                </div>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block break-all text-primary underline-offset-4 hover:underline"
                >
                  {c.url}
                </a>
                <p className="mt-1 whitespace-pre-wrap text-foreground">{c.message}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
