/**
 * src/lib/game/headline-announcement.ts — the sentence the /oyun games push
 * into their permanently mounted `role="status"` live region when a new
 * headline becomes current.
 *
 * The headline <p> itself sits outside that region, so without this a screen
 * reader user hears "Taraf tahmini, İktidar, button" and never the headline
 * they are asked to judge. Pure: callers pass the position and the title, so
 * it is safe to call from an event handler (never from an effect: the repo's
 * react-hooks/set-state-in-effect rule forbids announcing from there).
 *
 *   (1, 5, "Başlık A")   -> "1/5. Başlık A"   (Bölge, Günün Tayf'ı)
 *   (3, null, "B")       -> "3. B"            (Çerçeve: the round has no fixed size)
 *   (1, 5, undefined|"") -> ""                (nothing to announce)
 */
export function headlineAnnouncement(
  position: number,
  total: number | null,
  title: string | undefined,
): string {
  if (!title) return "";
  return total === null ? `${position}. ${title}` : `${position}/${total}. ${title}`;
}
