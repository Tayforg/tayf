import Link from "next/link";

import {
  FRAMING_RECEIPT_CAVEAT,
  framingReceiptSentence,
  type FramingReceipt,
} from "@/lib/clusters/framing-receipt";

// T11 (migration 068) — renders the Çerçeveleme makbuzu. Server component,
// no "use client", no data fetching: every prop here is a count, never an
// outlet name, an article title, a URL or a per-article row (shared
// contract section 6). The caller (public cluster page, gated by
// shouldShowPublicFramingReceipt, or the always-on admin report) decides
// whether and when this renders.

interface FramingReceiptCardProps {
  receipt: FramingReceipt;
}

export function FramingReceiptCard({ receipt }: FramingReceiptCardProps) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-5 space-y-2">
      <p className="text-sm text-foreground">{framingReceiptSentence(receipt)}</p>
      <p className="text-[11px] text-muted-foreground">
        {FRAMING_RECEIPT_CAVEAT}{" "}
        <Link
          href="/metodoloji"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Yöntem sayfası
        </Link>
      </p>
    </div>
  );
}
