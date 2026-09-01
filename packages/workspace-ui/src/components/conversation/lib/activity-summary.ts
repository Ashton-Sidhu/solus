import { z } from 'zod'

import type { Message, TurnStartKind } from '@solus/contracts/types'
import { prettyToolName, solusToolKey } from '../../../contexts/workspace/session.utils'
import type { GroupedItem } from './turns'

/** The four things an activity block can report having done. Thinking is a kind
 *  too: it always arrives with the tools, so it folds into the same sentence
 *  rather than earning a row of its own. */
export type ActivityKind = 'think' | 'search' | 'read' | 'edit' | 'run' | 'other'

const KIND_FOR_TOOL = {
  Read: 'read',
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
  search: 'searched',
  read: 'read',
  edit: 'edited',
  run: 'ran commands',
  other: 'used tools',
} as const satisfies Record<ActivityKind, string>

/** Present participle, because a running block reads as a sentence in progress. */
const PARTICIPLE_FOR_KIND = {
  think: 'Thinking',
  search: 'Searching',
  read: 'Reading',
  edit: 'Editing',
  run: 'Running',
  other: 'Working',
} as const satisfies Record<ActivityKind, string>

const CHANGE_PATH_KEYS = [
  'file_path',
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
  return KIND_FOR_TOOL[toolName] ?? 'other'
}

export function participleFor(toolName: string | undefined): string {
  return PARTICIPLE_FOR_KIND[activityKind(toolName)]
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

/** What the row says while a backgrounded command is still running: the wait
 *  itself, plus the command's own account of why it is running. */
export interface BackgroundWait {
  label: string
  /** The tool's stated intent. Empty when the provider gave none, or when
   *  several commands are in flight and no one of them speaks for the rest. */
  target: string
}

/**
 * Commands this turn launched into the background and has not heard back from.
 * A run_in_background tool answers its call at launch, so the row goes idle
 * while the work continues — this, not "planning the next step", is what the
 * session is doing. Null when nothing is in flight.
 *
 * Scans the whole turn rather than one group: the launching call can sit many
 * groups behind the row that owns the spinner.
 */
export function describeBackgroundWait(items: GroupedItem[]): BackgroundWait | null {
  const commands: Message[] = []
  for (const item of items) {
    if (item.kind !== 'tool-group') continue
    for (const message of item.messages) {
      // A backgrounded sub-agent is named by `waitingOnLabel` instead; it is an
      // agent we are waiting on, not a command we are running.
      if (message.subagentType) continue
      if (!message.backgroundTaskId) continue
      if (message.backgroundTaskSettledAt !== undefined) continue
      commands.push(message)
    }
  }
  if (commands.length === 0) return null
  if (commands.length > 1) {
    return { label: `Running ${commands.length} background commands…`, target: '' }
  }
  return { label: 'Running in the background…', target: backgroundCommandIntent(commands[0]) }
}

/**
 * The command's stated intent, never the command itself: a poll loop's own
 * script is unreadable in a status row, and `getToolDescriptionFromParsed`
 * returns exactly that for Bash. Providers that state no intent fall back to
 * the command, which is the best the row can honestly say.
 */
function backgroundCommandIntent(message: Message): string {
  if (!message.toolInput) return ''
  const parsed = parseToolInput(message.toolInput)
  if (!parsed) return ''
  if (parsed.description) return parsed.description
  return parsed.command ?? ''
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
  if (solusToolKey(name)) return describeSolusTool(name, parsed, truncate)
  if (name.startsWith('mcp__')) return describeMcpTool(name, parsed, truncate)
  switch (name) {
    case 'Read':
      return `Read ${parsed.file_path || parsed.path || 'file'}`
    case 'Edit':
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

/** Total wall time the block covers, or null when no tool reported a completion
 *  time — the rail stays empty rather than printing a figure we don't have. */
export function activityDurationMs(tools: Message[]): number | null {
  let start = Infinity
  let end = -Infinity
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
    const kind = activityKind(tool.toolName)
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
