import { isBoilerplateDescription, isHeadlineEcho } from "./description-boilerplate";
import { stripLeadingStyleRules, tidySummaryText } from "./summary-tidy";

// The excerpt line under a card on /source/<slug> ("Son haberler"), h52-sources-1.
//
// articles.description is the feed's text verbatim, and the ingest tag stripper
// keeps whatever the outlet wrapped around it, so the page printed:
//   - "...Devamı için tıklayınız" (Sabah, A Haber, Yeni Asır: every row),
//   - "<headline> dd.mm.yyyy Diken<body>\nThe post <headline> appeared first on
//     #site_linkat dd.mm.yyyy ." (Diken: every row, the lead visible inside the
//     two-line clamp),
//   - "<body>\n<headline> Medyascope" (Medyascope),
//   - "<headline> yazısı ilk önce <site> adresinde yayınlanmıştır." (Serbestiyet),
//     and the WordPress footer of Açık Gazete and Bir Gazete.
// Cluster summaries already lose all of that at read time (tidySummaryText), so
// this applies the same tidy to the excerpt instead of keeping a second rule set.
//
// Pure and read-time only: nothing is rewritten in the database, no Date, no IO.

/**
 * The excerpt to show under `title` on a source profile, or "" when nothing
 * should be shown (the caller then renders no paragraph at all).
 *
 * Pipeline:
 *   1. null / undefined / "" gives "";
 *   2. {@link stripLeadingStyleRules}: Elips Haber puts the style sheet of its
 *      notice template in front of the notice (h48-ingest-1);
 *   3. {@link tidySummaryText}: the feed residue listed above, glued sentences
 *      ("dedi.Cumhurbaşkanlığı"), raw newlines, a placeholder first line;
 *   4. "" when what is left is empty, an RSS call-to-action or "Ayrıntılar
 *      geliyor..." stub, or only punctuation ({@link isBoilerplateDescription}),
 *      or the card's own headline again ({@link isHeadlineEcho}).
 * The checks of step 4 run on the TIDIED text: "Başlık...Devamı için tıklayınız"
 * is an echo of "Başlık" only once the tail is gone.
 */
export function sourceExcerpt(title: string, description: string | null | undefined): string {
  if (description == null || description === "") return "";
  const excerpt = tidySummaryText(stripLeadingStyleRules(description));
  if (excerpt === "" || isBoilerplateDescription(excerpt) || isHeadlineEcho(title, excerpt)) return "";
  return excerpt;
}
