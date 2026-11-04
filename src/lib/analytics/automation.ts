// h31-bots-2: keep automated browsers out of Web Analytics.
//
// Web Analytics used to be mounted bare, so headless browsers counted as
// readers (CN 35%, SG 21%, HK 18%, 98% desktop, home at 13 views). A client
// filter can only act on what the browser admits to:
//   - navigator.webdriver === true, which stock Puppeteer, Playwright and
//     Selenium set (it is the WebDriver spec's automation flag);
//   - a user agent that names its tooling or announces itself as a bot.
// Stealth fleets that spoof both are invisible here; that needs Vercel
// Firewall rules, which are a founder step. Lighthouse runs stop counting too.
//
// This must FAIL OPEN: a missing navigator or a throwing getter keeps the
// event, so a detection bug can never cost a real reader's pageview.
//
// Pure and regex-free: lowercase substring checks only.

/** The slice of `Navigator` the filter reads. Everything is `unknown`: it is untrusted browser state. */
export interface NavigatorLike {
  webdriver?: unknown;
  userAgent?: unknown;
}

// Lowercase substrings of user agents that identify automation. "bot/" is the
// "<name>bot/<version>" product-token shape ("Googlebot/2.1", "Examplebot/1.0");
// it does not match "Robotics/Abbott 1.0".
const AUTOMATION_UA_MARKERS = [
  "headlesschrome",
  "phantomjs",
  "puppeteer",
  "playwright",
  "selenium",
  "lighthouse",
  "bot/",
] as const;

/** True when the browser identifies itself as automated. Never throws. */
export function isAutomatedBrowser(nav?: NavigatorLike | null): boolean {
  try {
    if (nav === null || nav === undefined) return false;
    if (nav.webdriver === true) return true;
    const userAgent = nav.userAgent;
    if (typeof userAgent !== "string") return false;
    const lowered = userAgent.toLowerCase();
    for (const marker of AUTOMATION_UA_MARKERS) {
      if (lowered.includes(marker)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function readNavigator(): NavigatorLike | undefined {
  try {
    return globalThis.navigator;
  } catch {
    return undefined;
  }
}

/**
 * `beforeSend` for Vercel Web Analytics: returning `null` drops the event, so
 * automated traffic yields null and everything else yields the SAME event
 * object back. `nav` defaults to the live navigator.
 */
export function dropAutomatedTraffic<E>(
  event: E,
  nav: NavigatorLike | null | undefined = readNavigator(),
): E | null {
  return isAutomatedBrowser(nav) ? null : event;
}
