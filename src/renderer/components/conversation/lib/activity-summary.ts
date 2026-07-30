import type { Message, TurnStartKind } from '../../../../shared/types'
import { prettyToolName, solusToolKey } from '../../../contexts/workspace/session.utils'

/** The four things an activity block can report having done. Thinking is a kind
 *  too: it always arrives with the tools, so it folds into the same sentence
 *  rather than earning a row of its own. */
export type ActivityKind = 'think' | 'search' | 'read' | 'edit' | 'run' | 'other'

const KIND_FOR_TOOL: Record<string, ActivityKind> = {
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
}

/** Past tense, because a finished block reads as a caption. */
const VERB_FOR_KIND: Record<ActivityKind, string> = {
  think: 'thought',
  search: 'searched',
  read: 'read',
  edit: 'edited',
  run: 'ran commands',
  other: 'used tools',
}

/** Present participle, because a running block reads as a sentence in progress. */
const PARTICIPLE_FOR_KIND: Record<ActivityKind, string> = {
  think: 'Thinking',
  search: 'Searching',
  read: 'Reading',
  edit: 'Editing',
  run: 'Running',
  other: 'Working',
}

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
]

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

function addToolPath(paths: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return
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

export function toolPathsFromParsed(parsed: Record<string, unknown>): string[] {
  const paths = new Set<string>()
  for (const key of CHANGE_PATH_KEYS) addToolPath(paths, parsed[key])

  const changes = parsed.changes
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue
      const record = change as Record<string, unknown>
      for (const key of CHANGE_PATH_KEYS) addToolPath(paths, record[key])
    }
  }

  return [...paths]
}

function describeFilePaths(action: string, paths: string[]): string {
  if (paths.length === 0) return `${action} file`
  if (paths.length === 1) return `${action} ${paths[0]}`
  return `${action} ${paths[0]} and ${paths.length - 1} more file${paths.length > 2 ? 's' : ''}`
}

export function getToolDescriptionFromParsed(
  name: string,
  parsed: Record<string, unknown>,
  options: { truncate?: boolean } = {},
): string {
  const truncate = options.truncate ?? true
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  // Solus tools show just their friendly label — no args.
  if (solusToolKey(name)) return prettyToolName(name)
  switch (name) {
    case 'Read':
      return `Read ${s(parsed.file_path) || s(parsed.path) || 'file'}`
    case 'Edit':
      return describeFilePaths('Edit', toolPathsFromParsed(parsed))
    case 'Write':
      return describeFilePaths('Write', toolPathsFromParsed(parsed))
    case 'Glob':
      return `Search files: ${s(parsed.pattern)}`
    case 'Grep':
      return `Search: ${s(parsed.pattern)}`
    case 'Bash': {
      const cmd = s(parsed.command)
      return truncate && cmd.length > 60 ? `${cmd.substring(0, 57)}...` : cmd || 'Bash'
    }
    case 'WebSearch':
      return `Search: ${s(parsed.query) || s(parsed.search_query)}`
    case 'WebFetch':
      return `Fetch: ${s(parsed.url)}`
    case 'Agent':
      return `Agent: ${truncate ? (s(parsed.prompt) || s(parsed.description)).substring(0, 100) : s(parsed.prompt) || s(parsed.description)}`
    case 'Skill':
      return s(parsed.skill) ? `Skill: ${s(parsed.skill)}` : 'Skill'
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
  // Solus tools show just their friendly label — never their args.
  if (solusToolKey(name)) return pretty
  if (!input) return pretty
  try {
    const parsed = JSON.parse(input)
    return getToolDescriptionFromParsed(name, parsed, { truncate })
  } catch {
    const trimmed = input.trim()
    if (truncate && trimmed.length > 60) return `${pretty}: ${trimmed.substring(0, 57)}...`
    return trimmed ? `${pretty}: ${trimmed}` : pretty
  }
}

/** Formats elapsed activity time for the right-hand rail. */
export function formatActivityDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = ms / 1000
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}

/** Total wall time the block covers, or null when no tool reported a completion
 *  time — the rail stays empty rather than printing a figure we don't have. */
export function activityDurationMs(tools: Message[]): number | null {
  let start = Infinity
  let end = -Infinity
  for (const tool of tools) {
    if (tool.thinkingMs) start = Math.min(start, tool.timestamp - tool.thinkingMs)
    start = Math.min(start, tool.timestamp)
    if (tool.toolCompletedAt) end = Math.max(end, tool.toolCompletedAt)
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
    try {
      for (const path of toolPathsFromParsed(JSON.parse(tool.toolInput))) paths.add(path)
    } catch {}
  }

  const lead = joinClauses(clauses)
  const sentence = lead ? `${lead.charAt(0).toUpperCase()}${lead.slice(1)}` : 'Used tools'
  if (paths.size === 0) return [{ text: sentence }]
  return [
    { text: `${sentence} ` },
    { text: `${paths.size} file${paths.size === 1 ? '' : 's'}`, strong: true },
  ]
}
