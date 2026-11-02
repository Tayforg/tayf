/**
 * The text for the "Son HTTP durumu" cell of /kaynaklar/durum.
 *
 * `sources.fetch_last_status` is 0 when the fetch got no HTTP answer at all
 * (DNS failure, connection reset, timeout), null before the first fetch. Neither
 * is an HTTP status, and a bare "0" in a column of 200s and 403s reads like one.
 * Only a real status line, an integer from 100 to 599, is shown as its digits;
 * everything else is the same dash the page uses for "no data". Why the source is
 * unreachable is already said by the "Sessiz" column ("erişim yok").
 */
export function httpStatusLabel(status: number | null | undefined): string {
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    return String(status);
  }
  return "—";
}
