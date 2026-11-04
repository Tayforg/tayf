"use client";

import { Analytics } from "@vercel/analytics/next";
import type { BeforeSend } from "@vercel/analytics/next";
import { dropAutomatedTraffic } from "@/lib/analytics/automation";

// h31-bots-2. A function cannot be passed from the server-rendered root layout
// into a client component, so the root layout mounts this client wrapper
// instead of <Analytics /> directly. The module-level reference keeps the prop
// identity stable across renders (Analytics re-registers beforeSend when it
// changes). It forwards the event alone: whatever else the analytics script
// passes to a hook never reaches the filter's `nav` parameter.
const beforeSend: BeforeSend = (event) => dropAutomatedTraffic(event);

export function WebAnalytics() {
  return <Analytics beforeSend={beforeSend} />;
}
