import { createServerClient } from "@/lib/supabase/server";

// /admin readability pass — the "Açık düzeltme" (attention.ts) and
// CorrectionsList sections' reader. Moved out of corrections-list.tsx
// (formerly a server component that queried inline) so both the
// attention-strip summary and the section body share one read. The
// select/order/limit chain below is character-identical to the query that
// lived in corrections-list.tsx, with the literal `50` replaced by the
// exported CORRECTIONS_LIMIT constant.
//
// Mirrors src/lib/admin/archive-status.ts's rationale: /admin is
// cookie-gated and dynamic, so this is a plain async fetcher, NOT
// "use cache". Never throws: a Supabase hiccup renders as a status
// sentence, never a 500. `null` means "could not read".

export const CORRECTIONS_LIMIT = 50;

export interface CorrectionRow {
  id: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  url: string;
  message: string;
  email: string | null;
}

export async function getRecentCorrections(): Promise<CorrectionRow[] | null> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("corrections")
      .select("id, status, created_at, reviewed_at, url, message, email")
      .order("created_at", { ascending: false })
      .limit(CORRECTIONS_LIMIT);

    if (error) {
      console.error(`[admin] corrections unavailable: ${error.message}`);
      return null;
    }

    // Never log a row or an email — corrections carry reader-submitted
    // contact info.
    return (data as CorrectionRow[] | null) ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] corrections unavailable: ${message}`);
    return null;
  }
}
