import { isInsideHostPath } from '@solus/contracts/host-path'
import { existsSync } from 'node:fs'
import { open, readdir, stat as fsStat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { extractPlanTitle } from '../plan-text'
import type { AnnotationIndex } from '../../../plans/annotations'
import type { PlanDescriptor, PlanRevisionSummary } from '@solus/contracts/types'
import { runBounded } from '../../../lib/concurrency'
import { MemoryCache } from '@solus/contracts/cache'
import { z } from 'zod'
import { resolveHomePath } from '../../../platform/paths'
import { sessionIdOfThread } from '../../../data/sessions/session-lineage'

export const PLAN_LIST_TTL = 60_000
export const _planListCache = new MemoryCache<string, PlanDescriptor[]>({ ttlMs: PLAN_LIST_TTL, maxEntries: 64 })

/**
 * In-flight cold plan scans keyed by cache key, mirroring _sessionScanInFlight.
 * Concurrent clients can both fire `listPlans`; without deduping they each walk
 * every project's transcripts at once. Sharing one scan lets the
 * second caller await the same promise. Entries are removed when the scan settles.
 */
export const _planScanInFlight = new Map<string, Promise<PlanDescriptor[]>>()
const MAX_CONCURRENT_PLAN_SCANS = 8
const stringSchema = z.string()
const valueArraySchema = z.array(z.unknown())

function extractExcerpt(planContent: string): string {
  const lines = planContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l))
  const flat = lines.join(' ').replace(/[*_`]/g, '')
  return flat.slice(0, 240)
}

export type DerivedStatus = 'pending' | 'accepted' | 'rejected'

export interface ScannedPlan {
  planToolUseId: string
  /** The session the plan belongs to (docs/plans/session-identity.md). */
  sessionId: string
  /** The thread whose transcript holds it. */
  threadId: string
  projectPath: string
  cwd: string
  timestamp: number
  title: string
  excerpt: string
  content: string
  planFilePath?: string
  derivedStatus: DerivedStatus
}

/**
 * What one transcript's scan has found so far, and how far it read. A file
 * grows at its end while a turn streams, so the next scan goes on from
 * `offset`: the plans found before keep their entry here, a plan still
 * `pending` takes its status from a tool result that arrives later, and the
 * bytes before the offset are never read again.
 */
interface PlanScan {
  /** The end of the last complete line read. */
  offset: number
  /** The file's first `cwd`, which every plan of the file is placed in. */
  resolvedCwd: string | null
  seenIds: Set<string>
  /** The plans found, by tool-use id, in the order found. */
  plans: Map<string, ScannedPlan>
}
const _planFileCache = new Map<string, PlanScan>()
const SCAN_CHUNK_BYTES = 256 * 1024

function classifyToolResult(content: string, isError: boolean): DerivedStatus | 'skip' {
  if (isError && content.includes('You are not in plan mode')) return 'skip'
  if (!isError && /approved your plan/i.test(content)) return 'accepted'
  if (isError && /user doesn't want to proceed|tool use was rejected/i.test(content)) return 'rejected'
  if (isError) return 'rejected'
  return 'pending'
}

/**
 * The complete lines of a file from `offset` to `end`, each with the offset
 * after its newline. A last line with no newline yet is the agent's current
 * write; it is left for the next scan. An unreadable file (another user's)
 * yields nothing: it never crashes the server.
 */
async function* readLinesFrom(filePath: string, offset: number, end: number): AsyncGenerator<{ line: string; endOffset: number }> {
  let file: FileHandle
  try {
    file = await open(filePath, 'r')
  } catch {
    return
  }
  try {
    let position = offset
    let pending: Buffer[] = []
    while (position < end) {
      const buffer = Buffer.allocUnsafe(Math.min(SCAN_CHUNK_BYTES, end - position))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      let lineStart = 0
      for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, lineStart)) {
        const segment = chunk.subarray(lineStart, newline)
        const line = pending.length ? Buffer.concat([...pending, segment]) : segment
        pending = []
        yield { line: line.toString('utf8'), endOffset: position + newline + 1 }
        lineStart = newline + 1
      }
      if (lineStart < chunk.length) pending.push(Buffer.from(chunk.subarray(lineStart)))
      position += bytesRead
    }
  } catch {
    // A read that fails midway keeps what was scanned; the next scan goes on from there.
  } finally {
    await file.close()
  }
}

export async function scanPlanFile(
  filePath: string,
  threadId: string,
  encodedPath: string,
  fallbackCwd: string,
): Promise<ScannedPlan[]> {
  const stat = await fsStat(filePath)
  let scan = _planFileCache.get(filePath)
  // A file that shrank was written anew; the scan starts over.
  if (!scan || stat.size < scan.offset) {
    scan = { offset: 0, resolvedCwd: null, seenIds: new Set(), plans: new Map() }
    _planFileCache.set(filePath, scan)
  }
  // The file's plans are kept; their session is read now, because the thread
  // may have joined a session since the file was read.
  if (stat.size === scan.offset || stat.size < 100) return inSession([...scan.plans.values()])

  const place = { threadId, encodedPath, fallbackCwd, mtime: stat.mtime.getTime() }
  for await (const { line, endOffset } of readLinesFrom(filePath, scan.offset, stat.size)) {
    scan.offset = endOffset
    try {
      scanLine(scan, JSON.parse(line), place)
    } catch {}
  }

  return inSession([...scan.plans.values()])
}

/** Where a file's plans belong, and the time a line without one gets. */
interface PlanPlace {
  threadId: string
  encodedPath: string
  fallbackCwd: string
  mtime: number
}

/** One transcript line into the scan: a plan the assistant proposed, or the result that settled one. */
function scanLine(scan: PlanScan, obj: any, place: PlanPlace): void {
  if (!scan.resolvedCwd && obj.cwd) scan.resolvedCwd = obj.cwd
  const content = obj.message?.content
  if (!Array.isArray(content)) return
  if (obj.type === 'assistant') scanProposedPlans(scan, obj.timestamp, content, place)
  else if (obj.type === 'user') scanPlanResults(scan, content)
}

function scanProposedPlans(scan: PlanScan, timestamp: string | number | undefined, content: any[], place: PlanPlace): void {
  for (const block of content) {
    if (block?.type !== 'tool_use' || block?.name !== 'ExitPlanMode') continue
    const planContent: string = block.input?.plan || ''
    if (!planContent) continue
    const id = block.id || `${place.threadId}__${timestamp || ''}`
    if (scan.seenIds.has(id)) continue
    scan.seenIds.add(id)
    scan.plans.set(id, {
      planToolUseId: id,
      sessionId: place.threadId,
      threadId: place.threadId,
      projectPath: place.encodedPath,
      cwd: resolveHomePath(scan.resolvedCwd || place.fallbackCwd),
      timestamp: timestamp ? new Date(timestamp).getTime() : place.mtime,
      title: extractPlanTitle(planContent),
      excerpt: extractExcerpt(planContent),
      content: planContent,
      planFilePath: block.input?.planFilePath || undefined,
      derivedStatus: 'pending',
    })
  }
}

function scanPlanResults(scan: PlanScan, content: any[]): void {
  for (const block of content) {
    if (block?.type !== 'tool_result') continue
    const tid: string = block.tool_use_id || ''
    const plan = scan.plans.get(tid)
    if (!plan) continue
    const parsedText = stringSchema.safeParse(block.content)
    const parsedValues = valueArraySchema.safeParse(block.content)
    const text = parsedText.success ? parsedText.data : parsedValues.success ? JSON.stringify(parsedValues.data) : ''
    const status = classifyToolResult(text, !!block.is_error)
    if (status === 'skip') scan.plans.delete(tid)
    else plan.derivedStatus = status
  }
}

function inSession(plans: ScannedPlan[]): ScannedPlan[] {
  return plans.map((plan) => ({ ...plan, sessionId: sessionIdOfThread(plan.threadId) }))
}

export async function scanPlansInDir(
  sessionsDir: string,
  encodedPath: string,
  fallbackCwd: string,
): Promise<ScannedPlan[]> {
  if (!existsSync(sessionsDir)) return []
  const files = (await readdir(sessionsDir)).filter((f: string) => f.endsWith('.jsonl'))
  const livePaths = new Set(files.map((file) => join(sessionsDir, file)))
  for (const filePath of _planFileCache.keys()) {
    if (isInsideHostPath(sessionsDir, filePath) && !livePaths.has(filePath)) _planFileCache.delete(filePath)
  }

  const tasks = files.map((file) => {
    const threadId = file.replace(/\.jsonl$/, '')
    const filePath = join(sessionsDir, file)
    return () => scanPlanFile(filePath, threadId, encodedPath, fallbackCwd)
  })
  const results = await runBounded(tasks, MAX_CONCURRENT_PLAN_SCANS)
  return results.flat()
}

export type AnnotatedPlan = ScannedPlan & {
  title: string
  status: 'pending' | 'accepted' | 'rejected'
  commentCount: number
  bookmarked: boolean
  bookmarkedAt?: number
}

export function annotateScanned(scanned: ScannedPlan, index: AnnotationIndex): AnnotatedPlan {
  const ann = index.get(`${scanned.sessionId}__${scanned.planToolUseId}`)
  return {
    ...scanned,
    title: ann?.title || scanned.title,
    status: ann?.status ?? scanned.derivedStatus,
    commentCount: ann?.commentCount ?? 0,
    bookmarked: !!ann?.bookmarked,
    bookmarkedAt: ann?.bookmarkedAt,
  }
}

export function groupBySession(plans: AnnotatedPlan[]): PlanDescriptor[] {
  const groups = new Map<string, AnnotatedPlan[]>()
  for (const p of plans) {
    const key = p.sessionId
    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
    }
    group.push(p)
  }

  const descriptors: PlanDescriptor[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => b.timestamp - a.timestamp)
    const latest = group[0]

    const revisions: PlanRevisionSummary[] = group.map((p) => ({
      planToolUseId: p.planToolUseId,
      timestamp: p.timestamp,
      title: p.title,
      excerpt: p.excerpt,
      status: p.status,
      commentCount: p.commentCount,
      planFilePath: p.planFilePath,
    }))

    const anyBookmarked = group.some((p) => p.bookmarked)
    const latestBookmarkedAt = group.reduce<number | undefined>(
      (max, p) => (p.bookmarkedAt ? Math.max(max ?? 0, p.bookmarkedAt) : max),
      undefined,
    )

    descriptors.push({
      provider: 'claude-code',
      planToolUseId: latest.planToolUseId,
      sessionId: latest.sessionId,
      projectPath: latest.projectPath,
      cwd: resolveHomePath(latest.cwd),
      timestamp: latest.timestamp,
      title: latest.title,
      excerpt: latest.excerpt,
      status: latest.status,
      commentCount: latest.commentCount,
      bookmarked: anyBookmarked,
      bookmarkedAt: latestBookmarkedAt,
      planFilePath: latest.planFilePath,
      revisions,
    })
  }

  return descriptors
}
