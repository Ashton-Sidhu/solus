import { createReadStream, existsSync, writeFileSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { MemoryCache } from '../../../shared/cache'
import { z } from 'zod'
import { encodePathAsFolder, stripInjectedContext } from '../utils'
import { extractPlanTitle } from '../plan-text'
import type { AnnotationIndex } from '../../plans/annotations'
import { isSolusWorktreePath, worktreeProjectRoot } from '../../../shared/types'
export { isSolusWorktreePath, worktreeProjectRoot }
import type { AgentId, PlanDescriptor } from '../../../shared/types'
import type { SessionLoadMessage } from '../../../shared/session-history'
import type { AskForApproval, SandboxPolicy } from './generated/v2'

const stringValueSchema = z.string()
const finiteNumberSchema = z.number().finite()
const messageContentPartSchema = z.union([
  z.string(),
  z.object({ text: z.string().optional() }),
])
const turnErrorSchema = z.union([
  z.string(),
  z.object({ message: z.string() }),
])
const spawnedThreadItemSchema = z.union([
  z.object({
    type: z.literal('subAgentActivity'),
    kind: z.literal('started'),
    id: z.string(),
    agentThreadId: z.string(),
  }),
  z.object({
    type: z.literal('collabAgentToolCall'),
    tool: z.literal('spawnAgent'),
    id: z.string(),
    receiverThreadIds: z.array(z.string().min(1)),
  }),
])
const toolResultSchema = z.object({
  contentItems: z.array(messageContentPartSchema).optional(),
  content: z.array(messageContentPartSchema).optional(),
})
const planItemSchema = z.object({
  step: z.string().optional(),
  text: z.string().optional(),
  description: z.string().optional(),
  title: z.string().optional(),
  status: z.string().optional(),
})
const planTextSchema = z.object({
  id: z.union([z.string(), finiteNumberSchema]).optional(),
  text: z.string().optional(),
  content: z.union([z.string(), z.array(messageContentPartSchema)]).optional(),
  markdown: z.string().optional(),
  message: z.union([
    z.string(),
    z.object({ content: z.union([z.string(), z.array(messageContentPartSchema)]).optional() }),
  ]).optional(),
  outputText: z.string().optional(),
  output_text: z.string().optional(),
  output: z.union([z.string(), z.array(messageContentPartSchema)]).optional(),
})

interface ChangedFileNodeObject {
  file_path?: string
  filePath?: string
  path?: string
  file?: string
  fileName?: string
  filename?: string
  old_path?: string
  new_path?: string
  oldPath?: string
  newPath?: string
  changes?: ChangedFileNode
  diff?: ChangedFileNode
  patch?: ChangedFileNode
}

type ChangedFileNode = string | ChangedFileNode[] | ChangedFileNodeObject

const changedFileNodeSchema: z.ZodType<ChangedFileNode> = z.lazy(() => z.union([
  z.string(),
  z.array(changedFileNodeSchema),
  z.object({
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
    changes: changedFileNodeSchema.optional(),
    diff: changedFileNodeSchema.optional(),
    patch: changedFileNodeSchema.optional(),
  }),
]))

interface ImageArtifactNodeObject {
  path?: string
  filePath?: string
  filepath?: string
  file_path?: string
  outputPath?: string
  output_path?: string
  localPath?: string
  local_path?: string
  imagePath?: string
  image_path?: string
  savedPath?: string
  saved_path?: string
  dataUrl?: string
  data_url?: string
  url?: string
  imageUrl?: string
  image_url?: string
  data?: string
  result?: ImageArtifactNode
  output?: ImageArtifactNode
  outputs?: ImageArtifactNode
  image?: ImageArtifactNode
  images?: ImageArtifactNode
  content?: ImageArtifactNode
  contentItems?: ImageArtifactNode
}

type ImageArtifactNode = string | ImageArtifactNode[] | ImageArtifactNodeObject

const imageArtifactNodeSchema: z.ZodType<ImageArtifactNode> = z.lazy(() => z.union([
  z.string(),
  z.array(imageArtifactNodeSchema),
  z.object({
    path: z.string().optional(),
    filePath: z.string().optional(),
    filepath: z.string().optional(),
    file_path: z.string().optional(),
    outputPath: z.string().optional(),
    output_path: z.string().optional(),
    localPath: z.string().optional(),
    local_path: z.string().optional(),
    imagePath: z.string().optional(),
    image_path: z.string().optional(),
    savedPath: z.string().optional(),
    saved_path: z.string().optional(),
    dataUrl: z.string().optional(),
    data_url: z.string().optional(),
    url: z.string().optional(),
    imageUrl: z.string().optional(),
    image_url: z.string().optional(),
    data: z.string().optional(),
    result: imageArtifactNodeSchema.optional(),
    output: imageArtifactNodeSchema.optional(),
    outputs: imageArtifactNodeSchema.optional(),
    image: imageArtifactNodeSchema.optional(),
    images: imageArtifactNodeSchema.optional(),
    content: imageArtifactNodeSchema.optional(),
    contentItems: imageArtifactNodeSchema.optional(),
  }),
]))

function parsedString<Value>(value: Value): string | undefined {
  const parsed = stringValueSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function parsedFiniteNumber<Value>(value: Value): number | undefined {
  const parsed = finiteNumberSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export const CODEX_CHANGE_PATH_KEYS = [
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

export interface CodexThreadSummary {
  id?: string
  name?: string | null
  preview?: string | null
  cwd?: string | null
  path?: string | null
  updatedAt?: number | string | null
  createdAt?: number | string | null
}

export interface CodexTurnHistory {
  id?: string
  status?: string | null
  error?: unknown
  startedAt?: number | string | null
  completedAt?: number | string | null
  durationMs?: number | null
  items?: CodexHistoryItem[]
}

/** Select the last source turn that a live-session fork may include. If the
 * active turn is not in thread/read yet, the final returned turn is still safe. */
export function codexForkCutoffTurnId(
  turns: CodexTurnHistory[],
  activeTurnId: string | null,
): string | undefined {
  if (turns.length === 0) return undefined
  if (activeTurnId) {
    const activeIndex = turns.findIndex((turn) => turn.id === activeTurnId)
    if (activeIndex === -1) return turns[turns.length - 1]?.id
    return activeIndex > 0 ? turns[activeIndex - 1]?.id : undefined
  }
  return turns.length > 1 ? turns[turns.length - 2]?.id : undefined
}

export type CodexHistoryItem = {
  id?: string
  type?: string
  text?: string
  content?: Array<{ type?: string; text?: string }>
  command?: string
  aggregatedOutput?: string
  result?: unknown
  error?: unknown
  status?: string
  name?: string
  server?: string
  tool?: string
  namespace?: string
  arguments?: unknown
  contentItems?: unknown[] | null
  success?: boolean | null
  changes?: unknown[]
  summary?: unknown
  kind?: string
  agentThreadId?: string
  agentPath?: string
}

export interface ScannedCodexPlan {
  provider: AgentId
  planToolUseId: string
  sessionId: string
  projectPath: string
  cwd: string
  timestamp: number
  title: string
  excerpt: string
  planContent: string
  derivedStatus: 'pending' | 'accepted' | 'rejected'
  commentCount: number
  bookmarked: boolean
  bookmarkedAt?: number
}

export function isNormalStreamingTextNotification(
  kind: 'notification' | 'server-request',
  msg: { method?: string },
  params: any,
): boolean {
  return kind === 'notification' &&
    msg.method === 'item/agentMessage/delta' &&
    stringValueSchema.safeParse(params?.delta).success
}

export async function scanCodexPlans(thread: CodexThreadSummary, annotations: AnnotationIndex): Promise<ScannedCodexPlan[]> {
  if (!thread.id || !thread.path || !existsSync(thread.path)) return []

  const sessionId = thread.id
  const transcriptPath = thread.path
  const cwd = thread.cwd || process.cwd()
  const projectPath = encodePathAsFolder(cwd)
  const out: ScannedCodexPlan[] = []
  let activePlanTurn: { turnId: string; timestamp: number } | null = null

  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: createReadStream(transcriptPath) })
    rl.on('line', (line: string) => {
      try {
        const obj = JSON.parse(line)
        const timestamp = toEpochMs(obj.timestamp)

        if (obj.type === 'event_msg' && obj.payload?.type === 'task_started') {
          activePlanTurn = obj.payload?.collaboration_mode_kind === 'plan'
            ? {
                turnId: String(obj.payload?.turn_id || obj.payload?.turnId || timestamp),
                timestamp: toEpochMs(obj.payload?.started_at ?? obj.timestamp),
              }
            : null
          return
        }

        if (obj.type !== 'response_item') return
        const payload = obj.payload

        if (payload?.type === 'plan') {
          const content = extractPlanText(payload)
          if (content.trim()) {
            const id = `codex-plan-${payload.id || activePlanTurn?.turnId || timestamp}`
            out.push(makeCodexPlan({
              sessionId,
              planToolUseId: id,
              projectPath,
              cwd,
              timestamp,
              content,
              annotations,
            }))
          }
          return
        }

        if (
          activePlanTurn &&
          payload?.type === 'message' &&
          payload.role === 'assistant' &&
          payload.phase === 'final_answer'
        ) {
          const content = textFromCodexMessageContent(payload.content)
          if (content.trim()) {
            out.push(makeCodexPlan({
              sessionId,
              planToolUseId: `codex-plan-${activePlanTurn.turnId}`,
              projectPath,
              cwd,
              timestamp: activePlanTurn.timestamp || timestamp,
              content,
              annotations,
            }))
          }
        }
      } catch {}
    })
    rl.on('close', () => resolve())
  })

  const deduped = new Map<string, ScannedCodexPlan>()
  for (const plan of out) deduped.set(plan.planToolUseId, plan)
  return Array.from(deduped.values())
}

export function codexThreadBelongsToProject(thread: CodexThreadSummary, projectRoot?: string): boolean {
  if (!projectRoot) return true
  const cwd = thread.cwd?.replace(/\/$/, '')
  if (!cwd) return false
  return cwd === projectRoot || worktreeProjectRoot(cwd) === projectRoot
}

// Newest entries live at the end of a thread's JSONL, so the latest activity
// timestamp is derivable from the file tail; parsing the whole transcript
// scales with total bytes on disk rather than with what changed.
const ACTIVITY_SCAN_TAIL_BYTES = 64 * 1024
const activityTimestampCache = new MemoryCache<string, { mtimeMs: number; size: number; timestamp: number | null }>({ maxEntries: 512 })

function latestActivityTimestampInLine(line: string): number | null {
  try {
    const obj = JSON.parse(line)
    if (obj.type === 'event_msg' && obj.payload?.type === 'task_started') {
      return parseEpochMs(obj.payload?.started_at ?? obj.timestamp)
    }
    if (obj.type === 'response_item') return parseEpochMs(obj.timestamp)
  } catch {}
  return null
}

async function scanWholeTranscriptActivityTimestamp(transcriptPath: string): Promise<number | null> {
  let latest: number | null = null
  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: createReadStream(transcriptPath) })
    rl.on('line', (line: string) => {
      const timestamp = latestActivityTimestampInLine(line)
      if (timestamp !== null) latest = Math.max(latest ?? 0, timestamp)
    })
    rl.on('close', () => resolve())
    rl.on('error', () => resolve())
  })
  return latest
}

export async function scanCodexThreadActivityTimestamp(thread: CodexThreadSummary): Promise<number | null> {
  if (!thread.path) return null
  const transcriptPath = thread.path

  let fileStat
  try {
    fileStat = await stat(transcriptPath)
  } catch {
    return null
  }
  const cached = activityTimestampCache.get(transcriptPath)
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) return cached.timestamp

  let latest: number | null = null
  try {
    const readStart = Math.max(0, fileStat.size - ACTIVITY_SCAN_TAIL_BYTES)
    const handle = await open(transcriptPath, 'r')
    try {
      const length = fileStat.size - readStart
      const buffer = Buffer.alloc(length)
      // Honor short reads (file truncated between stat and read) — decoding the
      // NUL-filled remainder would poison the newest line.
      const { bytesRead } = await handle.read(buffer, 0, length, readStart)
      const lines = buffer.toString('utf8', 0, bytesRead).split('\n')
      // The tail almost always starts mid-line; drop the partial first entry.
      if (readStart > 0) lines.shift()
      for (const line of lines) {
        const timestamp = latestActivityTimestampInLine(line)
        if (timestamp !== null) latest = Math.max(latest ?? 0, timestamp)
      }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }

  // A tail holding no parsable timestamp (e.g. one oversized item) falls back
  // to the full scan so the answer matches the whole-file read.
  if (latest === null && fileStat.size > ACTIVITY_SCAN_TAIL_BYTES) {
    latest = await scanWholeTranscriptActivityTimestamp(transcriptPath)
  }
  activityTimestampCache.set(transcriptPath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, timestamp: latest })
  return latest
}

export function makeCodexPlan(opts: {
  sessionId: string
  planToolUseId: string
  projectPath: string
  cwd: string
  timestamp: number
  content: string
  annotations: AnnotationIndex
}): ScannedCodexPlan {
  const ann = opts.annotations.get(`${opts.sessionId}__${opts.planToolUseId}`)
  const status = z.enum(['pending', 'accepted', 'rejected']).catch('pending').parse(ann?.status)
  return {
    provider: 'codex',
    planToolUseId: opts.planToolUseId,
    sessionId: opts.sessionId,
    projectPath: opts.projectPath,
    cwd: opts.cwd,
    timestamp: opts.timestamp,
    title: ann?.title || extractPlanTitle(opts.content),
    excerpt: extractCodexPlanExcerpt(opts.content),
    planContent: opts.content,
    derivedStatus: status,
    commentCount: ann?.comments?.length ?? 0,
    bookmarked: !!ann?.bookmarked,
    bookmarkedAt: ann?.bookmarkedAt,
  }
}

export function groupCodexPlansBySession(scanned: ScannedCodexPlan[]): PlanDescriptor[] {
  const groups = new Map<string, ScannedCodexPlan[]>()
  for (const plan of scanned) {
    let group = groups.get(plan.sessionId)
    if (!group) {
      group = []
      groups.set(plan.sessionId, group)
    }
    group.push(plan)
  }

  const descriptors: PlanDescriptor[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => b.timestamp - a.timestamp)
    const latest = group[0]
    const revisions = group.map((plan) => ({
      planToolUseId: plan.planToolUseId,
      timestamp: plan.timestamp,
      title: plan.title,
      excerpt: plan.excerpt,
      status: plan.derivedStatus,
      commentCount: plan.commentCount,
    }))
    const anyBookmarked = group.some((plan) => plan.bookmarked)
    const latestBookmarkedAt = group.reduce<number | undefined>(
      (max, plan) => (plan.bookmarkedAt ? Math.max(max ?? 0, plan.bookmarkedAt) : max),
      undefined,
    )

    descriptors.push({
      provider: 'codex',
      planToolUseId: latest.planToolUseId,
      sessionId: latest.sessionId,
      projectPath: latest.projectPath,
      cwd: latest.cwd,
      timestamp: latest.timestamp,
      title: latest.title,
      excerpt: latest.excerpt,
      status: latest.derivedStatus,
      commentCount: latest.commentCount,
      bookmarked: anyBookmarked,
      bookmarkedAt: latestBookmarkedAt,
      revisions,
    })
  }

  return descriptors.sort((a, b) => b.timestamp - a.timestamp)
}

export function textFromCodexMessageContent<Content>(content: Content): string {
  const plainText = parsedString(content)
  if (plainText !== undefined) return plainText
  const parsed = z.array(messageContentPartSchema).safeParse(content)
  if (!parsed.success) return ''
  return parsed.data.map((part) => parsedString(part) ?? part.text ?? '').join('')
}

export function extractCodexPlanExcerpt(planContent: string): string {
  const lines = planContent
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s*/, '').trim())
    .filter(Boolean)
  return lines.slice(0, 2).join(' · ').slice(0, 180)
}

export function extractCodexChangedFilePaths<Source>(source: Source): string[] {
  const paths = new Set<string>()

  function addPath(value: string | undefined): void {
    let path = value?.trim() ?? ''
    if (!path || path === '/dev/null') return
    if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) {
      path = path.slice(1, -1)
    }
    paths.add(path)
  }

  function addDiffPaths(diff: string): void {
    for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
      addPath(match[2] || match[1])
    }
    for (const match of diff.matchAll(/^(?:---|\+\+\+) (?:a|b)\/(.+)$/gm)) {
      addPath(match[1])
    }
  }

  function visit(value: ChangedFileNode): void {
    const text = parsedString(value)
    if (text !== undefined) {
      addDiffPaths(text)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    for (const key of CODEX_CHANGE_PATH_KEYS) {
      addPath(value[key])
    }
    if (value.changes) visit(value.changes)
    if (value.diff) visit(value.diff)
    if (value.patch) visit(value.patch)
  }

  const parsed = changedFileNodeSchema.safeParse(source)
  if (parsed.success) visit(parsed.data)
  return [...paths]
}

export function codexItemToMessage(item: CodexHistoryItem, timestamp: number): SessionLoadMessage | null {
  if (item.type === 'userMessage') {
    const content = stripInjectedContext((item.content ?? [])
      .map((part) => part.type === 'text' ? part.text : '')
      .filter(Boolean)
      .join('\n'))
    return content ? { role: 'user', content, timestamp } : null
  }

  if (item.type === 'agentMessage') {
    return item.text ? { role: 'assistant', content: item.text, timestamp } : null
  }

  if (item.type === 'plan') {
    return item.text
      ? {
          role: 'plan',
          content: '',
          planContent: item.text,
          planToolUseId: `codex-plan-${item.id || timestamp}`,
          timestamp,
        }
      : null
  }

  if (item.type === 'reasoning') {
    // Reasoning/thinking span, carried for provider handoffs; display surfaces
    // skip this role. Prefer the concise summary over the raw content.
    const content = codexReasoningText(item)
    return content ? { role: 'reasoning', content, timestamp } : null
  }

  if (item.type === 'subAgentActivity') {
    if (item.kind === 'started') {
      return {
        role: 'tool',
        content: '',
        toolName: 'spawnAgent',
        toolId: item.id,
        toolInput: codexSubagentActivityInput(item),
        toolStatus: 'running',
        isSubagent: true,
        subagentType: 'codex',
        timestamp,
      }
    }
    if (item.kind === 'interrupted') {
      return {
        role: 'tool_result',
        content: 'Interrupted',
        toolResultForId: item.id,
        toolResultIsError: true,
        timestamp,
      }
    }
    return null
  }

  const toolName = codexToolNameForItem(item)
  if (!toolName) return null

  if (item.type === 'commandExecution') {
    return {
      role: 'tool',
      content: item.aggregatedOutput || item.status || '',
      toolName,
      toolInput: item.command,
      timestamp,
    }
  }

  if (item.type === 'fileChange') {
    const toolInput = Array.isArray(item.changes)
      ? JSON.stringify({ changes: item.changes })
      : parsedString(item.aggregatedOutput) || parsedString(item.result) || null
    if (!toolInput) return null
    return {
      role: 'tool',
      content: '',
      toolName,
      toolInput,
      timestamp,
    }
  }

  if (item.type === 'imageGeneration') {
    // Resolve the image path once, here in the main process, so the renderer's
    // transcript loader just reads `path` instead of re-walking the raw item.
    return {
      role: 'tool',
      content: '',
      toolName,
      toolInput: JSON.stringify({ path: codexImageArtifactPath(item) ?? undefined }),
      timestamp,
    }
  }

  const isCodexSubagent = item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent'
  return {
    role: 'tool',
    content: codexToolResultText(
      item.result ?? (item.contentItems ? { contentItems: item.contentItems } : undefined),
    ),
    toolName,
    toolInput: codexToolInputFromArguments(item.arguments),
    isSubagent: isCodexSubagent || undefined,
    subagentType: isCodexSubagent ? 'codex' : undefined,
    timestamp,
  }
}

/**
 * Rebuild one persisted Codex turn with a real end timestamp. `thread/read`
 * stores timing on the turn rather than its individual items; stamping the last
 * visible message with that completion time preserves the turn duration after
 * the renderer reloads the transcript.
 */
export function codexTurnToMessages(turn: CodexTurnHistory): SessionLoadMessage[] {
  const startedAt = toEpochMs(turn.startedAt)
  const messages = (turn.items ?? [])
    .map((item) => codexItemToMessage(item, startedAt))
    .filter((message): message is SessionLoadMessage => message !== null)
  const durationMs = parsedFiniteNumber(turn.durationMs)
  const completedAt = parseEpochMs(turn.completedAt)
    ?? (durationMs && durationMs > 0
      ? startedAt + durationMs
      : null)
  if (turn.status === 'failed') {
    const parsedError = turnErrorSchema.safeParse(turn.error)
    const error = parsedError.success
      ? parsedString(parsedError.data) ?? parsedError.data.message
      : 'Codex turn failed'
    messages.push({
      role: 'system',
      content: `Error: ${error}`,
      timestamp: completedAt ?? startedAt,
    })
  }
  const lastMessage = messages.at(-1)
  if (lastMessage && completedAt !== null && completedAt > startedAt) {
    lastMessage.timestamp = completedAt
  }
  return messages
}

/** Convert only the newest turns needed for a windowed renderer hydration. */
export function codexTurnsToMessages(
  turns: CodexTurnHistory[],
  limit?: number,
): SessionLoadMessage[] {
  if (!limit || limit <= 0) {
    const messages: SessionLoadMessage[] = []
    for (const turn of turns) messages.push(...codexTurnToMessages(turn))
    return messages
  }

  const newestTurnMessages: SessionLoadMessage[][] = []
  let messageCount = 0
  for (let index = turns.length - 1; index >= 0 && messageCount < limit; index--) {
    const messages = codexTurnToMessages(turns[index])
    newestTurnMessages.push(messages)
    messageCount += messages.length
  }
  newestTurnMessages.reverse()
  const messages = newestTurnMessages.flat()
  return messages.length > limit ? messages.slice(-limit) : messages
}

export function codexSubagentActivityInput(item: {
  agentThreadId?: unknown
  agentPath?: unknown
}): string {
  const agentPath = parsedString(item.agentPath) ?? ''
  const taskName = agentPath.split('/').filter(Boolean).at(-1)?.replaceAll('_', ' ') || 'Sub-agent'
  return JSON.stringify({
    subagent_type: 'codex',
    description: taskName,
    agent_thread_id: parsedString(item.agentThreadId),
    agent_path: agentPath || undefined,
  })
}

export function codexSpawnedThreadLinks<Item>(item: Item): Array<{ threadId: string; toolId: string }> {
  const parsed = spawnedThreadItemSchema.safeParse(item)
  if (!parsed.success) return []
  const candidate = parsed.data
  if (candidate.type === 'subAgentActivity') {
    return [{ threadId: candidate.agentThreadId, toolId: candidate.id }]
  }
  return candidate.receiverThreadIds.map((threadId) => ({ threadId, toolId: candidate.id }))
}

function joinReasoningStrings<Value>(value: Value): string {
  const parsed = z.array(messageContentPartSchema).safeParse(value)
  if (!parsed.success) return ''
  return parsed.data
    .map((part) => parsedString(part) ?? part.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** A reasoning item's text, preferring the concise `summary` over raw `content`.
 *  Empty for non-reasoning items, so callers filter with a truthiness check. */
function codexReasoningText(item: CodexHistoryItem): string {
  if (item.type !== 'reasoning') return ''
  return joinReasoningStrings(item.summary) || joinReasoningStrings(item.content)
}

function codexToolResultText<Result>(result: Result): string {
  const text = parsedString(result)
  if (text !== undefined) return text
  const parsed = toolResultSchema.safeParse(result)
  if (!parsed.success) return ''
  const content = parsed.data.contentItems ?? parsed.data.content ?? []
  return content
    .map((item) => parsedString(item) ?? item.text ?? '')
    .filter(Boolean)
    .join('\n')
}

export function codexToolInputFromArguments<Arguments>(args: Arguments): string | undefined {
  if (args === undefined) return undefined
  return parsedString(args) ?? JSON.stringify(args)
}

export function codexToolNameForItem(item: { type?: string; name?: string; server?: string; tool?: string; namespace?: string }): string | null {
  switch (item.type) {
    case 'commandExecution':
      return 'exec_command'
    case 'fileChange':
      return 'Edit'
    case 'mcpToolCall':
    case 'mcp_tool_call':
      return item.server && item.tool ? `${item.server}.${item.tool}` : item.name || 'MCP Tool'
    case 'dynamicToolCall':
      return item.namespace ? `${item.namespace}.${item.tool}` : item.tool || item.name || 'Tool'
    case 'webSearch':
      return 'WebSearch'
    case 'imageGeneration':
      return 'ImageGeneration'
    case 'collabAgentToolCall':
      return item.tool || item.name || 'Agent'
    case 'functionCall':
    case 'function_call':
      return item.name || item.type
    default:
      return null
  }
}

// ─── Codex image-artifact extraction ───
// Codex's native ImageGeneration tool returns the generated image under one of
// several keys (a file path) or inline as a data URL. Both the live event
// normalizer and the history loader use this single helper so there is one
// source of truth for "where's the image".

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

/** Resolve the on-disk image path for a Codex imageGeneration item, persisting
 *  inline data URLs to a temp file. Returns null when nothing renderable exists. */
export function codexImageArtifactPath<Value>(value: Value): string | null {
  const parsed = imageArtifactNodeSchema.safeParse(value)
  if (!parsed.success) return null

  function visit(node: ImageArtifactNode): string | null {
    const text = parsedString(node)
    if (text !== undefined) return imagePathFromString(text)
    if (Array.isArray(node)) {
      for (const entry of node) {
        const found = visit(entry)
        if (found) return found
      }
      return null
    }

    const candidates = [
      node.path,
      node.filePath,
      node.filepath,
      node.file_path,
      node.outputPath,
      node.output_path,
      node.localPath,
      node.local_path,
      node.imagePath,
      node.image_path,
      node.savedPath,
      node.saved_path,
      node.dataUrl,
      node.data_url,
      node.url,
      node.imageUrl,
      node.image_url,
      node.data,
    ]
    for (const candidate of candidates) {
      if (!candidate) continue
      const found = imagePathFromString(candidate)
      if (found) return found
    }

    const nested = [node.result, node.output, node.outputs, node.image, node.images, node.content, node.contentItems]
    for (const child of nested) {
      if (!child) continue
      const found = visit(child)
      if (found) return found
    }
    return null
  }

  return visit(parsed.data)
}

function imagePathFromString(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('data:image/')) return persistImageDataUrl(trimmed)
  const ext = extname(trimmed).toLowerCase()
  if (!IMAGE_EXTS.has(ext)) return null
  return existsSync(trimmed) ? trimmed : null
}

function persistImageDataUrl(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i)
  if (!match) return null
  const rawExt = match[1].toLowerCase()
  const ext = rawExt === 'jpeg' ? 'jpg' : rawExt === 'svg+xml' ? 'svg' : rawExt
  if (!IMAGE_EXTS.has(`.${ext}`)) return null
  const filePath = join(tmpdir(), `solus-codex-image-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
  try {
    writeFileSync(filePath, Buffer.from(match[2], 'base64'))
    return filePath
  } catch {
    return null
  }
}

export function toEpochMs(value: number | string | null | undefined): number {
  return parseEpochMs(value) ?? Date.now()
}

export function parseEpochMs(value: number | string | null | undefined): number | null {
  const numericValue = parsedFiniteNumber(value)
  if (numericValue !== undefined) return numericValue < 10_000_000_000 ? numericValue * 1000 : numericValue
  const stringValue = parsedString(value)
  if (stringValue !== undefined) {
    const parsed = Date.parse(stringValue)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function toIsoTimestamp(value: number | string | null | undefined): string {
  return new Date(toEpochMs(value)).toISOString()
}

export function approvalPolicyFor(mode: 'ask' | 'auto' | 'plan'): AskForApproval {
  if (mode === 'auto') return 'never'
  if (mode === 'plan') return 'never'
  return 'untrusted'
}

export function sandboxPolicyFor(mode: 'ask' | 'auto' | 'plan'): SandboxPolicy {
  if (mode === 'plan') {
    return {
      type: 'readOnly',
      networkAccess: true,
    }
  }
  return { type: 'dangerFullAccess' }
}

export function planFromCompletedItem(params: any): { id: string; text: string } | null {
  const item = params?.item
  const plan = item?.type === 'plan' ? item : item?.plan
  const text = extractPlanText(plan) || extractPlanText(item)
  if (!text.trim()) return null

  return {
    id: plan?.id ? `codex-plan-${plan.id}` : `codex-plan-${item?.id || params?.turnId || params?.turn?.id || Date.now()}`,
    text,
  }
}

export function planTextFromPlanUpdated(params: any): string {
  const parsed = z.array(planItemSchema).safeParse(params?.plan)
  const plan = parsed.success ? parsed.data : []
  const items = plan
    .map((item) => {
      const content = (item.step || item.text || item.description || item.title || '').trim()
      if (!content) return null
      const marker = planItemMarker(item?.status)
      return marker ? `- ${marker} ${content}` : `- ${content}`
    })
    .filter((line: string | null): line is string => !!line)

  if (items.length === 0) return ''
  return `# Plan\n\n${items.join('\n')}`
}

function planItemMarker(status: string | undefined): string {
  if (!status) return '[ ]'
  const normalized = status.trim().replace(/[\s-]/g, '_').toLowerCase()
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done' || normalized === 'success') return '[x]'
  if (normalized === 'in_progress' || normalized === 'inprogress' || normalized === 'running' || normalized === 'active' || normalized === 'current') return '(In progress)'
  return '[ ]'
}

export function extractPlanText<Value>(value: Value): string {
  const directText = parsedString(value)
  if (directText !== undefined) return directText

  const parsed = planTextSchema.safeParse(value)
  if (!parsed.success) return ''
  const plan = parsed.data
  for (const candidate of [plan.text, plan.markdown, plan.outputText, plan.output_text]) {
    if (candidate?.trim()) return candidate
  }
  const messageText = parsedString(plan.message)
  if (messageText?.trim()) return messageText
  const messageContent = messageText === undefined && plan.message ? plan.message.content : undefined
  const content = plan.content || messageContent || plan.output
  return textFromCodexMessageContent(content)
}

export function isInterruptedTurnStatus<Status>(status: Status): boolean {
  return status === 'interrupted' || status === 'cancelled' || status === 'canceled' || status === 'aborted'
}
