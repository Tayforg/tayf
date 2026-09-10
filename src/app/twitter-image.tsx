// Next auto-fills twitter:image from og:image, so this re-export is not
// strictly required; it exists so X gets an explicit /twitter-image route
// (mirrors src/app/cluster/[id]/twitter-image.tsx) and the two cards can
// never drift.
export { default, alt, size, contentType } from "./opengraph-image";
