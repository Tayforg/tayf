/**
 * `Cache-Control: private, no-store` on every `/api/admin/**` answer (W3).
 *
 * The admin JSON carries API keys and webhook secrets, share links, source tables
 * and moderation state. It must never be pinned by a shared cache (a CDN in front
 * of the app, a corporate proxy) or kept by the browser in a history entry. Most
 * routes set no Cache-Control at all, `apiTooManyRequests` answers a bare
 * `no-store`, and only the webhook route set `private, no-store` by hand on its
 * success paths; a header written per return path is one a new branch forgets.
 * `withAdminNoStore` sets it once, on whatever Response the handler returns:
 * success, 401, 429, validation 400 and the 500 of `withApiErrors`.
 *
 * Wrap OUTSIDE `withApiErrors`, so the 500 that turns a thrown error into a
 * response gets the header too. Every exported method of every
 * `src/app/api/admin/.../route.ts` must be
 * `export const POST = withAdminNoStore(withApiErrors(async ...))`
 * (tests/guards/admin-no-store.test.ts).
 *
 * It never catches what the handler throws: Next uses thrown errors as
 * control-flow signals (`redirect()`, `notFound()`, a prerender interrupt), and a
 * swallowed one breaks the framework. A throw leaves with no response and so no
 * header to set; `withApiErrors` is what turns a real error into a 500.
 */

/** The one Cache-Control value of an admin answer. */
export const ADMIN_CACHE_CONTROL = "private, no-store";

/**
 * Wraps a route handler (same signature) so the Response it returns carries
 * `Cache-Control: private, no-store`, replacing any value the handler set
 * (`apiTooManyRequests` sends `no-store`; a stray `public, max-age` must not
 * survive). A Response whose headers are guarded (`Response.redirect()`,
 * `fetch()` results) cannot be edited in place; it is rebuilt with the same
 * body, status, status text and headers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withAdminNoStore<T extends (...args: any[]) => Promise<Response>>(handler: T): T {
  return (async (...args: Parameters<T>) => {
    const response = await handler(...args);
    try {
      response.headers.set("Cache-Control", ADMIN_CACHE_CONTROL);
      return response;
    } catch {
      // Only the header edit is inside this try: guarded (immutable) headers throw a TypeError.
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", ADMIN_CACHE_CONTROL);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  }) as T;
}
