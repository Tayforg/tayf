"use client";

import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import { track, type TrackEvent, type TrackProps } from "@/lib/track";

interface TrackedLinkProps extends ComponentPropsWithoutRef<"a"> {
  event: TrackEvent;
  data?: TrackProps;
}

// Plain <a> that fires one analytics event on click, so Server Components
// can keep their outbound anchors without becoming client components.
export function TrackedLink({ event, data, onClick, ...rest }: TrackedLinkProps) {
  function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    track(event, data);
    onClick?.(e);
  }
  return <a {...rest} onClick={handleClick} />;
}
