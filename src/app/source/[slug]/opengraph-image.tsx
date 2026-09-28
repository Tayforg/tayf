// seo-9: /source/[slug] no longer sets its own openGraph.images, so Next's
// file-convention wiring picks up whichever sibling opengraph-image.tsx it
// finds. Re-exporting the root's generated 1200x630 Tayf card here (rather
// than leaving it to inherit from the nearest ancestor segment) makes that
// deterministic instead of relying on Next's segment-resolution order.
export { default, alt, size, contentType } from "../../opengraph-image";
