import { z } from 'zod'

import type { Message, TurnStartKind } from '@solus/contracts/types'
import { isQuestionTool } from '@solus/contracts/question-history'
import { prettyToolName } from '../../../contexts/workspace/session.utils'
import { solusAgentToolName } from '@solus/contracts/agent-tools'
import { pullRequestBatchOf } from '@solus/contracts/session-pull-requests'
import type { GroupedItem } from './turns'
import { parseSubagentInput } from './subagent'
import { agentsAwaitingReply, waitingOnLabel } from '../agent-conversation/lib/agent-conversation'
import { intentAsPurpose, intentInProgress } from './activity-phrase'
import { hostPathBaseName } from '@solus/contracts/host-path'

/** The things an activity block can report having done. Thinking is a kind
 *  too: it always arrives with the tools, so it folds into the same sentence
 *  rather than earning a row of its own. So is asking: the answered question
 *  folds away with the turn, and the row is what still says it was asked. */
export type ActivityKind = 'think' | 'ask' | 'search' | 'read' | 'edit' | 'run' | 'other'

const KIND_FOR_TOOL = {
  Read: 'read',
  NotebookRead: 'read',
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  WebFetch: 'search',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
  exec_command: 'run',
} as const satisfies Record<string, ActivityKind>

/** Past tense, because a finished block reads as a caption. */
const VERB_FOR_KIND = {
  think: 'thought',
  ask: 'asked you',
  search: 'searched',
  read: 'read',
  edit: 'edited',
  run: 'ran commands',
  other: 'used tools',
} as const satisfies Record<ActivityKind, string>

const CHANGE_PATH_KEYS = [
  'file_path',
  'notebook_path',
  'filePath',
  'path',
  'file',
  'fileName',
  'filename',
  'old_path',
  'new_path',
  'oldPath',
  'newPath',
] as const

const toolPathSchema = z.object({
  file_path: z.string().optional(),
  notebook_path: z.string().optional(),
  filePath: z.string().optional(),
  path: z.string().optional(),
  file: z.string().optional(),
  fileName: z.string().optional(),
  filename: z.string().optional(),
  old_path: z.string().optional(),
  new_path: z.string().optional(),
  oldPath: z.string().optional(),
  newPath: z.string().optional(),
})

const toolInputSchema = toolPathSchema.extend({
  changes: z.array(toolPathSchema).optional(),
  pattern: z.string().optional(),
  command: z.string().optional(),
  query: z.string().optional(),
  search_query: z.string().optional(),
  url: z.string().optional(),
  prompt: z.string().optional(),
  description: z.string().optional(),
  skill: z.string().optional(),
})

type ParsedToolFields = z.infer<typeof toolInputSchema>

export type ParsedToolInput = ParsedToolFields & {
  sourceJson: string
}

// A tool call's input string is stable per snapshot, but many surfaces
// (activity rows, subagent headers, turn summaries) re-derive from it on every
// stream tick or clock tick — and a running tool's input is re-snapshotted as
// it streams, so superseded snapshots must not be pinned. Memoize on the raw
// string, bounded by entry count AND total key characters, evicting FIFO.
const PARSE_CACHE_MAX_ENTRIES = 1000
const PARSE_CACHE_MAX_CHARS = 2_000_000
let parseCacheChars = 0
const parseCache = new Map<string, ParsedToolInput | null>()

export function parseToolInput(value: string): ParsedToolInput | null {
  const cached = parseCache.get(value)
  if (cached !== undefined || parseCache.has(value)) return cached ?? null
  let parsed: ParsedToolInput | null = null
  try {
    const result = toolInputSchema.safeParse(JSON.parse(value))
    parsed = result.success ? { ...result.data, sourceJson: value } : null
  } catch {
    parsed = null
  }
  // An input larger than the whole budget is not worth pinning at all.
  if (value.length > PARSE_CACHE_MAX_CHARS) return parsed
  for (const key of parseCache.keys()) {
    if (parseCache.size < PARSE_CACHE_MAX_ENTRIES && parseCacheChars + value.length <= PARSE_CACHE_MAX_CHARS) break
    parseCache.delete(key)
    parseCacheChars -= key.length
  }
  parseCache.set(value, parsed)
  parseCacheChars += value.length
  return parsed
}

export function activityKind(toolName: string | undefined): ActivityKind {
  if (!toolName) return 'other'
  // Every provider spells the question tool differently, so it is matched
  // rather than listed beside the fixed tool names above.
  if (isQuestionTool(toolName)) return 'ask'
  return KIND_FOR_TOOL[toolName] ?? 'other'
}

/** What a running tool is doing, said as one sentence: the label is the
 *  sentence, and the target is its object in the mono face — a file, a
 *  pattern, a command — or empty when the label already says it all. */
export interface LiveToolStep {
  label: string
  target: string
}

function filesTarget(parsed: ParsedToolInput | null): string {
  const paths = parsed ? toolPathsFromParsed(parsed) : []
  if (paths.length === 0) return ''
  const name = hostPathBaseName(paths[0]) || paths[0]
  return paths.length === 1 ? name : `${name} and ${paths.length - 1} more`
}

/** The tool's own name as words: `mcp__linear__create_issue` → "create issue". */
function toolNameWords(name: string): string {
  return (name.split('__').at(-1) ?? name).replace(/_/g, ' ').trim()
}

function commandStep(parsed: ParsedToolInput | null): LiveToolStep {
  const intent = parsed?.description ? intentInProgress(parsed.description) : null
  if (intent) return { label: intent, target: '' }
  const command = parsed?.command?.trim() ?? ''
  return command ? { label: 'Running', target: command } : { label: 'Running a command', target: '' }
}

function webSearchStep(parsed: ParsedToolInput | null): LiveToolStep {
  const query = parsed?.query || parsed?.search_query
  return { label: query ? `Searching the web for “${query}”` : 'Searching the web', target: '' }
}

/** The step for a tool whose target is one input field, or a fuller label
 *  when that field has not arrived yet. */
function objectStep(label: string, emptyLabel: string, target: string | undefined): LiveToolStep {
  return target ? { label, target } : { label: emptyLabel, target: '' }
}

const STEP_FOR_TOOL = new Map<string, (parsed: ParsedToolInput | null) => LiveToolStep>([
  ['Bash', commandStep],
  ['exec_command', commandStep],
  ['Read', (parsed) => ({ label: 'Reading', target: filesTarget(parsed) })],
  ['NotebookRead', (parsed) => ({ label: 'Reading', target: filesTarget(parsed) })],
  ['Edit', (parsed) => ({ label: 'Editing', target: filesTarget(parsed) })],
  ['NotebookEdit', (parsed) => ({ label: 'Editing', target: filesTarget(parsed) })],
  ['Write', (parsed) => ({ label: 'Writing', target: filesTarget(parsed) })],
  ['Grep', (parsed) => objectStep('Searching for', 'Searching the code', parsed?.pattern)],
  ['Glob', (parsed) => objectStep('Finding files matching', 'Finding files', parsed?.pattern)],
  ['WebSearch', webSearchStep],
  ['WebFetch', (parsed) => objectStep('Fetching', 'Fetching a page', parsed?.url)],
  ['Skill', (parsed) => ({ label: parsed?.skill ? `Using the ${parsed.skill} skill` : 'Using a skill', target: '' })],
  ['Agent', () => ({ label: 'Starting a subagent', target: '' })],
])

/**
 * "Reading App.svelte", "Running unit tests", "Searching for TODO". The agent's
 * stated intent wins over the raw command, because it says why rather than how.
 */
export function liveToolStep(name: string, input?: string): LiveToolStep {
  if (isQuestionTool(name)) return { label: 'Asking you a question', target: '' }
  const step = STEP_FOR_TOOL.get(name)
  if (step) return step(input ? parseToolInput(input) : null)
  // Solus and MCP tools are named as commands ("Find works", "create_issue"),
  // so a known verb reads as the step itself.
  const words = solusAgentToolName(name) ? prettyToolName(name) : toolNameWords(name)
  return { label: intentInProgress(words) ?? `Using ${words}`, target: '' }
}

/**
 * Friendly copy for the one live activity row. The first two phases are held
 * briefly so a fast transport handshake does not make the row jump straight
 * from the prompt to "Thinking".
 */
export function liveActivityLabel(
  activity: string | undefined,
  elapsedMs: number,
  hasTools: boolean,
  turnStart: TurnStartKind | null = null,
): string {
  const normalized = activity?.replace(/\.{3}$|…$/u, '').trim().toLowerCase()
  if (!hasTools && turnStart === 'fresh') {
    if (elapsedMs < 1_500) return 'Getting things ready…'
    if (elapsedMs < 3_500) return 'Connecting to your agent…'
    if (normalized === 'starting session' || normalized === 'connecting') {
      return 'Thinking it through…'
    }
  }
  if (!hasTools && turnStart === 'follow_up') {
    if (elapsedMs < 1_500) return 'Picking this back up…'
    if (normalized === 'resuming' || normalized === 'connecting') {
      return 'Thinking it through…'
    }
  }
  if (turnStart === 'steer' && (!hasTools || normalized === 'thinking' || normalized === 'steering')) {
    return 'Adjusting course…'
  }

  if (normalized === 'starting session') return 'Getting things ready…'
  if (normalized === 'connecting') return 'Connecting to your agent…'
  if (normalized === 'resuming') return 'Picking this back up…'
  if (normalized === 'steering') return 'Adjusting course…'
  if (normalized === 'thinking') {
    return hasTools ? 'Planning the next step…' : 'Thinking it through…'
  }
  if (normalized === 'writing') return 'Putting the response together…'
  return activity || (hasTools ? 'Planning the next step…' : 'Thinking it through…')
}

/** What the row says while a backgrounded command is still running, as one
 *  sentence: "Running unit tests in the background…". */
export interface BackgroundWait {
  label: string
  /** The command itself, set in the mono face after the label. Only when the
   *  provider stated no intent the label can say instead. */
  command: string
}

/**
 * Other agents, sub-agents and commands this turn is still waiting on. A
 * backgrounded call — and a prompt or watch on another session — answers at
 * launch, so the row goes idle while the work continues — this, not
 * "planning the next step", is what the session is doing. Null when nothing is
 * in flight.
 *
 * Scans the whole turn rather than one group: the launching call can sit many
 * groups behind the row that owns the spinner, and its own card can be far
 * above the fold.
 */
export function describeBackgroundWait(items: GroupedItem[]): BackgroundWait | null {
  // Another session's reply is the whole reason the turn is still open: the
  // host holds it running until the reply arrives, whatever else it said.
  const peerWait = waitingOnLabel(agentsAwaitingReply(items))
  if (peerWait) return { label: peerWait, command: '' }
  const subagents: Message[] = []
  const commands: Message[] = []
  for (const item of items) {
    if (item.kind === 'subagent-group') {
      // toolStatus tracks the agent, not its tool call.
      for (const message of item.messages) {
        if (message.toolStatus === 'running') subagents.push(message)
      }
      continue
    }
    if (item.kind !== 'tool-group') continue
    for (const message of item.messages) {
      if (!message.backgroundTaskId) continue
      if (message.backgroundTaskSettledAt !== undefined) continue
      commands.push(message)
    }
  }
  // The agents are the larger wait, and the turn resumes when they report.
  if (subagents.length > 1) {
    return { label: `Waiting on ${subagents.length} subagents…`, command: '' }
  }
  if (subagents.length === 1) return { label: `${subagentWait(subagents[0])}…`, command: '' }
  if (commands.length === 0) return null
  if (commands.length > 1) {
    return { label: `Running ${commands.length} commands in the background…`, command: '' }
  }
  return backgroundCommandWait(commands[0])
}

/** "Waiting on a subagent to study the diff panel". The prompt is too long to
 *  say in a row, so only the short description names the task. */
function subagentWait(message: Message): string {
  const description = parseSubagentInput(message.toolInput).description?.trim()
  if (!description) return 'Waiting on a subagent'
  const purpose = intentAsPurpose(description)
  return purpose ? `Waiting on a subagent ${purpose}` : `Waiting on the subagent “${description}”`
}

/**
 * What a settled turn's row says while the session is in `background`. The
 * task can have been launched by an earlier turn, so this turn may have no
 * wait of its own to name — the row still says that work goes on. The label is
 * a state marker here, not a sentence still being said, so it drops the
 * trailing ellipsis the live row uses.
 */
export function settledBackgroundWait(items: GroupedItem[]): BackgroundWait {
  const wait = describeBackgroundWait(items)
  return {
    label: (wait?.label ?? 'Running in the background').replace(/…$/, ''),
    command: wait?.command ?? '',
  }
}

/**
 * The command's stated intent, never the command itself: a poll loop's own
 * script is unreadable in a status row. An intent without a known verb is
 * quoted as the work's name. Providers that state no intent fall back to the
 * command, which is the best the row can honestly say.
 */
function backgroundCommandWait(message: Message): BackgroundWait {
  const parsed = message.toolInput ? parseToolInput(message.toolInput) : null
  const description = parsed?.description?.trim().replace(/\.$/, '')
  if (description) {
    const intent = intentInProgress(description)
    return { label: `${intent ?? `Running “${description}”`} in the background…`, command: '' }
  }
  const command = parsed?.command?.trim() ?? ''
  // The command follows the label, so the sentence does not end in an ellipsis.
  return command ? { label: 'Running in the background', command } : { label: 'Running in the background…', command: '' }
}

function addToolPath(paths: Set<string>, value: string | undefined): void {
  if (value === undefined) return
  let path = value.trim()
  if (!path || path === '/dev/null') return
  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  ) {
    path = path.slice(1, -1)
  }
  paths.add(path)
}

export function toolPathsFromParsed(parsed: ParsedToolInput): string[] {
  const paths = new Set<string>()
  for (const key of CHANGE_PATH_KEYS) addToolPath(paths, parsed[key])

  const changes = parsed.changes
  if (changes) {
    for (const change of changes) {
      for (const key of CHANGE_PATH_KEYS) addToolPath(paths, change[key])
    }
  }

  return [...paths]
}

function describeFilePaths(action: string, paths: string[]): string {
  if (paths.length === 0) return `${action} file`
  if (paths.length === 1) return `${action} ${paths[0]}`
  return `${action} ${paths[0]} and ${paths.length - 1} more file${paths.length > 2 ? 's' : ''}`
}

function describeSolusTool(
  name: string,
  parsed: ParsedToolInput,
  truncate: boolean,
): string {
  const label = prettyToolName(name)
  if (parsed.sourceJson.trim() === '{}') return label
  // A batch reads as its count, not as a long list of URLs.
  const batch = pullRequestBatchOf(name, parsed.sourceJson)
  if (batch?.action === 'link') return `Link ${batch.count} pull request${batch.count === 1 ? '' : 's'}`
  if (batch) return `Unlink ${batch.states.join(' and ')} pull requests`

  const description = `${label}: ${parsed.sourceJson}`
  return truncate && description.length > 60
    ? `${description.substring(0, 57)}...`
    : description
}

function describeMcpTool(
  name: string,
  parsed: ParsedToolInput,
  truncate: boolean,
): string {
  if (parsed.sourceJson.trim() === '{}') return name

  const description = `${name}: ${parsed.sourceJson}`
  return truncate && description.length > 60
    ? `${description.substring(0, 57)}...`
    : description
}

export function getToolDescriptionFromParsed(
  name: string,
  parsed: ParsedToolInput,
  options: { truncate?: boolean } = {},
): string {
  const truncate = options.truncate ?? true
  if (solusAgentToolName(name)) return describeSolusTool(name, parsed, truncate)
  if (name.startsWith('mcp__')) return describeMcpTool(name, parsed, truncate)
  switch (name) {
    case 'Read':
    case 'NotebookRead':
      return describeFilePaths('Read', toolPathsFromParsed(parsed))
    case 'Edit':
    case 'NotebookEdit':
      return describeFilePaths('Edit', toolPathsFromParsed(parsed))
    case 'Write':
      return describeFilePaths('Write', toolPathsFromParsed(parsed))
    case 'Glob':
      return `Search files: ${parsed.pattern ?? ''}`
    case 'Grep':
      return `Search: ${parsed.pattern ?? ''}`
    case 'Bash': {
      const cmd = parsed.command ?? ''
      return truncate && cmd.length > 60 ? `${cmd.substring(0, 57)}...` : cmd || 'Bash'
    }
    case 'WebSearch':
      return `Search: ${parsed.query || parsed.search_query || ''}`
    case 'WebFetch':
      return `Fetch: ${parsed.url ?? ''}`
    case 'Agent':
      return `Agent: ${truncate ? (parsed.prompt || parsed.description || '').substring(0, 100) : parsed.prompt || parsed.description || ''}`
    case 'Skill':
      return parsed.skill ? `Skill: ${parsed.skill}` : 'Skill'
    default:
      return name
  }
}

export function getToolDescription(
  name: string,
  input?: string,
  options: { truncate?: boolean } = {},
): string {
  const pretty = prettyToolName(name)
  const truncate = options.truncate ?? true
  if (!input) return pretty
  const parsed = parseToolInput(input)
  if (parsed) return getToolDescriptionFromParsed(name, parsed, { truncate })
  const trimmed = input.trim()
  if (truncate && trimmed.length > 60) return `${pretty}: ${trimmed.substring(0, 57)}...`
  return trimmed ? `${pretty}: ${trimmed}` : pretty
}

/** The target beside a live tool verb. A file call has no target until its
 * input arrives, so the row does not repeat its tool name during the stream. */
export function toolActivityTarget(name: string, input?: string): string {
  if (['Read', 'NotebookRead', 'Edit', 'NotebookEdit', 'Write'].includes(name) && !input) return ''
  return getToolDescription(name, input).replace(/^(Read|Edit|Write|Search files|Search|Fetch)[:\s]+/i, '').trim()
}

/** Formats elapsed activity time for the right-hand rail. */
export function formatActivityDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = ms / 1000
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}

/** When a tool's work actually stopped. A backgrounded tool's `toolCompletedAt`
 *  records the launch, so a four-minute poll would otherwise report 0s; its
 *  settle is the real end. */
export function toolEndMs(tool: Message): number | undefined {
  return tool.backgroundTaskSettledAt ?? tool.toolCompletedAt
}

/** Total wall time the block covers. A live block has not ended, so its time
 *  runs to `liveNow`, the clock; a settled block (`liveNow` null) ends at its
 *  last completion. Null when there is no end to measure to — the rail stays
 *  empty rather than printing a figure we don't have. */
export function activityDurationMs(tools: Message[], liveNow: number | null): number | null {
  let start = Infinity
  let end = liveNow ?? -Infinity
  for (const tool of tools) {
    if (tool.thinkingMs) start = Math.min(start, tool.timestamp - tool.thinkingMs)
    start = Math.min(start, tool.timestamp)
    const completed = toolEndMs(tool)
    if (completed !== undefined) end = Math.max(end, completed)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return end - start
}

export type SummarySegment = { text: string; strong?: boolean }

function joinClauses(clauses: string[]): string {
  if (clauses.length === 0) return ''
  if (clauses.length === 1) return clauses[0]
  return `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`
}

/** The distinct kinds this block covers, in the order they first happened —
 *  drives both the glyph stack and the verbs in the summary. */
export function activityKinds(tools: Message[]): ActivityKind[] {
  const kinds: ActivityKind[] = []
  if (tools.some((tool) => tool.thinkingMs)) kinds.push('think')
  for (const tool of tools) {
    // Codex can answer without a tool row; its receipt has no name to match.
    const kind = tool.questionAnswer ? 'ask' : activityKind(tool.toolName)
    if (!kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

/**
 * "Thought for 6s, searched, read and edited **3 files**" — one sentence in the
 * past tense, with the only number in it emphasised because that is the part
 * worth scanning.
 */
export function activitySummary(tools: Message[]): SummarySegment[] {
  const thinkingMs = tools.reduce((total, tool) => total + (tool.thinkingMs ?? 0), 0)
  const clauses: string[] = []
  if (thinkingMs > 0) clauses.push(`Thought for ${formatActivityDuration(thinkingMs)}`)

  for (const kind of activityKinds(tools)) {
    if (kind === 'think') continue
    clauses.push(VERB_FOR_KIND[kind])
  }

  const paths = new Set<string>()
  for (const tool of tools) {
    if (!tool.toolInput) continue
    const parsed = parseToolInput(tool.toolInput)
    if (!parsed) continue
    for (const path of toolPathsFromParsed(parsed)) paths.add(path)
  }

  const lead = joinClauses(clauses)
  const sentence = lead ? `${lead.charAt(0).toUpperCase()}${lead.slice(1)}` : 'Used tools'
  if (paths.size === 0) return [{ text: sentence }]
  return [
    { text: `${sentence} ` },
    { text: `${paths.size} file${paths.size === 1 ? '' : 's'}`, strong: true },
  ]
}
