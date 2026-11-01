/**
 * Shared GET loader for admin client components.
 *
 * Admin panels used to do `fetch(url).then(res => res.json())` and either
 * crash on a non-JSON error page (an HTML 502, a login redirect) or swallow
 * the failure and render zeros, which an operator reads as "nothing is
 * happening". This helper turns every outcome into a value the component can
 * render: the validated data, or a status plus a Turkish message. It NEVER
 * throws, so callers can chain it without a catch.
 *
 * Reachable failure modes:
 *   - 401                 session cookie expired -> message points to re-login
 *   - any other !ok       "HTTP <status>" (the body is not parsed: an HTML
 *                         error page would reject res.json())
 *   - fetch rejects       offline / DNS / aborted -> status null
 *   - 200, bad body       not JSON, or `isValid` says no (wrong shape, or the
 *                         validator itself threw) -> "Beklenmeyen yanıt"
 */

export type AdminLoadResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number | null; message: string };

const SESSION_EXPIRED =
  "Oturumunuzun süresi dolmuş. Devam etmek için yeniden giriş yapın.";
const NETWORK_FAILURE = "Sunucuya ulaşılamadı.";
const UNEXPECTED_RESPONSE = "Beklenmeyen yanıt alındı.";

export async function loadAdminJson<T>(
  url: string,
  isValid: (d: unknown) => d is T,
  fetchImpl: typeof fetch = fetch,
): Promise<AdminLoadResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url, { cache: "no-store" });
  } catch {
    return { ok: false, status: null, message: NETWORK_FAILURE };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message:
        res.status === 401
          ? SESSION_EXPIRED
          : `Veriler yüklenemedi (HTTP ${res.status}).`,
    };
  }

  try {
    const data: unknown = await res.json();
    if (isValid(data)) return { ok: true, data };
  } catch {
    // Non-JSON body, or a throwing validator: same user-facing outcome.
  }
  return { ok: false, status: res.status, message: UNEXPECTED_RESPONSE };
}
