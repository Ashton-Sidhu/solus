import { createInterface } from 'node:readline'
import { createReadStream, existsSync } from 'node:fs'
import { readdir, stat as fsStat } from 'node:fs/promises'
import { join } from 'node:path'
import { extractPlanTitle } from '../plan-text'
import type { AnnotationIndex } from '../../plans/annotations'
import type { PlanDescriptor, PlanRevisionSummary } from '../../../shared/types'
import { runBounded } from '../../lib/concurrency'
import { MemoryCache } from '../../../shared/cache'
import { z } from 'zod'

export const PLAN_LIST_TTL = 60_000
export const _planListCache = new MemoryCache<string, PlanDescriptor[]>({ ttlMs: PLAN_LIST_TTL, maxEntries: 64 })

/**
 * In-flight cold plan scans keyed by cache key, mirroring _sessionScanInFlight.
 * At launch the pill and editor windows both fire `listPlans`; without deduping
 * they each walk every project's transcripts at once. Sharing one scan lets the
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
  sessionId: string
  projectPath: string
  cwd: string
  timestamp: number
  title: string
  excerpt: string
  content: string
  planFilePath?: string
  derivedStatus: DerivedStatus
}

const _planFileCache = new Map<string, { mtime: number; plans: ScannedPlan[] }>()

function classifyToolResult(content: string, isError: boolean): DerivedStatus | 'skip' {
  if (isError && content.includes('You are not in plan mode')) return 'skip'
  if (!isError && /approved your plan/i.test(content)) return 'accepted'
  if (isError && /user doesn't want to proceed|tool use was rejected/i.test(content)) return 'rejected'
  if (isError) return 'rejected'
  return 'pending'
}

export async function scanPlanFile(
  filePath: string,
  sessionId: string,
  encodedPath: string,
  fallbackCwd: string,
): Promise<ScannedPlan[]> {
  const stat = await fsStat(filePath)
  const mtime = stat.mtimeMs
  const cached = _planFileCache.get(filePath)
  if (cached && cached.mtime === mtime) return cached.plans
  if (stat.size < 100) {
    _planFileCache.set(filePath, { mtime, plans: [] })
    return []
  }

  let resolvedCwd: string | null = null
  const seenIds = new Set<string>()
  const pending = new Map<string, ScannedPlan>()

  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: createReadStream(filePath) })
    rl.on('line', (line: string) => {
      try {
        const obj = JSON.parse(line)
        if (!resolvedCwd && obj.cwd) resolvedCwd = obj.cwd

        if (obj.type === 'assistant') {
          const content = obj.message?.content
          if (!Array.isArray(content)) return
          for (const block of content) {
            if (block?.type === 'tool_use' && block?.name === 'ExitPlanMode') {
              const planContent: string = block.input?.plan || ''
              if (!planContent) continue
              const id = block.id || `${sessionId}__${obj.timestamp || ''}`
              if (seenIds.has(id)) continue
              seenIds.add(id)
              const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : stat.mtime.getTime()
              pending.set(id, {
                planToolUseId: id,
                sessionId,
                projectPath: encodedPath,
                cwd: resolvedCwd || fallbackCwd,
                timestamp: ts,
                title: extractPlanTitle(planContent),
                excerpt: extractExcerpt(planContent),
                content: planContent,
                planFilePath: block.input?.planFilePath || undefined,
                derivedStatus: 'pending',
              })
            }
          }
          return
        }

        if (obj.type === 'user') {
          const content = obj.message?.content
          if (!Array.isArray(content)) return
          for (const block of content) {
            if (block?.type !== 'tool_result') continue
            const tid: string = block.tool_use_id || ''
            const plan = pending.get(tid)
            if (!plan) continue
            const raw = block.content
            const parsedText = stringSchema.safeParse(raw)
            const parsedValues = valueArraySchema.safeParse(raw)
            const text = parsedText.success
              ? parsedText.data
              : parsedValues.success
                ? JSON.stringify(parsedValues.data)
                : ''
            const status = classifyToolResult(text, !!block.is_error)
            if (status === 'skip') {
              pending.delete(tid)
              continue
            }
            plan.derivedStatus = status
          }
        }
      } catch {}
    })
    rl.on('close', () => resolve())
  })

  const plans = Array.from(pending.values())
  _planFileCache.set(filePath, { mtime, plans })
  return plans
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
    if (filePath.startsWith(`${sessionsDir}/`) && !livePaths.has(filePath)) _planFileCache.delete(filePath)
  }

  const tasks = files.map((file) => {
    const sessionId = file.replace(/\.jsonl$/, '')
    const filePath = join(sessionsDir, file)
    return () => scanPlanFile(filePath, sessionId, encodedPath, fallbackCwd)
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
    commentCount: ann?.comments?.length ?? 0,
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
      cwd: latest.cwd,
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
