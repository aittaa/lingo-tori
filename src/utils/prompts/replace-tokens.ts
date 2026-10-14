// A `{{...}}` cell with no braces inside it. `{{{input}}}` therefore still yields
// the inner `{{input}}`, exactly where a literal search for that token found it.
const TOKEN_CELL_PATTERN = /\{\{[^{}]*\}\}/g

/**
 * Substitute known `{{token}}` cells in `template` in ONE pass over the template.
 *
 * Two properties a chain of `replaceAll(token, value)` calls cannot give:
 * - A callback's return value is inserted literally, so a `$&`, `$$`, `` $` ``
 *   or `$'` in a value (page text, a title, a subtitle cue) is not read as a
 *   replacement pattern.
 * - Only cells that were in the original template are replaced. Text inserted
 *   for one token is never scanned again, so a value that happens to contain
 *   `{{webTitle}}` is not expanded by a token handled later in the chain.
 *
 * `replacements` is keyed by the whole cell text (`getTokenCellText(token)`).
 * Any other cell — a legacy name, the no-translation sentinel, an inline-atom
 * placeholder — is returned untouched. (Every key carries its braces, so none can
 * collide with an inherited property such as `constructor`.)
 */
export function replacePromptTokens(
  template: string,
  replacements: Readonly<Record<string, string>>,
): string {
  return template.replace(TOKEN_CELL_PATTERN, (cell) => replacements[cell] ?? cell)
}
