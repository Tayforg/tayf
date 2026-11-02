import { displayQuery } from "@/lib/search/search-status";

// The reader's query, quoted back on "/?q=" (the result count line and the
// empty-search card). A server-safe component: no hooks, no "use client".
//
// Two things keep a pasted URL from breaking the layout (WCAG 1.4.10 Reflow,
// h23-a11y-4): the text goes through displayQuery (trimmed, whitespace
// collapsed, capped at 60 code points with an ellipsis, the same text as the
// <title> and the live region), and the span carries break-words plus
// overflow-wrap:anywhere so even 60 unbroken characters wrap inside a 390 px
// column instead of widening it. `overflow-wrap: anywhere` (unlike
// `break-word`) also lowers the min-content width, which is what lets a flex
// parent with min-w-0 shrink.
//
// The query is a React text child, so markup in it is escaped.

export function SearchEcho({
  q,
  className,
}: {
  q: string | undefined;
  className?: string;
}) {
  const shown = displayQuery(q);
  if (shown === "") return null;
  const classes = ["break-words", "[overflow-wrap:anywhere]", className]
    .filter(Boolean)
    .join(" ");
  return <span className={classes}>{`“${shown}”`}</span>;
}
