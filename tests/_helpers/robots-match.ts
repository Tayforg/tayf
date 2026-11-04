// ---------------------------------------------------------------------------
// A small RFC 9309 robots.txt evaluator shared by tests/api/robots.test.ts and
// tests/api/llms-txt.test.ts.
//
// What it implements:
//   - group selection by exact user-agent token (falling back to `*`), with
//     consecutive User-agent lines sharing the rule lines that follow them;
//   - rule paths matched from the START of path+query ("/metodoloji?source=x"
//     is one string, so "/*?source=" can see the query);
//   - `*` in a rule path matches any run of characters (including none), and a
//     trailing `$` anchors the rule to the end of the URL;
//   - the longest matching rule path wins and Allow wins a tie; no match means
//     the URL is allowed.
//
// What it deliberately skips: percent-encoding normalisation and the
// `Crawl-delay` / `Sitemap` lines (neither affects allow/deny).
//
// No regular expression is ever built from, or run over, robots text: rule
// paths come from the file under test, and CodeQL flags RegExp built from
// such input. The wildcard matcher is a character-scan two-pointer with a
// single backtrack point, which is O(path x rule) in the worst case.
// ---------------------------------------------------------------------------

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export type RobotsGroups = Map<string, RobotsRule[]>;

export function parseRobots(body: string): RobotsGroups {
  const groups: RobotsGroups = new Map();
  // Consecutive User-agent lines share the rule lines that follow them.
  let tokens: string[] = [];
  let previousWasAgent = false;
  for (const rawLine of body.split("\n")) {
    const hash = rawLine.indexOf("#");
    const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!previousWasAgent) tokens = [];
      const token = value.toLowerCase();
      tokens.push(token);
      if (!groups.has(token)) groups.set(token, []);
      previousWasAgent = true;
      continue;
    }
    previousWasAgent = false;
    // `Disallow:` with an empty value allows everything: no rule to record.
    if ((key === "allow" || key === "disallow") && value !== "") {
      for (const token of tokens) groups.get(token)!.push({ allow: key === "allow", path: value });
    }
  }
  return groups;
}

export function rulesFor(groups: RobotsGroups, crawler: string): RobotsRule[] {
  return groups.get(crawler.toLowerCase()) ?? groups.get("*") ?? [];
}

/**
 * True when `pattern` (a robots rule path: `*` wildcards, optional trailing
 * `$`) matches `target` from its first character. Without a trailing `$` the
 * pattern only has to match a prefix of `target`.
 */
export function robotsPatternMatches(pattern: string, target: string): boolean {
  const anchored = pattern.endsWith("$");
  const pat = anchored ? pattern.slice(0, -1) : pattern;
  let p = 0; // position in the pattern
  let t = 0; // position in the target
  let starP = -1; // pattern position of the most recent `*`
  let starT = -1; // target position that `*` has consumed up to
  for (;;) {
    if (p === pat.length) {
      // Pattern consumed: a prefix match is enough unless `$` pins the end.
      if (!anchored || t === target.length) return true;
    } else if (pat[p] === "*") {
      starP = p;
      starT = t;
      p += 1;
      continue;
    } else if (t < target.length && pat[p] === target[t]) {
      p += 1;
      t += 1;
      continue;
    }
    // Mismatch (or `$` not at the end): let the last `*` swallow one more char.
    if (starP === -1 || starT >= target.length) return false;
    starT += 1;
    p = starP + 1;
    t = starT;
  }
}

/** `path` is the URL path plus query, e.g. "/metodoloji?source=star". */
export function isCrawlAllowed(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!robotsPatternMatches(rule.path, path)) continue;
    if (
      best === null ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best === null ? true : best.allow;
}
