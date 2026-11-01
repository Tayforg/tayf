/**
 * Bare `/api/v1`: the same JSON 404 envelope (CORS, `no-store`) and the same
 * 204 preflight as the catch-all.
 *
 * `[...path]` is a required catch-all, so Next never matches it against the
 * root itself; without this file `GET /api/v1` fell through to Next's HTML
 * not-found page, which a client doing `res.json()` chokes on and which carries
 * no CORS headers. Middleware already lets the bare path through, so a route
 * file is all it needs. Re-exporting (rather than copying) keeps the two in
 * lock-step: there is one definition of "an unmatched /api/v1 path".
 */
export { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } from "./[...path]/route";
