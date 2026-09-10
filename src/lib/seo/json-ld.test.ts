import { describe, it, expect } from "vitest";

import { serializeJsonLd } from "./json-ld";

describe("serializeJsonLd", () => {
  it("escapes < so a hostile string cannot break out of the script tag", () => {
    const input = { headline: "a </script><script>alert(1)</script> b" };
    const out = serializeJsonLd(input);

    expect(out.includes("<")).toBe(false);
    expect(out).toContain("\\u003c");
    expect(JSON.parse(out).headline).toBe(input.headline);
  });

  it("round-trips ordinary values losslessly", () => {
    const input = { a: 1, b: ["x"], c: null };
    expect(JSON.parse(serializeJsonLd(input))).toEqual(input);
  });

  it("escapes < inside nested objects and arrays too", () => {
    const out = serializeJsonLd({ author: [{ name: "<b>X</b>" }] });
    expect(out.includes("<")).toBe(false);
  });
});
