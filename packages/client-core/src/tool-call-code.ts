import { z } from 'zod'

/**
 * The input of one tool call as a code block a reader can scan: a shell
 * command as a script, any other structured input as indented JSON. Desktop,
 * web, and mobile show it under an expanded tool row.
 */
export interface ToolCallCode {
  language: 'bash' | 'json'
  code: string
}

/** Claude's `Bash` and Codex's command executions. */
const COMMAND_TOOLS = new Set(['Bash', 'exec_command', 'shell', 'local_shell', 'command_execution'])

/** Calls whose row already says what they did: a file path, or a prompt that
 *  reads as prose. Their expanded row stays as it is. */
const DESCRIBED_TOOLS = new Set(['Read', 'NotebookRead', 'Edit', 'NotebookEdit', 'Write', 'Agent', 'Task'])

const commandSchema = z.union([z.string(), z.array(z.string())])
const commandInputSchema = z.object({ command: commandSchema.optional(), cmd: commandSchema.optional() })
const jsonSchema = z.json()
const structuredInputSchema = z.union([z.looseObject({}), z.array(jsonSchema)])
type JsonValue = z.infer<typeof jsonSchema>

/** The code for a finished call's input, or null when the row needs none. */
export function toolCallCode(toolName: string, input: string | null | undefined): ToolCallCode | null {
  const source = input?.trim()
  if (!source || DESCRIBED_TOOLS.has(toolName)) return null
  const value = parseJson(source)
  if (COMMAND_TOOLS.has(toolName)) {
    // Codex sends its command as the bare string, not as JSON.
    const command = value === undefined ? source : commandOf(value)
    return command ? { language: 'bash', code: formatShellCommand(unwrapShell(command)) } : null
  }
  const structured = structuredInputSchema.safeParse(value)
  if (!structured.success) return null
  const code = JSON.stringify(structured.data, null, 2)
  return code === '{}' || code === '[]' ? null : { language: 'json', code }
}

function parseJson(source: string): JsonValue | undefined {
  if (source[0] !== '{' && source[0] !== '[') return undefined
  try {
    return jsonSchema.parse(JSON.parse(source))
  } catch {
    return undefined
  }
}

function commandOf(value: JsonValue): string | null {
  const parsed = commandInputSchema.safeParse(value)
  const command = parsed.success ? parsed.data.command ?? parsed.data.cmd : undefined
  if (!Array.isArray(command)) return command?.trim() || null
  // Codex wraps commands as ["bash", "-lc", "<script>"].
  const [program, flag, script] = command
  if (command.length === 3 && program.endsWith('sh') && flag.startsWith('-')) return script.trim() || null
  return command.join(' ').trim() || null
}

/** `/bin/zsh -lc 'cd x && make'` → `cd x && make`. Codex runs every command
 *  through a login shell; the wrapper is noise, the script is the call. A
 *  quote this function cannot undo exactly keeps the whole command. */
function unwrapShell(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command)
  if (!match) return command
  const [, quote, body] = match
  if (quote === "'") {
    const escapes = [`'\\''`, `'"'"'`]
    if (escapes.reduce((rest, escape) => rest.replaceAll(escape, ''), body).includes("'")) return command
    return escapes.reduce((script, escape) => script.replaceAll(escape, "'"), body)
  }
  if (/(^|[^\\])(\\\\)*"/.test(body)) return command
  return body.replace(/\\([\\$"`])/g, '$1')
}

/**
 * A one-line command with one statement on each line. It breaks after each
 * `&&` and `||` and at each `;` that the shell itself reads, so the result is
 * the same script. A command that already has line breaks, a `case`, or
 * quoting it cannot follow stays as it is.
 */
export function formatShellCommand(command: string): string {
  const source = command.trim()
  if (source.includes('\n') || /(^|\s)case\s/.test(source)) return source
  const breaks = statementBreaks(source)
  if (!breaks) return source
  const lines: string[] = []
  let start = 0
  for (const { at, operator } of breaks) {
    const text = source.slice(start, at).trim()
    lines.push(operator === ';' ? text : `${text} ${operator}`)
    start = at + operator.length
  }
  lines.push(source.slice(start).trim())
  return lines.filter(Boolean).join('\n')
}

/** `[[ a && b ]]` is one test and `$(a; b)` one word: only an operator outside
 *  every group ends a statement. */
const DEPTH_STEPS = new Map([['[[', 1], [']]', -1], ['(', 1], [')', -1], ['{', 1], ['}', -1]])

/** Where each top-level statement ends, or null when the quoting or grouping
 *  does not close. A comment ends the scan: nothing after it is a statement. */
function statementBreaks(source: string): Array<{ at: number; operator: string }> | null {
  const breaks: Array<{ at: number; operator: string }> = []
  let depth = 0
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    const pair = source.slice(i, i + 2)
    const group = groupToken(source, i)
    if (char === '\\') {
      i++
    } else if (char === "'" || char === '"' || char === '`') {
      i = quotedEnd(source, i)
      if (i < 0) return null
    } else if (char === '#' && /^\s?$/.test(source[i - 1] ?? '')) {
      break
    } else if (group) {
      depth += DEPTH_STEPS.get(group) ?? 0
      if (depth < 0) return null
      i += group.length - 1
    } else if (depth === 0 && (pair === '&&' || pair === '||' || char === ';')) {
      const operator = char === ';' ? ';' : pair
      breaks.push({ at: i, operator })
      i += operator.length - 1
    }
  }
  return depth === 0 ? breaks : null
}

/** The group opener or closer at `i`, or null. */
function groupToken(source: string, i: number): string | null {
  const pair = source.slice(i, i + 2)
  if (DEPTH_STEPS.has(pair)) return pair
  return DEPTH_STEPS.has(source[i]) ? source[i] : null
}

/** The index of the quote that closes the run opening at `start`, or -1. */
function quotedEnd(source: string, start: number): number {
  const quote = source[start]
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\' && quote !== "'") i++
    else if (source[i] === quote) return i
  }
  return -1
}
