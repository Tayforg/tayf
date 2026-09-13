import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// Terminal window. A 1px frame, a one-line title bar in the brand amber,
// and whatever dense rows the caller puts inside. No radius, no shadow: the
// frame is the information (this is one feed), not decoration.
export function Panel({
  title,
  meta,
  children,
  className,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col border border-border bg-black/25", className)}>
      <header className="flex items-baseline justify-between gap-3 border-b border-border bg-foreground/[0.04] px-3 py-1.5 font-mono text-[11px] leading-none">
        <h2 className="text-brand">{title}</h2>
        {meta ? <span className="truncate text-muted-foreground">{meta}</span> : null}
      </header>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  );
}

export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-6 font-mono text-[12px] leading-relaxed text-muted-foreground">{children}</p>;
}
