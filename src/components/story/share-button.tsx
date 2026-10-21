"use client";

import { useState } from "react";
import { Share2, Check } from "lucide-react";
import { track } from "@/lib/track";
import { buildChannelShareHref, buildShareUrl, SHARE_LINK_CHANNELS } from "@/lib/clusters/share";
import { siteUrl } from "@/lib/site-url";
import { buildEmbedSnippet } from "@/lib/cards/badge-embed";

// Literal chip classes shared by every pill in this component (the
// original "Paylaş"/"Kartı indir" buttons and the 4 channel chips below) —
// Tailwind 4 requires literal class strings, no computed class names.
const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors";

const CHANNEL_LABELS: Record<(typeof SHARE_LINK_CHANNELS)[number], string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  x: "X",
  bluesky: "Bluesky",
};

// Extracted so the click→track wiring is unit-testable without a DOM/click
// simulator (this repo has no jsdom/testing-library dependency; see
// share-button.test.tsx).
export function trackChannelShare(
  clusterId: string,
  channel: (typeof SHARE_LINK_CHANNELS)[number],
): void {
  track("share", { clusterId, kind: channel });
}

// Copies the "Sitene ekle" <a><img></a> snippet for the cluster's spectrum
// badge. Exported for the same DOM-less testability reason as above.
// Resolves false when the id is not a uuid or the clipboard is unavailable.
export async function copyEmbedCode(clusterId: string): Promise<boolean> {
  const snippet = buildEmbedSnippet(siteUrl(), clusterId);
  if (!snippet) return false;
  try {
    await navigator.clipboard.writeText(snippet.html);
  } catch {
    return false;
  }
  track("share", { clusterId, kind: "embed" });
  return true;
}

// Writes to the clipboard and reports the outcome instead of throwing.
// Resolves false on a rejected write AND on a missing navigator.clipboard
// (insecure context, SSR) — the TypeError is caught by the same try.
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

// "Sitene ekle" outcome. On failure `manual` is the html snippet the reader
// can select and copy by hand (null when the id is not a uuid, i.e. there is
// no snippet to show).
export async function resolveEmbedCopy(
  clusterId: string,
): Promise<{ ok: true } | { ok: false; manual: string | null }> {
  if (await copyEmbedCode(clusterId)) return { ok: true };
  return { ok: false, manual: buildEmbedSnippet(siteUrl(), clusterId)?.html ?? null };
}

// "Paylaş" clipboard-fallback outcome. On failure `manual` is the share url.
export async function resolveShareCopy(
  url: string,
  text?: string,
): Promise<{ ok: true } | { ok: false; manual: string }> {
  if (await copyText(text ? `${text}\n${url}` : url)) return { ok: true };
  return { ok: false, manual: url };
}

// Read-only fallback shown when the clipboard is unavailable or denied.
// `basis-full` pushes it onto its own line inside a flex-wrap parent.
export function ManualCopyBox({ label, value }: { label: string; value: string }) {
  return (
    <span className="basis-full flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">
        Otomatik kopyalanamadı — metni seçip kopyalayın.
      </span>
      <textarea
        readOnly
        aria-label={label}
        value={value}
        rows={3}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full rounded-md border border-border/60 bg-muted/30 p-2 font-mono text-[11px] text-foreground"
      />
    </span>
  );
}

interface ShareButtonProps {
  clusterId: string;
  title: string;
  // Optional bias-argument line from `buildShareText` (src/lib/clusters/
  // share.ts) — e.g. "12 kaynak · %70 iktidar · ...". When present it
  // rides along with both the native share sheet and the clipboard
  // fallback so the story argues itself before the recipient clicks.
  text?: string;
}

export function ShareButton({ clusterId, title, text }: ShareButtonProps) {
  const [copied, setCopied] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  const [embedFailed, setEmbedFailed] = useState(false);
  // Manual-copy text persists until the next successful copy of the same kind.
  const [shareManual, setShareManual] = useState<string | null>(null);
  const [embedManual, setEmbedManual] = useState<string | null>(null);
  const canEmbed = buildEmbedSnippet(siteUrl(), clusterId) !== null;
  const body = text ? `${title}\n${text}` : title;

  async function handleShare() {
    const url = `${window.location.origin}/cluster/${clusterId}`;
    // Try native share first (mobile)
    if (navigator.share) {
      try {
        await navigator.share(text ? { title, text, url } : { title, url });
        track("share", { clusterId, kind: "native" });
        return;
      } catch {
        // user cancelled; fall through to clipboard
      }
    }
    track("share", { clusterId, kind: "clipboard" });
    // Clipboard fallback
    const r = await resolveShareCopy(url, text);
    if (r.ok) {
      setCopied(true);
      setShareManual(null);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setShareFailed(true);
      setShareManual(r.manual);
      setTimeout(() => setShareFailed(false), 2000);
    }
  }

  async function handleEmbed() {
    const r = await resolveEmbedCopy(clusterId);
    if (r.ok) {
      setEmbedCopied(true);
      setEmbedManual(null);
      setTimeout(() => setEmbedCopied(false), 2000);
    } else {
      setEmbedFailed(true);
      setEmbedManual(r.manual);
      setTimeout(() => setEmbedFailed(false), 2000);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleShare}
        className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {copied ? (
          <Check className="h-3 w-3 text-emerald-500" />
        ) : (
          <Share2 className="h-3 w-3" />
        )}
        <span>{copied ? "Kopyalandı" : shareFailed ? "Kopyalanamadı" : "Paylaş"}</span>
      </button>
      <a
        href={`/cluster/${clusterId}/kart`}
        // Explicit filename: the route answers `Content-Disposition:
        // inline` (the card stays viewable at its own URL), and the URL's
        // last segment is "kart" with no extension, so a valueless
        // `download` would save an extensionless file. KART-06.
        download="tayf-kart.png"
        className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        Kartı indir
      </a>
      {canEmbed && (
        <button
          type="button"
          onClick={handleEmbed}
          title="Bu haberin yelpaze rozetini sitenize ekleyin"
          className={CHIP_CLASS}
        >
          {embedCopied ? "Kod kopyalandı" : embedFailed ? "Kopyalanamadı" : "Sitene ekle"}
        </button>
      )}
      <span className="inline-flex items-center gap-1" aria-label="Kanal ile paylaş">
        {SHARE_LINK_CHANNELS.map((channel) => {
          const label = CHANNEL_LABELS[channel];
          return (
            <a
              key={channel}
              href={buildChannelShareHref(channel, buildShareUrl(siteUrl(), clusterId, channel), body)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${label} ile paylaş`}
              onClick={() => trackChannelShare(clusterId, channel)}
              className={CHIP_CLASS}
            >
              {label}
            </a>
          );
        })}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {copied
          ? "Kopyalandı"
          : embedCopied
            ? "Kod kopyalandı"
            : shareFailed || embedFailed
              ? "Kopyalanamadı"
              : ""}
      </span>
      {shareManual && <ManualCopyBox label="Paylaşım bağlantısı" value={shareManual} />}
      {embedManual && <ManualCopyBox label="Gömme kodu" value={embedManual} />}
    </>
  );
}
