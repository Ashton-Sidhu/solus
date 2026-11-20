import type { IntegrationPrompt } from '@solus/contracts/integrations/prompts'

/**
 * MCP prompts in a composer (docs/plans/mcp-first-class.md §10), the same on
 * desktop, web, and mobile: how a typed command line starts a prompt, and the
 * fields of the argument form. The form knows only fields and values, not
 * prompts, so a resource template (§11.3) can use it too.
 */

/** One field of the argument form. */
export interface ArgumentField {
  name: string
  description?: string
  required: boolean
}

/** One value the form gives back, in field order. */
export interface ArgumentValue {
  name: string
  value: string
}

/** The required fields whose value is empty or only spaces. */
export function missingArguments(fields: readonly ArgumentField[], values: readonly ArgumentValue[]): string[] {
  const filled = new Map(values.map((entry) => [entry.name, entry.value.trim()]))
  return fields.filter((field) => field.required && !filled.get(field.name)).map((field) => field.name)
}

/** The values to send: trimmed, and without the optional fields left empty. */
export function filledArguments(values: readonly ArgumentValue[]): ArgumentValue[] {
  return values.map((entry) => ({ name: entry.name, value: entry.value.trim() })).filter((entry) => entry.value)
}

/** `<number> [focus]`: required arguments in angle brackets, optional ones in square brackets. */
export function argumentHint(prompt: Pick<IntegrationPrompt, 'arguments'>): string {
  return prompt.arguments.map((argument) => (argument.required ? `<${argument.name}>` : `[${argument.name}]`)).join(' ')
}

/** The prompt a typed line starts, and the text after its command; null when the line starts no prompt. */
export function promptFromLine(line: string, prompts: readonly IntegrationPrompt[]): { prompt: IntegrationPrompt; rest: string } | null {
  const text = line.trimStart()
  if (!text.startsWith('/')) return null
  const command = /^\S+/.exec(text)?.[0] ?? ''
  const prompt = prompts.find((candidate) => candidate.command === command)
  return prompt ? { prompt, rest: text.slice(command.length).trim() } : null
}

/**
 * What a prompt does when it starts. No argument: it sends. One argument: the
 * rest of the line is its value, and an empty required one opens the form.
 * More arguments open the form, with the rest of the line in the first field.
 */
export type PromptStart =
  | { kind: 'send'; values: ArgumentValue[] }
  | { kind: 'form'; values: ArgumentValue[] }
  | { kind: 'refused'; message: string }

export function promptStart(prompt: IntegrationPrompt, rest: string): PromptStart {
  const fields = prompt.arguments
  if (fields.length === 0) return rest ? { kind: 'refused', message: `${prompt.command} takes no arguments.` } : { kind: 'send', values: [] }
  const values = fields.map((field, index) => ({ name: field.name, value: index === 0 ? rest : '' }))
  if (fields.length === 1 && missingArguments(fields, values).length === 0) return { kind: 'send', values: filledArguments(values) }
  return { kind: 'form', values }
}

/**
 * The prompts a slash menu may offer beside the commands it already has. A
 * Solus or provider command of the same name wins: its prompt is left out,
 * so a typed command always means one thing.
 */
export function promptsBesideCommands(prompts: readonly IntegrationPrompt[], commands: Iterable<string>): IntegrationPrompt[] {
  const taken = new Set(commands)
  return prompts.filter((prompt) => !taken.has(prompt.command))
}
