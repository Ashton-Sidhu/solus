import { open, readdir, stat as fsStat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionMeta } from '../../../shared/types'
import type { SessionLoadMessage } from '../../../shared/session-history'
import { runBounded } from '../../lib/concurrency'
import { stripInjectedContext } from '../utils'
import { MemoryCache } from '../../../shared/cache'

export interface SessionListCacheEntry {
  sessions: SessionMeta[]
  latestDirMtime: number
}

export const SESSION_LIST_FORCE_RESCAN_MS = 300_000
export const _sessionListCache = new MemoryCache<string, SessionListCacheEntry>({ ttlMs: SESSION_LIST_FORCE_RESCAN_MS })

/**
 * In-flight cold scans keyed by session-list cache key. At launch the pill and
 * editor windows both mount NewTabHome and each fires a full `listSessions`;
 * without deduping they run two ~N-file scans concurrently, doubling disk/CPU
 * contention. Sharing one scan lets the second caller await the same promise.
 * Entries are removed as soon as the scan settles.
 */
export const _sessionScanInFlight = new Map<string, Promise<SessionMeta[]>>()

const HEAD_BYTES = 4096
// Claude Code's `/rename` appends a `{"type":"custom-title",...}` line to the end
// of the transcript. Read a small tail window to surface it without paying the
// SDK's 64KB head+tail cost on every file. A rename buried before this much
// trailing transcript (rare) is missed and the session falls back to its prompt.
const MAX_CONCURRENT_SCANS = 24
const CMD_METADATA_REGEX = /<command-(?:name|message)>[\s\S]*?<\/command-(?:name|message)>/g
const CMD_ARGS_REGEX = /<command-args>([\s\S]*?)<\/command-args>/
const CMD_ARGS_BLOCK_REGEX = /<command-args>[\s\S]*?<\/command-args>/g
const CMD_NAME_REGEX = /<command-name>\s*([^<\s]+)\s*<\/command-name>/

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

export function parseHeadMeta(lines: string[]): {
  validated: boolean
  slug: string | null
  firstMessage: string | null
  cwd: string | null
} {
  const meta = { validated: false, slug: null as string | null, firstMessage: null as string | null, cwd: null as string | null }

  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (!meta.validated && obj.type && obj.uuid && obj.timestamp) {
        meta.validated = true
      }
      if (obj.slug && !meta.slug) meta.slug = obj.slug
      if (obj.cwd && !meta.cwd) meta.cwd = obj.cwd
      if (obj.type === 'user' && !meta.firstMessage && !obj.isMeta) {
        const content = obj.message?.content
        if (typeof content === 'string') {
          const text = stripInjectedContext(extractPromptText(content))
          meta.firstMessage = text.substring(0, 100) || null
        } else if (Array.isArray(content)) {
          const textPart = content.find((p: any) => p.type === 'text')
          const raw = typeof textPart?.text === 'string' ? extractPromptText(textPart.text) : ''
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
    let windowBytes = Math.min(HEAD_BYTES, stat.size)
    let meta!: ReturnType<typeof parseHeadMeta>
    while (true) {
      const headBuf = Buffer.allocUnsafe(windowBytes)
      const { bytesRead } = await fh.read(headBuf, 0, windowBytes, 0)
      const headLines = headBuf.subarray(0, bytesRead).toString('utf8').split('\n').filter(Boolean)
      meta = parseHeadMeta(headLines)
      if (meta.validated || windowBytes >= stat.size) return meta
      windowBytes = Math.min(stat.size, windowBytes * 4)
    }
  } finally {
    await fh.close()
  }
}


export function parseJsonlLine(line: string): SessionLoadMessage | null {
  try {
    const obj = JSON.parse(line)
    // Sub-agent (Agent/Task) activity is recorded with the spawning tool's id, so
    // history replay can divert it into that tool's nested transcript.
    const parentToolUseId: string | undefined = obj.parent_tool_use_id || undefined
    if (obj.type === 'user') {
      if (obj.isMeta) return null
      const content = obj.message?.content
      if (Array.isArray(content) && content.every((b: any) => b.type === 'tool_result')) {
        const result = content.find((b: any) => typeof b.tool_use_id === 'string')
        if (!result) return null
        const text = typeof result.content === 'string'
          ? result.content
          : Array.isArray(result.content)
            ? result.content.map((b: any) => typeof b?.text === 'string' ? b.text : '').join('\n')
            : ''
        return {
          role: 'tool_result',
          content: text,
          toolResultForId: result.tool_use_id,
          parentToolUseId,
          timestamp: new Date(obj.timestamp).getTime(),
        }
      }
      // A completed background sub-agent's result is delivered as a
      // <task-notification> user message carrying the spawning tool's id and the
      // agent's final output. Route it into that tool's nested transcript so reload
      // rebuilds the sub-agent card instead of leaking the result as a user bubble.
      if (typeof content === 'string' && content.includes('<task-notification>')) {
        const notifToolId = content.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]
        const result = content.match(/<result>([\s\S]*?)<\/result>/)?.[1]?.trim()
        if (notifToolId && result) {
          return { role: 'assistant', content: result, parentToolUseId: notifToolId, timestamp: new Date(obj.timestamp).getTime() }
        }
        // Status-only notifications carry no result — plumbing, not user input.
        return null
      }

      let text = ''
      if (typeof content === 'string') {
        // Claude Code injects context continuation summaries as plain-string user messages
        // when the context window fills up. These are not real user input — skip them.
        if (content.includes('This session is being continued from a previous conversation')) return null
        // Skill commands are stored as XML. Prefer user args, then fall back to the command.
        text = extractPromptText(content)
      } else if (Array.isArray(content)) {
        text = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
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
          }
        }
      }
    }
  } catch {}
  return null
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
