// Git writes a path in quotes with C escapes when the path has a special
// character: `"a/caf\303\251 menu.ts"`. These functions change between that
// form and the real path, so that every client shows and matches the same path.

const GIT_PATH_ESCAPE = /\\(?:([0-7]{3})|(.))/g
const C_ESCAPES = new Map([['a', 7], ['b', 8], ['t', 9], ['n', 10], ['v', 11], ['f', 12], ['r', 13]])
const C_ESCAPE_LETTERS = new Map([...C_ESCAPES].map(([letter, code]) => [code, letter]))
// Git quotes a path with a control character, so the pattern must match them.
// oxlint-disable-next-line no-control-regex
const QUOTED_CHARACTER = /["\\\x00-\x1f\x7f]/g
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * The real path for a name that git wrote. Removes the surrounding quotes and
 * decodes the escapes: `\NNN` is one octal byte of UTF-8 text, and `\t`, `\n`,
 * `\"`, and `\\` are the C escapes. A plain name comes back unchanged. Git
 * always quotes a path that has a backslash, so a backslash here always starts
 * an escape.
 */
export function decodeGitPath(name: string): string {
  const unquoted = name.length > 1 && name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name
  if (!unquoted.includes('\\')) return unquoted
  const bytes: number[] = []
  let last = 0
  for (const match of unquoted.matchAll(GIT_PATH_ESCAPE)) {
    bytes.push(...encoder.encode(unquoted.slice(last, match.index)))
    bytes.push(match[1] ? parseInt(match[1], 8) : (C_ESCAPES.get(match[2]) ?? match[2].charCodeAt(0)))
    last = match.index + match[0].length
  }
  bytes.push(...encoder.encode(unquoted.slice(last)))
  return decoder.decode(new Uint8Array(bytes))
}

/**
 * A path as git writes it in a patch header, for example `a/<path>`. A path
 * with a quote, a backslash, or a control character gets quotes and escapes,
 * so that `decodeGitPath` gives the same path back. Other text stays as it is.
 */
export function quoteGitPath(path: string): string {
  const escaped = path.replace(QUOTED_CHARACTER, (character) => {
    const code = character.charCodeAt(0)
    if (character === '"' || character === '\\') return `\\${character}`
    const letter = C_ESCAPE_LETTERS.get(code)
    return letter ? `\\${letter}` : `\\${code.toString(8).padStart(3, '0')}`
  })
  return escaped === path ? path : `"${escaped}"`
}
