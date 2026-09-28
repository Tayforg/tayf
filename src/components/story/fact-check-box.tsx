import { ExternalLink } from "lucide-react";

import { TrackedLink } from "@/components/ui/tracked-link";
import type { ClusterFactCheck } from "@/lib/fact-checks/cluster-fact-checks-query";

/**
 * "Bu konuda doğrulama" -- up to 3 outbound links to independent
 * fact-check publishers whose keyword overlap suggests they cover the
 * same claim or event as this cluster (migration 080, keyword-v1
 * matcher). Server component, link-out only: no verdict, description or
 * excerpt is ever rendered here (copyright + editorial-neutrality
 * guard -- see cluster-fact-checks-query.ts and match.ts).
 *
 * Neutral sky tint on purpose: red/emerald/amber/violet already mean
 * zones, blindspot and wire elsewhere on this page.
 *
 * `event: "outbound"` carries no `zone`, so haber-diyetim (the zone-click
 * tracker) ignores these clicks entirely.
 */
export function FactCheckBox({ items }: { items: ClusterFactCheck[] }) {
  if (items.length === 0) return null;

  return (
    <section
      aria-labelledby="dogrulama"
      className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3.5 py-3 space-y-2"
    >
      <h2
        id="dogrulama"
        className="font-serif text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80"
      >
        Bu konuda doğrulama
      </h2>

      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <TrackedLink
              event="outbound"
              data={{ kind: "factcheck" }}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-1.5 text-sm text-foreground hover:underline"
            >
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block font-mono text-[10px] uppercase text-sky-700 dark:text-sky-400">
                  {item.publisherLabel}
                </span>
                <span className="block leading-snug">{item.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {item.dateLabel}
                </span>
              </span>
              <ExternalLink
                aria-hidden="true"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
              />
            </TrackedLink>
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted-foreground/80">
        Bağımsız doğrulama kuruluşlarının bu konuyla ilgili olabilecek
        yayınlarına bağlantı. Eşleştirme otomatiktir ve hatalı olabilir;
        içerik ve varılan sonuç ilgili kuruluşa aittir.
      </p>
    </section>
  );
}
