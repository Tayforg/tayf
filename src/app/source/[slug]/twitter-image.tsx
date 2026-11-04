// See opengraph-image.tsx's header comment: same card, same day-long shared
// cache. Re-exported from the SOURCE opengraph-image (not the root one) so the
// two routes cannot drift and both carry SOURCE_OG_CACHE_HEADERS.
export { default, alt, size, contentType } from "./opengraph-image";
