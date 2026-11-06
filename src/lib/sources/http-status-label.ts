/**
 * The text for the "Son HTTP durumu" cell of /kaynaklar/durum.
 *
 * `sources.fetch_last_status` is 0 when the fetch got no HTTP answer at all
 * (DNS failure, connection reset, timeout), null before the first fetch. Neither
 * is an HTTP status, and a bare "0" in a column of 200s and 403s reads like one.
 * Only a real status line, an integer from 100 to 599, is shown as its digits;
 * everything else is the same dash the page uses for "no data". Why the source is
 * unreachable is already said by the "Sessiz" column ("erişim yok").
 *
 * `failStreak` (`sources.fetch_fail_streak`) is optional; a caller that omits it
 * gets the digits-only behaviour above. A success code (2xx or 304) with
 * `failStreak > 0` means the last answer was refused: the server replied 200 but
 * the body was an HTML page or failed to parse as a feed. ingest stores that 200
 * on purpose, and a successful parse is the only thing that resets the streak to
 * 0, so the pair can only mean "answered, but not a feed". A bare "200" beside
 * "erişim yok · karantinada" contradicts itself, so the label says
 * "200 · geçersiz akış". Error statuses (403, 404, 530, ...) already read as a
 * failure and keep their digits.
 */
export function httpStatusLabel(
  status: number | null | undefined,
  opts?: { failStreak?: number | null },
): string {
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    const isSuccess = (status >= 200 && status <= 299) || status === 304;
    const failStreak = opts?.failStreak;
    if (isSuccess && typeof failStreak === "number" && failStreak > 0) {
      return `${status} · geçersiz akış`;
    }
    return String(status);
  }
  return "—";
}
