// Next auto-fills twitter:image from og:image, so this re-export is not
// strictly required; it exists so X gets an explicit /twitter-image route
// and the two cards can never drift. Re-exporting the OG card's default
// export (and its `alt`/`size`/`contentType`) satisfies the file
// convention (a default-exported image function, per
// node_modules/next/dist/docs/.../opengraph-image.md) while keeping the
// two platforms showing the identical Medya DNA card instead of a second,
// possibly-drifted one.
export { default, alt, size, contentType } from "./opengraph-image";
