"use client";

import { Analytics } from "@vercel/analytics/next";
import type { BeforeSend } from "@vercel/analytics/next";
import { dropAutomatedTraffic } from "@/lib/analytics/automation";
import { redactAnalyticsEvent } from "@/lib/analytics/redact-url";

// h31-bots-2. A function cannot be passed from the server-rendered root layout
// into a client component, so the root layout mounts this client wrapper
// instead of <Analytics /> directly. The module-level reference keeps the prop
// identity stable across renders (Analytics re-registers beforeSend when it
// changes). It forwards the event alone: whatever else the analytics script
// passes to a hook never reaches the filter's `nav` parameter.
//
// h53-privacy-1. Order matters: automated traffic is dropped first (null), then
// the survivor's url loses everything but the utm_* attribution params. The
// script's beacon url is location.href, so without this step the reader's
// search text (/?q=...) and /takip follow keywords would reach Vercel.
const beforeSend: BeforeSend = (event) => {
  const kept = dropAutomatedTraffic(event);
  return kept === null ? null : redactAnalyticsEvent(kept);
};

export function WebAnalytics() {
  return <Analytics beforeSend={beforeSend} />;
}
