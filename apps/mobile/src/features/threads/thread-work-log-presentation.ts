// Adapted from T3 Code packages/client-runtime/src/work-log/presentation.ts and
// apps/mobile/src/lib/threadActivity.ts (MIT, see UPSTREAM.md).
import { z } from 'zod'
import type { TranscriptItem } from '../conversation/lib/transcript-model'

/**
 * T3's work-log wording for Solus tool calls: what a group of calls did
 * ("Read 3 files and ran 2 commands"), what one call is doing now ("Running
 * bun"), and each call's one-line label. Solus tool names are the provider's
 * own (Claude's `Read`, Codex's `exec_command`), classified here by action.
 */

export type ToolTranscriptItem = Extract<TranscriptItem, { kind: 'tool' }>

export type ToolGroupAction = 'read' | 'code-search' | 'edit' | 'command' | 'search' | 'browser' | 'device' | 'agent' | 'other'

const ACTION_BY_TOOL: Readonly<Partial<Record<string, ToolGroupAction>>> = {
  Read: 'read',
  NotebookRead: 'read',
  LS: 'read',
  read_file: 'read',
  view_image: 'read',
  Glob: 'code-search',
  Grep: 'code-search',
  grep: 'code-search',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  apply_patch: 'edit',
  file_change: 'edit',
  Bash: 'command',
  BashOutput: 'command',
  KillShell: 'command',
  exec_command: 'command',
  shell: 'command',
  local_shell: 'command',
  command_execution: 'command',
  WebSearch: 'search',
  web_search: 'search',
  WebFetch: 'browser',
  Task: 'agent',
  Agent: 'agent',
}

export function toolGroupAction(toolName: string): ToolGroupAction {
  const known = ACTION_BY_TOOL[toolName]
  if (known) return known
  if (/browser_/.test(toolName)) return 'browser'
  if (/device_/.test(toolName)) return 'device'
  return 'other'
}

const toolInputSchema = z.object({
  file_path: z.string().optional(),
  notebook_path: z.string().optional(),
  path: z.string().optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  cmd: z.union([z.string(), z.array(z.string())]).optional(),
  pattern: z.string().optional(),
  query: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
})

export type ParsedToolInput = z.infer<typeof toolInputSchema>

const parseCache = new Map<string, ParsedToolInput | null>()
const PARSE_CACHE_MAX_ENTRIES = 500

/** A tool call's input as the fields the labels read; null for free text. */
export function parseToolInput(input: string | null): ParsedToolInput | null {
  if (!input) return null
  const cached = parseCache.get(input)
  if (cached !== undefined) return cached
  let parsed: ParsedToolInput | null = null
  try {
    const result = toolInputSchema.safeParse(JSON.parse(input))
    parsed = result.success ? result.data : null
  } catch {
    parsed = null
  }
  if (parseCache.size >= PARSE_CACHE_MAX_ENTRIES) {
    const oldest = parseCache.keys().next().value
    if (oldest !== undefined) parseCache.delete(oldest)
  }
  parseCache.set(input, parsed)
  return parsed
}

function commandText(parsed: ParsedToolInput | null): string | null {
  const command = parsed?.command ?? parsed?.cmd
  if (Array.isArray(command)) {
    // Codex wraps commands as ["bash", "-lc", "<script>"].
    const script = command.length >= 3 && /sh$/.test(command[0] ?? '') && command[1]?.startsWith('-') ? command[2] : command.join(' ')
    return script?.trim() || null
  }
  return command?.trim() || null
}

function filePath(parsed: ParsedToolInput | null): string | null {
  return parsed?.file_path ?? parsed?.notebook_path ?? parsed?.path ?? null
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

/** The first word of a command, without a leading env assignment or path. */
export function commandProgramName(command: string): string {
  const words = command.trim().split(/\s+/)
  const program = words.find((word) => !/^[A-Z_][A-Z0-9_]*=/.test(word)) ?? words[0] ?? command
  return basename(program)
}

/** One line, as a row shows it. */
function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** A call's own label: its command, its file, or its search. */
export function toolRowLabel(tool: Pick<ToolTranscriptItem, 'toolName' | 'input'>, expanded = false): string {
  const parsed = parseToolInput(tool.input)
  const action = toolGroupAction(tool.toolName)
  const command = commandText(parsed)
  if (command) return expanded ? command : compact(command)
  const path = filePath(parsed)
  if ((action === 'read' || action === 'edit') && path) return expanded ? path : basename(path)
  if ((action === 'code-search' || action === 'search') && (parsed?.pattern || parsed?.query)) {
    return compact(parsed.pattern ?? parsed.query ?? '')
  }
  if (action === 'browser' && parsed?.url) return parsed.url
  const detail = parsed?.description ?? path
  return detail ? `${tool.toolName} ${compact(detail)}` : tool.toolName
}

/** What one call is doing, in the present while it runs and the past after. */
export function toolActivitySummary(tool: Pick<ToolTranscriptItem, 'toolName' | 'input' | 'status'>): string {
  const running = tool.status === 'running'
  const parsed = parseToolInput(tool.input)
  const command = commandText(parsed)
  const path = filePath(parsed)
  switch (toolGroupAction(tool.toolName)) {
    case 'command':
      if (command) return `${running ? 'Running' : tool.status === 'error' ? 'Failed' : 'Ran'} ${commandProgramName(command)}`
      return running ? 'Running command' : 'Ran command'
    case 'read':
      return `${running ? 'Reading' : 'Read'} ${path ? basename(path) : 'file'}`
    case 'edit':
      return `${running ? 'Editing' : 'Edited'} ${path ? basename(path) : 'file'}`
    case 'code-search':
      return running ? 'Searching code' : 'Searched code'
    case 'search':
      return running ? 'Searching the web' : 'Searched the web'
    case 'browser':
      return running ? 'Using browser' : 'Used browser'
    case 'device':
      return running ? 'Using device controls' : 'Used device controls'
    case 'agent':
      return parsed?.description ? compact(parsed.description) : running ? 'Delegating' : 'Delegated'
    case 'other':
      return tool.toolName
  }
}

function actionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case 'read':
      return `Read ${count} ${count === 1 ? 'file' : 'files'}`
    case 'edit':
      return `Changed ${count} ${count === 1 ? 'file' : 'files'}`
    case 'command':
      return `Ran ${count} ${count === 1 ? 'command' : 'commands'}`
    case 'device':
      return `Used device controls ${count} ${count === 1 ? 'time' : 'times'}`
    case 'browser':
      return `Used browser ${count} ${count === 1 ? 'time' : 'times'}`
    case 'search':
      return `Searched the web ${count} ${count === 1 ? 'time' : 'times'}`
    case 'code-search':
      return `Searched code ${count} ${count === 1 ? 'time' : 'times'}`
    case 'agent':
      return `Delegated ${count} ${count === 1 ? 'task' : 'tasks'}`
    case 'other':
      return `Used ${count} ${count === 1 ? 'tool' : 'tools'}`
  }
}

function actionPriority(action: ToolGroupAction): number {
  if (action === 'command' || action === 'edit' || action === 'agent') return 0
  if (action === 'other') return 2
  return 1
}

/**
 * A finished group's sentence: its two weightiest actions, then a count of
 * the rest. One call reads as itself.
 */
export function summarizeToolGroup(tools: ReadonlyArray<Pick<ToolTranscriptItem, 'toolName' | 'input' | 'status'>>): string {
  const only = tools.length === 1 ? tools[0] : undefined
  if (only) return toolGroupAction(only.toolName) === 'edit' ? actionLabel('edit', 1) : toolActivitySummary(only)
  const groups = new Map<ToolGroupAction, number>()
  for (const tool of tools) {
    const action = toolGroupAction(tool.toolName)
    groups.set(action, (groups.get(action) ?? 0) + 1)
  }
  const summaries = [...groups].map(([action, count], index) => ({ action, count, index, priority: actionPriority(action) }))
  const selected = [...summaries]
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
  const labels = selected.map(({ action, count }) => actionLabel(action, count))
  const remaining = tools.length - selected.reduce((count, group) => count + group.count, 0)
  if (remaining > 0) labels.push(`Performed ${remaining} other ${remaining === 1 ? 'action' : 'actions'}`)
  const sentence = labels.map((label, index) => (index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)))
  return sentence.length < 3 ? sentence.join(' and ') : `${sentence.slice(0, -1).join(', ')}, and ${sentence.at(-1)}`
}

/** The icon a group shows: its one action, or a hammer for a mix. */
export function toolGroupSummaryKind(tools: ReadonlyArray<Pick<ToolTranscriptItem, 'toolName'>>): ToolGroupAction | 'mixed' {
  const actions = new Set(tools.map((tool) => toolGroupAction(tool.toolName)))
  return actions.size === 1 ? actions.values().next().value! : 'mixed'
}

/** An expanded call's full detail: the command or input, then the error head. */
export function toolFullDetail(tool: Pick<ToolTranscriptItem, 'input' | 'errorHead'>): string | null {
  const parsed = parseToolInput(tool.input)
  const command = commandText(parsed)
  let body: string | null = command
  if (!body && tool.input) {
    try {
      body = JSON.stringify(JSON.parse(tool.input), null, 2)
    } catch {
      body = tool.input
    }
  }
  return [body, tool.errorHead].filter((part): part is string => !!part && part.trim().length > 0).join('\n\n') || null
}
