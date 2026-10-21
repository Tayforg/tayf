import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// next/image needs the App Router's image-optimization machinery
// (request context, loader config) that isn't present when rendering a
// component function in isolation with `react-dom/server` — mocked out to
// a plain <img> so this test can exercise ClusterCardImage's own JSX
// without pulling in Next's image pipeline. House pattern: see
// header-a11y.test.tsx for the same style of minimal per-test mocking.
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

import { ClusterCardImage } from "./cluster-card-image";

const CREDIT_URL = "https://cdn.outlet.example/foto.jpg";

describe("ClusterCardImage — photo credit (R1-F1)", () => {
  it("renders the credit line for the currently-displayed candidate when `credits` has an entry for it", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={CREDIT_URL}
        credits={{
          [CREDIT_URL]: {
            href: "https://example.com/articles/a-outlet",
            name: "Outlet Gazete",
          },
        }}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain("Görsel:");
    expect(markup).toContain("Outlet Gazete");
    expect(markup).toContain('href="https://example.com/articles/a-outlet"');
  });

  it("renders no credit line when `credits` is omitted", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={CREDIT_URL}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).not.toContain("Görsel:");
  });

  it("renders no credit line when `credits` has no entry for the current candidate", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={CREDIT_URL}
        credits={{
          "https://cdn.outlet.example/some-other-photo.jpg": {
            href: "https://example.com/articles/other",
            name: "Başka Gazete",
          },
        }}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).not.toContain("Görsel:");
  });

  it("renders no credit line on the logo tier even when `credits` is non-empty", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={null}
        logoSrc="https://example.com/logo.png"
        logoAlt="Outlet Gazete"
        credits={{
          [CREDIT_URL]: {
            href: "https://example.com/articles/a-outlet",
            name: "Outlet Gazete",
          },
        }}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).not.toContain("Görsel:");
  });
});

describe("ClusterCardImage — image URL normalisation (ingest-hygiene)", () => {
  it("renders the normalised src for a protocol-relative '//' URL", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src="//cdn.outlet.example/foto.jpg"
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain('src="https://cdn.outlet.example/foto.jpg"');
    expect(markup).not.toContain('src="//cdn.outlet.example');
  });

  it("collapses a doubled leading path slash on existing rows", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src="https://i12.haber7.net//fotogaleri/x.jpg"
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain('src="https://i12.haber7.net/fotogaleri/x.jpg"');
  });

  it("drops candidates that cannot be normalised and uses the next valid one", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src="/relative-only.jpg"
        srcs={["data:image/png;base64,AAAA", "https://cdn.outlet.example/ok.jpg"]}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain('src="https://cdn.outlet.example/ok.jpg"');
  });

  it("dedupes candidates that only differ by the doubled slash", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src="https://h.example//a.jpg"
        srcs={["https://h.example/a.jpg"]}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    // Single <img> in the output: the two spellings collapse to one candidate.
    expect(markup.match(/<img /g)).toHaveLength(1);
  });

  it("still renders the credit when `credits` is keyed by the raw '//' URL", () => {
    const RAW = "//cdn.outlet.example/foto.jpg";
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={RAW}
        credits={{
          [RAW]: {
            href: "https://example.com/articles/a-outlet",
            name: "Outlet Gazete",
          },
        }}
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain("Görsel:");
    expect(markup).toContain("Outlet Gazete");
  });
});

describe("ClusterCardImage — first-party logo tier (ingest-hygiene)", () => {
  it("routes a Google S2 favicon logo through /_next/image", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={null}
        logoSrc="https://www.google.com/s2/favicons?domain=ntv.com.tr&sz=64"
        logoAlt="NTV"
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    // `&` is serialised as `&amp;` in markup.
    expect(markup).toContain(
      'src="/_next/image?url=https%3A%2F%2Fwww.google.com%2Fs2%2Ffavicons',
    );
    expect(markup).toContain("&amp;w=64&amp;q=75");
  });

  it("leaves a non-Google logo URL unchanged", () => {
    const markup = renderToStaticMarkup(
      <ClusterCardImage
        src={null}
        logoSrc="https://example.com/logo.png"
        logoAlt="Outlet Gazete"
        alt="Test görseli"
        width={768}
        height={576}
      />,
    );

    expect(markup).toContain('src="https://example.com/logo.png"');
    expect(markup).not.toContain("/_next/image");
  });
});
