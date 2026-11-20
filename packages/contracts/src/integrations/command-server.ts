import { integrationEnvNameSchema, type IntegrationConnection, type IntegrationFacts, type IntegrationLaunch } from '../integration-types'
import { splitCommandLine } from './command-line'

/**
 * A command as an MCP server in Settings (docs/plans/mcp-first-class.md §7.7):
 * the rules every client shares, so desktop, web, and mobile show one state
 * with one label and offer the same actions. The words are here too, because
 * a rule and its words change together.
 */

/** The refusal of the host (`command-admission.ts`), shown in place of a form a person without `host.admin` cannot use (§7.2). */
export const COMMAND_ADMIN_ONLY = 'Only an administrator of this host can add or change a command.'

/** Where the person adds a command: it runs on the host and stays there (§7.8). */
export function commandHostNote(hostName: string): string {
  return `This command runs on ${hostName} as the user that runs Solus there. It can read and change files there. It stays on ${hostName}: it is not in your agent profile and does not sync to other hosts.`
}

/** A word `splitCommandLine` reads back as itself: bare when safe, else in single quotes. */
function quoteWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(word)) return word
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** The one line a launch reads as, for the row and the edit form. `splitCommandLine` gives the same launch back. */
export function commandLineText(launch: Pick<IntegrationLaunch, 'command' | 'args'>): string {
  return [launch.command, ...launch.args].map(quoteWord).join(' ')
}

/**
 * A name for a new command when the person gives none: its package or
 * program without scope or version, such as `server-filesystem` for
 * `npx -y @modelcontextprotocol/server-filesystem /data`.
 */
export function suggestedCommandName(launch: Pick<IntegrationLaunch, 'command' | 'args'>): string {
  const runners = new Set(['npx', 'bunx', 'pnpx', 'uvx', 'pipx', 'docker', 'node', 'python', 'python3', 'deno', 'bun', 'uv'])
  const program = launch.command.split(/[\\/]/).pop() ?? launch.command
  const word = runners.has(program) ? launch.args.find((arg) => !arg.startsWith('-') && !['run', 'x', 'exec'].includes(arg)) : undefined
  const base = (word ?? program).replace(/@[^/@]*$/, '').split('/').pop() || program
  return base.slice(0, 200)
}

export type EnvNamesCheck = { ok: true; names: string[] } | { ok: false; reason: string }

/** The environment variable names a person typed, separated by commas or spaces. */
export function parseEnvNames(text: string): EnvNamesCheck {
  const names = text.split(/[\s,]+/).filter((name) => name.length > 0)
  for (const name of names) {
    if (!integrationEnvNameSchema.safeParse(name).success) return { ok: false, reason: `${name} is not a variable name. Use letters, digits, and underscores, and do not start with a digit.` }
  }
  const twice = names.find((name, index) => names.indexOf(name) !== index)
  if (twice) return { ok: false, reason: `${twice} is named twice.` }
  if (names.length > 64) return { ok: false, reason: 'Name at most 64 environment variables.' }
  return { ok: true, names }
}

/** What the person typed in the add or edit form. `name` is absent in the edit form: Rename changes it. */
export interface CommandDraft {
  name?: string
  line: string
  cwd: string
  envNames: string
}

export type CommandDraftField = 'line' | 'cwd' | 'envNames'

export type CommandDraftCheck =
  | { ok: true; name: string; launch: IntegrationLaunch; envNames: string[] }
  | { ok: false; field: CommandDraftField; reason: string }

/** The form as the host will take it, or the first field it refuses and why. The host checks the line with the same rule (§7.4). */
export function checkCommandDraft(draft: CommandDraft): CommandDraftCheck {
  const split = splitCommandLine(draft.line)
  if (!split.ok) return { ok: false, field: 'line', reason: split.reason }
  const cwd = draft.cwd.trim()
  if (cwd.length > 4096) return { ok: false, field: 'cwd', reason: 'The folder path is too long.' }
  const names = parseEnvNames(draft.envNames)
  if (!names.ok) return { ok: false, field: 'envNames', reason: names.reason }
  const launch: IntegrationLaunch = cwd ? { ...split.launch, cwd } : split.launch
  return { ok: true, name: draft.name?.trim() || suggestedCommandName(launch), launch, envNames: names.names }
}

/** The form's fields for a saved command, to edit it. */
export function commandDraftOf(launch: IntegrationLaunch, envNames: readonly string[]): CommandDraft {
  return { line: commandLineText(launch), cwd: launch.cwd ?? '', envNames: envNames.join(', ') }
}

export type CommandProcessActionKind = 'start' | 'start-again' | 'test-again' | 'stop' | 'cancel'

export interface CommandProcessAction {
  kind: CommandProcessActionKind
  label: string
  /** Stop and Cancel are the way back, so they stay on when the person cannot start the command. */
  isEnabled: boolean
}

/**
 * The state of the person's process of one command, as every client shows it.
 * `not-started`: none ran yet. `stopped`: it stopped when idle, on Stop, or
 * when the host stopped; the next use starts it. `ended`: it stopped by
 * itself; the next use starts it. `failed`, `not-installed`, `cannot-run`:
 * only Start again starts it.
 */
export type CommandProcessState = 'checking' | 'not-started' | 'starting' | 'running' | 'stopped' | 'ended' | 'failed' | 'not-installed' | 'cannot-run'

export interface CommandProcessStatus {
  state: CommandProcessState
  label: string
  tone: 'ready' | 'muted' | 'attention' | 'error'
  /** What the host said, or what happens next. */
  detail: string | null
  /** The last standard error of the process. Only the owner gets it. */
  stderrTail: string | null
  /** The main action first. */
  actions: CommandProcessAction[]
  /** Why the actions that start the command are off, or null. */
  blockedReason: string | null
}

export interface CommandProcessInput {
  facts: Pick<IntegrationFacts, 'era' | 'process'> | undefined
  /** A start from this client runs now. */
  isStarting: boolean
  /** The person holds `host.admin` on this host. */
  mayRunCommands: boolean
  /** The command names environment variables and the person saved no values. */
  needsValues: boolean
}

const ACTION_LABELS = {
  start: 'Start and test',
  'start-again': 'Start again',
  'test-again': 'Test again',
  stop: 'Stop',
  cancel: 'Cancel',
} satisfies { [kind in CommandProcessActionKind]: string }

/** The process state in words, and the actions that change it (§7.7). */
export function commandProcessStatus(input: CommandProcessInput): CommandProcessStatus {
  const blockedReason = !input.mayRunCommands ? COMMAND_ADMIN_ONLY : input.needsValues ? 'Enter the environment values first.' : null
  const actions = (...kinds: CommandProcessActionKind[]): CommandProcessAction[] =>
    kinds.map((kind) => ({ kind, label: ACTION_LABELS[kind], isEnabled: kind === 'stop' || kind === 'cancel' || blockedReason === null }))
  const status = (state: CommandProcessState, label: string, tone: CommandProcessStatus['tone'], detail: string | null, list: CommandProcessAction[], stderrTail: string | null = null): CommandProcessStatus =>
    ({ state, label, tone, detail, stderrTail, actions: list, blockedReason: list.some((action) => !action.isEnabled) ? blockedReason : null })

  if (input.isStarting) return status('starting', 'Starting…', 'muted', 'Solus starts the command and lists its tools.', actions('cancel'))
  const process = input.facts?.process
  if (!process) return status('checking', 'Checking…', 'muted', null, [])
  const stderrTail = process.stderrTail?.trim() ? process.stderrTail : null
  switch (process.state) {
    case 'running':
      return status('running', 'Running', 'ready', null, actions('stop', 'test-again'))
    case 'stopped':
      if (process.message) return status('ended', 'Stopped by itself', 'attention', `${process.message} The next use starts it again.`, actions('start-again', 'test-again'), stderrTail)
      // A saved verdict or saved facts mean it ran before: it stopped when idle, on Stop, or with the host.
      if (input.facts?.era) return status('stopped', 'Stopped', 'muted', 'It stops after 10 minutes without use. The next use starts it again.', actions('start', 'test-again'))
      return status('not-started', 'Not started', 'muted', 'It starts when an agent first uses it. Start and test it now to see its tools.', actions('start'))
    case 'failed':
      if (process.startFailure === 'not-installed') return status('not-installed', 'Not installed', 'error', process.message ?? null, actions('start-again'), stderrTail)
      if (process.startFailure === 'not-runnable') return status('cannot-run', 'Cannot run', 'error', process.message ?? null, actions('start-again'), stderrTail)
      return status('failed', 'Failed', 'error', process.message ?? null, actions('start-again'), stderrTail)
  }
}

export interface CommandValuesText {
  text: string
  /** The action that saves values; Disconnect removes them. */
  action: 'Enter values' | 'Change values'
  hasValues: boolean
}

/** The person's environment values of a command, in words. A value is never read back: only whether some are saved. */
export function commandValuesText(names: readonly string[], connection: Pick<IntegrationConnection, 'status'> | null | undefined): CommandValuesText {
  const hasValues = connection?.status === 'connected'
  const count = names.length === 1 ? '1 value' : `${names.length} values`
  return hasValues
    ? { text: `${count} saved on this host`, action: 'Change values', hasValues }
    : { text: `No values yet. The command needs ${names.join(', ')}.`, action: 'Enter values', hasValues }
}
