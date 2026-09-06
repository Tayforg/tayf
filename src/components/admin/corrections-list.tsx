import { createServerClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface CorrectionRow {
  id: string;
  status: string;
  created_at: string;
  url: string;
  message: string;
  email: string | null;
}

export async function CorrectionsList() {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("corrections")
    .select("id, status, created_at, url, message, email")
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
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full border border-border/60 px-2 py-0.5 font-medium">
                    {c.status}
                  </span>
                  <span>{new Date(c.created_at).toLocaleString("tr-TR")}</span>
                  {c.email && <span>{c.email}</span>}
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
