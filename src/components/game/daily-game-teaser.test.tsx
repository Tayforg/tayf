import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { DailyGameTeaser } from "./daily-game-teaser";

describe("DailyGameTeaser", () => {
  it("links to /oyun?mod=gunluk", () => {
    const html = renderToStaticMarkup(<DailyGameTeaser />);
    expect(html).toMatch(/href="\/oyun\?mod=gunluk"/);
  });

  it("shows the puzzle number when given", () => {
    const html = renderToStaticMarkup(<DailyGameTeaser puzzleNumber={7} />);
    expect(html).toContain("#7");
  });

  it("omits the puzzle number when not given", () => {
    const html = renderToStaticMarkup(<DailyGameTeaser />);
    expect(html).not.toMatch(/#\d/);
  });

  it("shows the fixed copy line", () => {
    const html = renderToStaticMarkup(<DailyGameTeaser />);
    expect(html).toContain("5 manşet, 3 taraf. Hangisi hangi bölgeden?");
  });
});
