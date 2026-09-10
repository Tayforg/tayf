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
