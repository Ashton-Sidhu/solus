import type { IntegrationLaunch } from '../integration-types'

/** A command line as a program and its arguments, or the reason it is refused. */
export type CommandLineSplit =
  | { ok: true; launch: Pick<IntegrationLaunch, 'command' | 'args'> }
  | { ok: false; reason: string }

/** The characters a shell gives a meaning that Solus does not (docs/plans/mcp-first-class.md §7.4). */
const SHELL_OPERATORS = new Map([
  ['|', 'a pipe (|)'],
  ['&', 'an ampersand (&)'],
  [';', 'a semicolon (;)'],
  ['<', 'a redirect (<)'],
  ['>', 'a redirect (>)'],
  ['`', 'a backquote (`)'],
])

function refused(what: string): CommandLineSplit {
  return { ok: false, reason: `The command has ${what}. Solus starts the program without a shell, so write one program and its arguments only.` }
}

/** A `$` that a shell would expand, as the refusal names it, or null. */
function expansionAt(line: string, index: number): string | null {
  return line[index] === '$' && /[A-Za-z_{(]/.test(line[index + 1] ?? '') ? `a $ expansion (${line.slice(index, index + 2)}…)` : null
}

/** The text inside one pair of quotes from `start` (the opening quote), and the index of the closing one; or the refusal. */
function quoted(line: string, start: number): { text: string; end: number } | { refusal: CommandLineSplit } {
  const quote = line[start]
  let text = ''
  for (let index = start + 1; index < line.length; index++) {
    const char = line[index]
    if (char === quote) return { text, end: index }
    // Single quotes keep every character; double quotes keep all but an expansion and a backquote.
    if (quote === '"') {
      const expansion = expansionAt(line, index)
      if (expansion) return { refusal: refused(expansion) }
      if (char === '`') return { refusal: refused('a backquote (`)') }
      if (char === '\\' && /["\\$`]/.test(line[index + 1] ?? '')) {
        text += line[++index]
        continue
      }
    }
    text += char
  }
  return { refusal: { ok: false, reason: `The command has a ${quote === '"' ? 'double' : 'single'} quote that is not closed.` } }
}

/**
 * Splits one line, such as `npx -y @modelcontextprotocol/server-filesystem /data`,
 * the way the host starts it: no shell (§7.4). Single quotes keep every
 * character. Double quotes keep spaces; a backslash in them escapes `"`, `\`,
 * `$`, and a backquote. Outside quotes a backslash keeps the next character.
 * A line with a shell operator or a `$` expansion outside single quotes is
 * refused with the reason, because nothing would run it as the person expects.
 * The host and every client use this one rule, so the dialog shows what runs.
 */
export function splitCommandLine(line: string): CommandLineSplit {
  const words: string[] = []
  let word: string | null = null
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    const operator = SHELL_OPERATORS.get(char) ?? expansionAt(line, index)
    if (operator) return refused(operator)
    if (/\s/.test(char)) {
      if (word !== null) words.push(word)
      word = null
      continue
    }
    word ??= ''
    if (char === "'" || char === '"') {
      const part = quoted(line, index)
      if ('refusal' in part) return part.refusal
      word += part.text
      index = part.end
    } else if (char === '\\') {
      if (index + 1 < line.length) word += line[++index]
    } else word += char
  }
  if (word !== null) words.push(word)
  const [command, ...args] = words
  if (!command) return { ok: false, reason: 'Type a command, such as npx -y @modelcontextprotocol/server-everything.' }
  return { ok: true, launch: { command, args } }
}
