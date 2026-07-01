import { createReadStream, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { encodePathAsFolder, stripInjectedContext } from '../utils'
import { extractPlanTitle } from '../plan-text'
import type { AnnotationIndex } from '../../plans/annotations'
import { isSolusWorktreePath, worktreeProjectRoot } from '../../../shared/types'
export { isSolusWorktreePath, worktreeProjectRoot }
import type { AgentId, PlanDescriptor } from '../../../shared/types'
import type { SessionLoadMessage } from '../../../shared/claude-types'

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
  startedAt?: number | string | null
  items?: CodexHistoryItem[]
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
  changes?: unknown[]
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
    typeof params?.delta === 'string'
}

export async function scanCodexPlans(thread: CodexThreadSummary, annotations: AnnotationIndex): Promise<ScannedCodexPlan[]> {
  if (!thread.id || !thread.path || !existsSync(thread.path)) return []

  const sessionId = thread.id
  const cwd = thread.cwd || process.cwd()
  const projectPath = encodePathAsFolder(cwd)
  const out: ScannedCodexPlan[] = []
  let activePlanTurn: { turnId: string; timestamp: number } | null = null

  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: createReadStream(thread.path!) })
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

export async function scanCodexThreadActivityTimestamp(thread: CodexThreadSummary): Promise<number | null> {
  if (!thread.path || !existsSync(thread.path)) return null

  let latest: number | null = null
  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: createReadStream(thread.path!) })
    rl.on('line', (line: string) => {
      try {
        const obj = JSON.parse(line)
        let timestamp: number | null = null

        if (obj.type === 'event_msg' && obj.payload?.type === 'task_started') {
          timestamp = parseEpochMs(obj.payload?.started_at ?? obj.timestamp)
        } else if (obj.type === 'response_item') {
          timestamp = parseEpochMs(obj.timestamp)
        }

        if (timestamp !== null) latest = Math.max(latest ?? 0, timestamp)
      } catch {}
    })
    rl.on('close', () => resolve())
    rl.on('error', () => resolve())
  })

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
  const ann = opts.annotations[`${opts.sessionId}__${opts.planToolUseId}`]
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
    derivedStatus: (ann?.status ?? 'pending') as 'pending' | 'accepted' | 'rejected',
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

export function textFromCodexMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string') return text
      }
      return ''
    })
    .join('')
}

export function extractCodexPlanExcerpt(planContent: string): string {
  const lines = planContent
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s*/, '').trim())
    .filter(Boolean)
  return lines.slice(0, 2).join(' · ').slice(0, 180)
}

export function extractCodexChangedFilePaths(source: unknown): string[] {
  const paths = new Set<string>()

  function addPath(value: unknown): void {
    if (typeof value !== 'string') return
    let path = value.trim()
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

  function visit(value: unknown): void {
    if (!value) return
    if (typeof value === 'string') {
      addDiffPaths(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object') return

    const record = value as Record<string, unknown>
    for (const key of CODEX_CHANGE_PATH_KEYS) {
      addPath(record[key])
    }
    visit(record.changes)
    visit(record.diff)
    visit(record.patch)
  }

  visit(source)
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
      : typeof item.aggregatedOutput === 'string' && item.aggregatedOutput
        ? item.aggregatedOutput
        : typeof item.result === 'string' && item.result
          ? item.result
          : null
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

  return {
    role: 'tool',
    content: codexToolResultText(item.result),
    toolName,
    toolInput: codexToolInputFromArguments(item.arguments),
    timestamp,
  }
}

function codexToolResultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return ''
  const record = result as Record<string, unknown>
  const content = record.contentItems ?? record.content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item
        if (!item || typeof item !== 'object') return ''
        const part = item as Record<string, unknown>
        return typeof part.text === 'string' ? part.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export function codexToolInputFromArguments(args: unknown): string | undefined {
  if (args === undefined) return undefined
  if (typeof args === 'string') return args
  return JSON.stringify(args)
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

const IMAGE_PATH_KEYS = [
  'path',
  'filePath',
  'filepath',
  'file_path',
  'outputPath',
  'output_path',
  'localPath',
  'local_path',
  'imagePath',
  'image_path',
  'savedPath',
  'saved_path',
] as const

const IMAGE_DATA_KEYS = ['dataUrl', 'data_url', 'url', 'imageUrl', 'image_url', 'data'] as const

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

/** Resolve the on-disk image path for a Codex imageGeneration item, persisting
 *  inline data URLs to a temp file. Returns null when nothing renderable exists. */
export function codexImageArtifactPath(value: unknown, seen = new WeakSet<object>()): string | null {
  if (!value) return null
  if (typeof value === 'string') return imagePathFromString(value)
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = codexImageArtifactPath(entry, seen)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  if (seen.has(value)) return null
  seen.add(value)

  const record = value as Record<string, unknown>
  for (const key of [...IMAGE_PATH_KEYS, ...IMAGE_DATA_KEYS]) {
    const candidate = record[key]
    if (typeof candidate === 'string') {
      const found = imagePathFromString(candidate)
      if (found) return found
    }
  }
  for (const nestedKey of ['result', 'output', 'outputs', 'image', 'images', 'content', 'contentItems']) {
    const found = codexImageArtifactPath(record[nestedKey], seen)
    if (found) return found
  }
  return null
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
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function toIsoTimestamp(value: number | string | null | undefined): string {
  return new Date(toEpochMs(value)).toISOString()
}

export function approvalPolicyFor(mode: 'ask' | 'auto' | 'plan'): unknown {
  if (mode === 'auto') return 'never'
  if (mode === 'plan') return 'never'
  return 'untrusted'
}

export function sandboxFor(mode: 'ask' | 'auto' | 'plan'): string {
  if (mode === 'plan') return 'read-only'
  if (mode === 'auto') return 'workspace-write'
  return 'workspace-write'
}

export function sandboxPolicyFor(mode: 'ask' | 'auto' | 'plan', cwd: string, additionalDirs: string[]): unknown {
  if (mode === 'plan') {
    return {
      type: 'readOnly',
      access: { type: 'fullAccess' },
      networkAccess: true,
    }
  }
  if (mode === 'auto' || mode === 'ask') {
    return {
      type: 'workspaceWrite',
      writableRoots: [cwd, ...(additionalDirs || [])].filter((dir) => dir && dir !== '~'),
      readOnlyAccess: { type: 'fullAccess' },
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    }
  }
  return {
    type: 'readOnly',
    access: { type: 'fullAccess' },
    networkAccess: true,
  }
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
  const plan = Array.isArray(params?.plan) ? params.plan : []
  const items = plan
    .map((item: any) => {
      const content = String(item?.step || item?.text || item?.description || item?.title || '').trim()
      if (!content) return null
      const marker = planItemMarker(item?.status)
      return marker ? `- ${marker} ${content}` : `- ${content}`
    })
    .filter((line: string | null): line is string => !!line)

  if (items.length === 0) return ''
  return `# Plan\n\n${items.join('\n')}`
}

function planItemMarker(status: unknown): string {
  if (typeof status !== 'string') return '[ ]'

  const normalized = status.trim().replace(/[\s-]/g, '_').toLowerCase()
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done' || normalized === 'success') return '[x]'
  if (normalized === 'in_progress' || normalized === 'inprogress' || normalized === 'running' || normalized === 'active' || normalized === 'current') return '(In progress)'
  return '[ ]'
}

export function extractPlanText(value: any): string {
  if (!value) return ''
  if (typeof value === 'string') return value

  for (const key of ['text', 'content', 'markdown', 'message', 'outputText', 'output_text']) {
    const raw = value[key]
    if (typeof raw === 'string' && raw.trim()) return raw
  }

  const content = value.content || value.message?.content || value.output
  if (!Array.isArray(content)) return ''

  return content
    .map((block: any) => {
      if (typeof block === 'string') return block
      if (typeof block?.text === 'string') return block.text
      if (typeof block?.content === 'string') return block.content
      return ''
    })
    .join('')
}

export function isInterruptedTurnStatus(status: unknown): boolean {
  return status === 'interrupted' || status === 'cancelled' || status === 'canceled' || status === 'aborted'
}

export function hasUpdatePlanMessage(messages: SessionLoadMessage[], candidate: SessionLoadMessage): boolean {
  return messages.some((m) => m.role === candidate.role && m.content === candidate.content && m.timestamp === candidate.timestamp)
}

export function insertMessageByTimestamp(messages: SessionLoadMessage[], msg: SessionLoadMessage): void {
  const idx = messages.findIndex((m) => m.timestamp > msg.timestamp)
  if (idx === -1) messages.push(msg)
  else messages.splice(idx, 0, msg)
}

export async function latestCodexUpdatePlanMessageFromJsonl(filePath: string): Promise<SessionLoadMessage | null> {
  let latest: SessionLoadMessage | null = null
  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: createReadStream(filePath) })
    rl.on('line', (line: string) => {
      try {
        const obj = JSON.parse(line)
        if (obj.type !== 'response_item') return
        const payload = obj.payload
        if (payload?.type !== 'plan') return
        const content = extractPlanText(payload)
        if (!content.trim()) return
        const timestamp = toEpochMs(obj.timestamp)
        if (!latest || timestamp > latest.timestamp) {
          latest = { role: 'plan' as any, content: '', planContent: content, timestamp }
        }
      } catch {}
    })
    rl.on('close', () => resolve())
    rl.on('error', () => resolve())
  })
  return latest
}
