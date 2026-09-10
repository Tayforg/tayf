// The return value of `serializeJsonLd` is embedded via
// `dangerouslySetInnerHTML` inside a `<script type="application/ld+json">`
// element. A raw "<" (e.g. from a "</script" substring hiding inside a
// `title_tr` or an LLM-generated `summary_tr`) would terminate the script
// element early — the browser stops parsing JSON-LD at that point and
// whatever text follows is parsed as ordinary HTML. To make that
// impossible, every "<" in the JSON output is emitted as the JSON escape
// `\u003c`, which `JSON.parse` restores losslessly (it's just another way
// to spell the same character inside a JSON string).
//
// Note: ">" and "&" need no escaping here — this is not an HTML text
// node being escaped for a browser's HTML parser, it's a JSON document
// inside a `<script>` element, and only a literal "</script" (case-
// insensitive) can close that element early. U+2028/U+2029 (the
// characters that break unescaped JSON embedded directly in a `<script>`
// as *JavaScript*, e.g. `var x = ...`) are likewise irrelevant here
// because this is not being parsed as JS source — it's `application/ld
// +json`, parsed as JSON text. Both omissions are deliberate, not an
// oversight.
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
