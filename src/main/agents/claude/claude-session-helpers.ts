import { open, readdir, stat as fsStat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { SessionMeta } from '../../../shared/types'
import type { SessionLoadMessage } from '../../../shared/session-history'
import { runBounded } from '../../lib/concurrency'
import { encodePathAsFolder, stripInjectedContext } from '../utils'
import { MemoryCache } from '../../../shared/cache'
import { claudeToolResultText, parseClaudeTaskNotification } from './claude-subagent-protocol'

export interface SessionListCacheEntry {
  sessions: SessionMeta[]
  latestDirMtime: number
}

export const SESSION_LIST_FORCE_RESCAN_MS = 300_000
export const _sessionListCache = new MemoryCache<string, SessionListCacheEntry>({ ttlMs: SESSION_LIST_FORCE_RESCAN_MS, maxEntries: 64 })

/**
 * In-flight cold scans keyed by session-list cache key. At launch the pill and
 * editor windows both mount NewTabHome and each fires a full `listSessions`;
 * without deduping they run two ~N-file scans concurrently, doubling disk/CPU
 * contention. Sharing one scan lets the second caller await the same promise.
 * Entries are removed as soon as the scan settles.
 */
export const _sessionScanInFlight = new Map<string, Promise<SessionMeta[]>>()

const HEAD_BYTES = 4096
export const MAX_SESSION_HEAD_BYTES = 4 * 1024 * 1024
// Claude Code's `/rename` appends a `{"type":"custom-title",...}` line to the end
// of the transcript. Read a small tail window to surface it without paying the
// SDK's 64KB head+tail cost on every file. A rename buried before this much
// trailing transcript (rare) is missed and the session falls back to its prompt.
const MAX_CONCURRENT_SCANS = 24
const CMD_METADATA_REGEX = /<command-(?:name|message)>[\s\S]*?<\/command-(?:name|message)>/g
const CMD_ARGS_REGEX = /<command-args>([\s\S]*?)<\/command-args>/
const CMD_ARGS_BLOCK_REGEX = /<command-args>[\s\S]*?<\/command-args>/g
const CMD_NAME_REGEX = /<command-name>\s*([^<\s]+)\s*<\/command-name>/

/**
 * Find a Claude transcript by the caller's path first, then by the path recorded
 * by the session index. Claude can move a transcript into an agent worktree
 * after the session starts, while a restored tab still carries the project root.
 */
export function resolveClaudeSessionFilePath(
  projectsRoot: string,
  sessionId: string,
  requestedProjectPath: string,
  indexedProjectPath?: () => string | undefined,
): string | null {
  const filePathFor = (projectPath: string): string => {
    const folderName = projectPath.startsWith('-')
      ? projectPath
      : encodePathAsFolder(projectPath)
    return join(projectsRoot, folderName, `${sessionId}.jsonl`)
  }

  const requestedFilePath = filePathFor(requestedProjectPath)
  if (existsSync(requestedFilePath)) return requestedFilePath

  const fallbackProjectPath = indexedProjectPath?.()
  if (!fallbackProjectPath || fallbackProjectPath === requestedProjectPath) return null
  const fallbackFilePath = filePathFor(fallbackProjectPath)
  return existsSync(fallbackFilePath) ? fallbackFilePath : null
}

const claudeTextBlockSchema = z.object({ type: z.literal('text'), text: z.string() })
const claudeToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().optional(),
  content: z.union([
    z.string(),
    z.array(z.object({ text: z.string().optional() })),
  ]).optional(),
})
const claudeToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  name: z.string().optional(),
  id: z.string().optional(),
  input: z.object({
    plan: z.string().optional(),
    planFilePath: z.string().optional(),
  }).passthrough().optional(),
})
const claudeThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
})
const claudeContentBlockSchema = z.discriminatedUnion('type', [
  claudeTextBlockSchema,
  claudeToolResultBlockSchema,
  claudeToolUseBlockSchema,
  claudeThinkingBlockSchema,
])
const claudeTranscriptLineSchema = z.object({
  type: z.string().optional(),
  uuid: z.string().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  slug: z.string().optional(),
  cwd: z.string().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  parent_tool_use_id: z.string().optional(),
  message: z.object({
    content: z.union([z.string(), z.array(claudeContentBlockSchema)]).optional(),
  }).optional(),
  toolUseResult: z.object({
    isAsync: z.boolean().optional(),
    status: z.string().optional(),
  }).optional(),
})

export interface SessionHeadMeta {
  validated: boolean
  slug: string | null
  firstMessage: string | null
  cwd: string | null
  isSidechain: boolean
}

function extractPromptText(content: string): string {
  const args = content.match(CMD_ARGS_REGEX)?.[1]?.trim()
  if (args) return args

  const commandName = content.match(CMD_NAME_REGEX)?.[1]?.trim()
  const stripped = content
    .replaceAll(CMD_METADATA_REGEX, '')
    .replaceAll(CMD_ARGS_BLOCK_REGEX, '')
    .trim()
  return stripped || commandName || ''
}

export function parseHeadMeta(lines: string[]): SessionHeadMeta {
  const meta: SessionHeadMeta = {
    validated: false,
    slug: null,
    firstMessage: null,
    cwd: null,
    isSidechain: false,
  }

  for (const line of lines) {
    try {
      const parsed = claudeTranscriptLineSchema.safeParse(JSON.parse(line))
      if (!parsed.success) continue
      const obj = parsed.data
      if (obj.isSidechain) {
        meta.isSidechain = true
        break
      }
      if (!meta.validated && obj.type && obj.uuid && obj.timestamp) {
        meta.validated = true
      }
      if (obj.slug && !meta.slug) meta.slug = obj.slug
      if (obj.cwd && !meta.cwd) meta.cwd = obj.cwd
      if (obj.type === 'user' && !meta.firstMessage && !obj.isMeta) {
        const content = obj.message?.content
        const textContent = z.string().safeParse(content)
        if (textContent.success) {
          const text = stripInjectedContext(extractPromptText(textContent.data))
          meta.firstMessage = text.substring(0, 100) || null
        } else if (Array.isArray(content)) {
          const textPart = content.find((part) => part.type === 'text')
          const raw = textPart?.type === 'text' ? extractPromptText(textPart.text) : ''
          const text = stripInjectedContext(raw)
          meta.firstMessage = text.substring(0, 100) || null
        }
      }
    } catch {}
    if (meta.validated && meta.firstMessage && meta.cwd && meta.slug) break
  }
  return meta
}

export async function readSessionHeadMeta(filePath: string): Promise<ReturnType<typeof parseHeadMeta>> {
  const fh = await open(filePath, 'r')
  try {
    const stat = await fh.stat()
    let windowBytes = Math.min(HEAD_BYTES, stat.size, MAX_SESSION_HEAD_BYTES)
    let meta: SessionHeadMeta
    while (true) {
      const headBuf = Buffer.allocUnsafe(windowBytes)
      const { bytesRead } = await fh.read(headBuf, 0, windowBytes, 0)
      const headLines = headBuf.subarray(0, bytesRead).toString('utf8').split('\n').filter(Boolean)
      meta = parseHeadMeta(headLines)
      if (meta.validated || windowBytes >= stat.size || windowBytes >= MAX_SESSION_HEAD_BYTES) return meta
      windowBytes = Math.min(stat.size, windowBytes * 4, MAX_SESSION_HEAD_BYTES)
    }
  } finally {
    await fh.close()
  }
}


export function parseJsonlLine(line: string): SessionLoadMessage | null {
  try {
    const parsed = claudeTranscriptLineSchema.safeParse(JSON.parse(line))
    if (!parsed.success) return null
    const obj = parsed.data
    // Sub-agent (Agent/Task) activity is recorded with the spawning tool's id, so
    // history replay can divert it into that tool's nested transcript.
    const parentToolUseId: string | undefined = obj.parent_tool_use_id || undefined
    if (obj.type === 'user') {
      if (obj.isMeta) return null
      const content = obj.message?.content
      if (Array.isArray(content) && content.every((block) => block.type === 'tool_result')) {
        const result = content.find((block) => block.type === 'tool_result' && block.tool_use_id)
        if (!result) return null
        // A backgrounded sub-agent answers its tool call at *launch* with metadata
        // the SDK forbids surfacing ("Async agent launched successfully…"); its real
        // output arrives later as the <task-notification> below. Drop the ack here
        // exactly as the live reducer does, so reload doesn't rebuild the card with
        // launch metadata standing in for the agent's report.
        if (obj.toolUseResult?.isAsync === true || obj.toolUseResult?.status === 'async_launched') return null
        return {
          role: 'tool_result',
          content: claudeToolResultText(result.content),
          toolResultForId: result.tool_use_id,
          parentToolUseId,
          timestamp: new Date(obj.timestamp).getTime(),
        }
      }
      // A completed background sub-agent's result is delivered as a
      // <task-notification> user message carrying the spawning tool's id and the
      // agent's final output. Route it into that tool's nested transcript so reload
      // rebuilds the sub-agent card instead of leaking the result as a user bubble.
      const stringContent = z.string().safeParse(content)
      if (stringContent.success && stringContent.data.includes('<task-notification>')) {
        const notification = parseClaudeTaskNotification(stringContent.data)
        if (notification) {
          return {
            role: 'assistant',
            content: notification.result,
            parentToolUseId: notification.toolUseId,
            timestamp: new Date(obj.timestamp).getTime(),
          }
        }
        // Status-only notifications carry no result — plumbing, not user input.
        return null
      }

      let text = ''
      if (stringContent.success) {
        // Claude Code injects context continuation summaries as plain-string user messages
        // when the context window fills up. These are not real user input — skip them.
        if (stringContent.data.includes('This session is being continued from a previous conversation')) return null
        // Skill commands are stored as XML. Prefer user args, then fall back to the command.
        text = extractPromptText(stringContent.data)
      } else if (Array.isArray(content)) {
        text = content
          .filter((block) => block.type === 'text')
          .map((block) => block.type === 'text' ? block.text : '')
          .join('\n')
      }
      if (text) {
        text = stripInjectedContext(text)
        if (text) return { role: 'user', content: text, parentToolUseId, timestamp: new Date(obj.timestamp).getTime() }
      }
    } else if (obj.type === 'assistant') {
      const content = obj.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            return { role: 'assistant', content: block.text, parentToolUseId, timestamp: new Date(obj.timestamp).getTime() }
          } else if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
            const planContent: string = block.input?.plan || ''
            if (planContent) {
              return {
                role: 'plan',
                content: '',
                planContent,
                planFilePath: block.input?.planFilePath || '',
                planToolUseId: block.id || '',
                parentToolUseId,
                timestamp: new Date(obj.timestamp).getTime(),
              }
            }
          } else if (block.type === 'tool_use' && block.name) {
            return {
              role: 'tool',
              content: '',
              toolName: block.name,
              toolId: block.id,
              toolInput: JSON.stringify(block.input ?? {}),
              parentToolUseId,
              timestamp: new Date(obj.timestamp).getTime(),
            }
          } else if (block.type === 'thinking' && block.thinking.trim()) {
            // Extended-thinking spans (Claude writes them on their own assistant
            // line). Carried for provider handoffs; display surfaces skip this role.
            return { role: 'reasoning', content: block.thinking, parentToolUseId, timestamp: new Date(obj.timestamp).getTime() }
          }
        }
      }
    }
  } catch {}
  return null
}

/** Find the assistant message immediately before the latest real user prompt.
 * Claude's resumeSessionAt option accepts only an assistant SDK message UUID. */
export function findClaudeForkResumeId(lines: string[]): string | null {
  let lastAssistantId: string | null = null
  let resumeId: string | null = null

  for (const line of lines) {
    try {
      const parsed = claudeTranscriptLineSchema.safeParse(JSON.parse(line))
      if (!parsed.success) continue
      const transcriptLine = parsed.data
      if (transcriptLine.isSidechain || transcriptLine.parent_tool_use_id) continue
      if (transcriptLine.type === 'assistant' && transcriptLine.uuid) {
        lastAssistantId = transcriptLine.uuid
        continue
      }
      if (parseJsonlLine(line)?.role === 'user') resumeId = lastAssistantId
    } catch {}
  }

  return resumeId
}

export async function scanSessionsInDir(
  sessionsDir: string,
  encodedPath: string,
  fallbackCwd: string,
  isWorktree: boolean,
  onSession?: (session: SessionMeta) => void,
): Promise<SessionMeta[]> {
  if (!existsSync(sessionsDir)) return []
  const files = await readdir(sessionsDir)

  const sessionFiles = await Promise.all(files
    .filter((f) => f.endsWith('.jsonl'))
    .map(async (fileName) => {
      const filePath = join(sessionsDir, fileName)
      const stat = await fsStat(filePath)
      return {
        id: fileName.slice(0, -6),
        mtimeMs: stat.mtimeMs,
      }
    }))
  sessionFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const tasks = sessionFiles.map(({ id }) => async () : Promise<SessionMeta | null>  => {
    const filePath = join(sessionsDir, `${id}.jsonl`)
    const stat = await fsStat(filePath)
    if (stat.size < 100) return null

    // Validation needs one complete `type+uuid+timestamp` line. When the first
    // message inlines a large base64 screenshot (or a long prompt), that line
    // can exceed HEAD_BYTES and get truncated mid-object, so it never parses and
    // the session is silently dropped. Grow the window until we capture a
    // complete validated line, mirroring loadSessionWindow. The small-first-
    // message case (the overwhelming majority) still reads only HEAD_BYTES.
    const meta = await readSessionHeadMeta(filePath)

    if (!meta.validated) return null

    return {
      provider: 'claude-code',
      sessionId: id,
      slug: meta.slug,
      firstMessage: meta.firstMessage,
      lastTimestamp: stat.mtime.toISOString(),
      size: stat.size,
      cwd: meta.cwd || fallbackCwd,
      projectPath: encodedPath,
      isWorktree,
    }
  })

  const results = await runBounded(tasks, MAX_CONCURRENT_SCANS, (result) => {
    if (result && onSession) onSession(result)
  })
  return results.filter((s): s is SessionMeta => s !== null)
}
