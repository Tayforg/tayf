import Link from "next/link";
import { Zap } from "lucide-react";

// h194-a11y-1: the label is a real <h2> that names its own <section>, so a
// screen-reader user who navigates by heading reaches the note instead of
// finding it filed under the previous section. The look is unchanged: globals.css
// gives every h1-h3 the serif heading font and -0.02em tracking, so the label
// carries font-sans (tracking-wider already overrides the tracking) to stay the
// sans label it was. The id must be unique on the page: the cluster page renders
// one caption. The 'Neden?' link keeps its visible text first and gains an
// sr-only suffix, so a bare "Neden?" in a links list says what it is about
// (WCAG 2.4.4, and 2.5.3 label in name holds).
const HEADING_ID = "surpriz-kesisimler";

export function CrossSpectrumCaption({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <section
      aria-labelledby={HEADING_ID}
      className="flex items-start gap-2.5 rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-3"
    >
      <Zap
        className="h-4 w-4 shrink-0 text-yellow-600 dark:text-yellow-400 mt-0.5"
        strokeWidth={2.75}
      />
      <div className="space-y-1 min-w-0">
        <div className="flex items-center gap-2">
          <h2
            id={HEADING_ID}
            className="font-sans text-xs font-semibold uppercase tracking-wider text-yellow-800 dark:text-yellow-400"
          >
            Sürpriz kesişimler
          </h2>
          <Link
            href="/metodoloji#surpriz"
            className="text-[11px] text-yellow-800 dark:text-yellow-400 underline decoration-dotted underline-offset-2 hover:text-yellow-900 dark:hover:text-yellow-300"
          >
            Neden?
            <span className="sr-only"> (sürpriz kesişimler)</span>
          </Link>
        </div>
        {lines.map((line, i) => (
          <p
            key={i}
            className="text-[11px] leading-relaxed text-yellow-800 dark:text-yellow-400"
          >
            {line}
          </p>
        ))}
      </div>
    </section>
  );
}
