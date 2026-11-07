"use client";

import { useId, useState } from "react";
import { Share2, Check, ChevronDown } from "lucide-react";
import { track } from "@/lib/track";
import { buildChannelShareHref, buildShareUrl, SHARE_LINK_CHANNELS } from "@/lib/clusters/share";
import { siteUrl } from "@/lib/site-url";
import { buildEmbedSnippet } from "@/lib/cards/badge-embed";
import { buildIframeSnippet } from "@/lib/embed/embed-snippet";
import { runNativeShare } from "@/lib/share/native-share";

// Literal chip classes shared by every pill in this component (the
// original "Paylaş"/"Kartı indir" buttons and the 4 channel chips below) —
// Tailwind 4 requires literal class strings, no computed class names.
const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center";

// h46-mobile-1: below sm the secondary share options (Kartı indir, Sitenize
// ekle, Gömme kodu, the channel group) sit behind a "Daha fazla" disclosure so
// the share/save row stays at two lines and the bias spectrum is on the first
// screen. Both wrapper classes and the toggle classes are literals (Tailwind 4
// generates only classes it can read verbatim; see
// tests/guards/cluster-actions-reflow.test.ts). `contents` keeps the wrapper
// out of the box tree, so from sm up the chips lay out exactly as before and
// the toggle (`sm:hidden`) takes no space. The toggle chip is CHIP_CLASS plus
// `sm:hidden`, written out in full for the same literal-class reason.
export const MORE_OPEN = "contents";
export const MORE_CLOSED = "contents max-sm:hidden";
const MORE_TOGGLE_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 hover:bg-muted/70 px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center sm:hidden";

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

// Copies the "Sitenize ekle" <a><img></a> snippet for the cluster's spectrum
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

// Copies the live-widget <iframe> snippet (/embed/cluster/<id>, "Gömme kodu").
// Same contract as copyEmbedCode: false for a non-uuid id or an unavailable /
// denied clipboard, and nothing is tracked unless the write succeeded.
export async function copyIframeCode(clusterId: string): Promise<boolean> {
  const snippet = buildIframeSnippet(siteUrl(), clusterId);
  if (!snippet) return false;
  try {
    await navigator.clipboard.writeText(snippet);
  } catch {
    return false;
  }
  track("share", { clusterId, kind: "embed_iframe" });
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

// "Sitenize ekle" outcome. On failure `manual` is the html snippet the reader
// can select and copy by hand (null when the id is not a uuid, i.e. there is
// no snippet to show).
export async function resolveEmbedCopy(
  clusterId: string,
): Promise<{ ok: true } | { ok: false; manual: string | null }> {
  if (await copyEmbedCode(clusterId)) return { ok: true };
  return { ok: false, manual: buildEmbedSnippet(siteUrl(), clusterId)?.html ?? null };
}

// "Gömme kodu" outcome. On failure `manual` is the iframe snippet the reader
// can select and copy by hand (null when the id is not a uuid).
export async function resolveIframeCopy(
  clusterId: string,
): Promise<{ ok: true } | { ok: false; manual: string | null }> {
  if (await copyIframeCode(clusterId)) return { ok: true };
  return { ok: false, manual: buildIframeSnippet(siteUrl(), clusterId) };
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

// The text every outbound share carries: the headline, then the statistics
// line when there is one. The channel chips and the primary "Paylaş" button
// (native sheet and clipboard copy) all use it, so a recipient who gets no
// link preview (SMS, e-mail, plain text) still reads the story and not just
// the numbers (h57-outbound-3).
function shareBody(title: string, text?: string): string {
  return text ? `${title}\n${text}` : title;
}

// What one click on "Paylaş" amounted to. `shared` and `aborted` change no
// UI state (the label stays "Paylaş"); `copied` / `failed` drive the existing
// "Kopyalandı" / "Kopyalanamadı" feedback.
export type ShareStoryResult =
  | { kind: "shared" }
  | { kind: "aborted" }
  | { kind: "copied" }
  | { kind: "failed"; manual: string };

interface ShareStoryInput {
  clusterId: string;
  title: string;
  text?: string;
  url: string;
}

// The whole "Paylaş" decision, extracted so it is unit-testable without a DOM.
// Native share first (mobile). A dismissed sheet (AbortError) is the reader's
// decision, not a failure: nothing is tracked and the clipboard stays
// untouched (h21-journeys-2). Any other native failure, or no Web Share API at
// all, falls back to copying the link.
export async function shareStory({
  clusterId,
  title,
  text,
  url,
}: ShareStoryInput): Promise<ShareStoryResult> {
  // Bound on purpose: a detached `navigator.share` throws "Illegal
  // invocation" in browsers, which runNativeShare would swallow as a
  // fallback and turn every share into a copy.
  const shareFn =
    typeof navigator !== "undefined" && typeof navigator.share === "function"
      ? (d: ShareData) => navigator.share(d)
      : undefined;
  // With no statistics line the payload stays {title, url} and the clipboard
  // gets the bare link; with one, the text is the headline plus that line.
  const body = text ? shareBody(title, text) : undefined;
  const outcome = await runNativeShare(shareFn, body ? { title, text: body, url } : { title, url });
  if (outcome === "shared") {
    track("share", { clusterId, kind: "native" });
    return { kind: "shared" };
  }
  if (outcome === "aborted") return { kind: "aborted" };
  track("share", { clusterId, kind: "clipboard" });
  const r = await resolveShareCopy(url, body);
  return r.ok ? { kind: "copied" } : { kind: "failed", manual: r.manual };
}

interface ShareButtonProps {
  clusterId: string;
  title: string;
  // Optional bias-argument line from `buildShareText` (src/lib/clusters/
  // share.ts) — e.g. "12 kaynak · %70 iktidar · ...". When present it
  // rides along (after the headline, as `${title}\n${text}`) with the native
  // share sheet, the clipboard fallback and the channel chips alike, so the
  // story argues itself before the recipient clicks.
  text?: string;
  // Href of the "Kartı indir" link. Undefined keeps the default
  // `/cluster/<id>/kart`; null renders no link at all (the cluster page passes
  // null when /kart would answer 404, so no dead download is offered). A plain
  // string rather than a helper import: this 'use client' file must not pull
  // story-card.ts and its server dependencies into the browser bundle.
  cardHref?: string | null;
  // Initial state of the phone-only "Daha fazla" disclosure. Closed by default;
  // a plain prop (never a window/matchMedia read), so the server and the client
  // start from the same state and hydration cannot mismatch. It also lets the
  // markup tests render the open state without a DOM.
  initialMoreOpen?: boolean;
}

// The phone-only disclosure trigger. A real <button> (Enter/Space work natively),
// the same element before and after a toggle (so focus stays on it), with the
// 44 px phone floor from the shared chip classes. Exported so the click wiring
// is unit-testable without a DOM.
export function MoreShareToggle({
  open,
  controlsId,
  onToggle,
}: {
  open: boolean;
  controlsId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controlsId}
      onClick={onToggle}
      className={MORE_TOGGLE_CLASS}
    >
      <ChevronDown className={open ? "h-3 w-3 rotate-180" : "h-3 w-3"} aria-hidden="true" />
      <span>{open ? "Daha az" : "Daha fazla"}</span>
    </button>
  );
}

export function ShareButton({
  clusterId,
  title,
  text,
  cardHref,
  initialMoreOpen = false,
}: ShareButtonProps) {
  const [moreOpen, setMoreOpen] = useState(initialMoreOpen);
  const moreId = useId();
  const [copied, setCopied] = useState(false);
  const [embedCopied, setEmbedCopied] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  const [embedFailed, setEmbedFailed] = useState(false);
  const [iframeCopied, setIframeCopied] = useState(false);
  const [iframeFailed, setIframeFailed] = useState(false);
  // Manual-copy text persists until the next successful copy of the same kind.
  const [shareManual, setShareManual] = useState<string | null>(null);
  const [embedManual, setEmbedManual] = useState<string | null>(null);
  const [iframeManual, setIframeManual] = useState<string | null>(null);
  const canEmbed = buildEmbedSnippet(siteUrl(), clusterId) !== null;
  const canEmbedIframe = buildIframeSnippet(siteUrl(), clusterId) !== null;
  const body = shareBody(title, text);
  const cardLink = cardHref === undefined ? `/cluster/${clusterId}/kart` : cardHref;

  async function handleShare() {
    const url = `${window.location.origin}/cluster/${clusterId}`;
    const r = await shareStory({ clusterId, title, text, url });
    if (r.kind === "copied") {
      setCopied(true);
      setShareManual(null);
      setTimeout(() => setCopied(false), 2000);
    } else if (r.kind === "failed") {
      setShareFailed(true);
      setShareManual(r.manual);
      setTimeout(() => setShareFailed(false), 2000);
    }
    // shared / aborted: nothing to show — the label stays "Paylaş".
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

  async function handleIframe() {
    const r = await resolveIframeCopy(clusterId);
    if (r.ok) {
      setIframeCopied(true);
      setIframeManual(null);
      setTimeout(() => setIframeCopied(false), 2000);
    } else {
      setIframeFailed(true);
      setIframeManual(r.manual);
      setTimeout(() => setIframeFailed(false), 2000);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleShare}
        className={CHIP_CLASS}
      >
        {copied ? (
          <Check className="h-3 w-3 text-emerald-500" />
        ) : (
          <Share2 className="h-3 w-3" />
        )}
        <span>{copied ? "Kopyalandı" : shareFailed ? "Kopyalanamadı" : "Paylaş"}</span>
      </button>
      {/* The trigger comes right after the primary chip and before the
          wrapper it controls, so Tab walks from it into the revealed options. */}
      <MoreShareToggle
        open={moreOpen}
        controlsId={moreId}
        onToggle={() => setMoreOpen((o) => !o)}
      />
      <span id={moreId} data-group="more-share" className={moreOpen ? MORE_OPEN : MORE_CLOSED}>
        {cardLink && (
          <a
            href={cardLink}
            // Explicit filename: the route answers `Content-Disposition:
            // inline` (the card stays viewable at its own URL), and the URL's
            // last segment is "kart" with no extension, so a valueless
            // `download` would save an extensionless file. KART-06.
            download="tayf-kart.png"
            // The card is a Satori PNG render per cluster: a download for people,
            // not a page for a crawler to queue (robots.txt disallows it too).
            rel="nofollow"
            className={CHIP_CLASS}
          >
            Kartı indir
          </a>
        )}
        {canEmbed && (
          <button
            type="button"
            onClick={handleEmbed}
            title="Bu haberin yelpaze rozetini sitenize ekleyin"
            className={CHIP_CLASS}
          >
            {embedCopied ? "Kod kopyalandı" : embedFailed ? "Kopyalanamadı" : "Sitenize ekle"}
          </button>
        )}
        {canEmbedIframe && (
          <button
            type="button"
            onClick={handleIframe}
            title="Canlı yelpaze kutusunu (iframe) sitenize ekleyin"
            className={CHIP_CLASS}
          >
            {iframeCopied ? "Kod kopyalandı" : iframeFailed ? "Kopyalanamadı" : "Gömme kodu"}
          </button>
        )}
        <span className="inline-flex flex-wrap items-center gap-1 max-w-full" role="group" aria-label="Kanal ile paylaş">
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
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {copied
          ? "Kopyalandı"
          : embedCopied || iframeCopied
            ? "Kod kopyalandı"
            : shareFailed || embedFailed || iframeFailed
              ? "Kopyalanamadı"
              : ""}
      </span>
      {shareManual && <ManualCopyBox label="Paylaşım bağlantısı" value={shareManual} />}
      {embedManual && <ManualCopyBox label="Gömme kodu" value={embedManual} />}
      {iframeManual && <ManualCopyBox label="iframe gömme kodu" value={iframeManual} />}
    </>
  );
}
