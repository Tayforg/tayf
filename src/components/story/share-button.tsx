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
    try {
      await navigator.clipboard.writeText(text ? `${text}\n${url}` : url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable
    }
  }

  async function handleEmbed() {
    if (await copyEmbedCode(clusterId)) {
      setEmbedCopied(true);
      setTimeout(() => setEmbedCopied(false), 2000);
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
        <span>{copied ? "Kopyalandı" : "Paylaş"}</span>
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
          Sitene ekle
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
        {copied ? "Kopyalandı" : embedCopied ? "Kod kopyalandı" : ""}
      </span>
    </>
  );
}
