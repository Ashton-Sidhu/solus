import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PlanAnnotations } from '../../shared/types'
import { runBounded } from '../lib/concurrency'

const ROOT = join(homedir(), '.solus', 'plan-annotations')

function fileFor(sessionId: string, planToolUseId: string): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_')
  const safeTool = planToolUseId.replace(/[^a-zA-Z0-9_\-]/g, '_')
  return join(ROOT, `${safeSession}__${safeTool}.json`)
}

async function ensureDir(): Promise<void> {
  if (!existsSync(ROOT)) {
    await mkdir(ROOT, { recursive: true })
  }
}

export async function loadAnnotations(sessionId: string, planToolUseId: string): Promise<PlanAnnotations | null> {
  try {
    const file = fileFor(sessionId, planToolUseId)
    if (!existsSync(file)) return null
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text) as PlanAnnotations
    return parsed
  } catch {
    return null
  }
}

export async function saveAnnotations(ann: PlanAnnotations): Promise<void> {
  await ensureDir()
  const merged: PlanAnnotations = { ...ann, updatedAt: Date.now() }
  const file = fileFor(merged.sessionId, merged.planToolUseId)
  await writeFile(file, JSON.stringify(merged, null, 2), 'utf8')
}

/** Upsert — load existing annotations, merge in the patch, save, return the merged result. */
export async function upsertAnnotations(
  sessionId: string,
  projectPath: string,
  cwd: string,
  planToolUseId: string,
  title: string,
  patch: Partial<PlanAnnotations>,
): Promise<PlanAnnotations> {
  const existing = await loadAnnotations(sessionId, planToolUseId)
  const base: PlanAnnotations = existing ?? {
    version: 1,
    sessionId,
    projectPath,
    cwd,
    planToolUseId,
    title,
    status: 'pending',
    comments: [],
    bookmarked: false,
    updatedAt: Date.now(),
  }
  const merged: PlanAnnotations = {
    ...base,
    ...patch,
    // Keep identity fields stable
    version: 1,
    sessionId,
    projectPath,
    cwd,
    planToolUseId,
    title: patch.title || base.title || title,
    updatedAt: Date.now(),
  }
  await saveAnnotations(merged)
  return merged
}

export interface AnnotationIndex {
  [key: string]: PlanAnnotations  // key = sessionId + '__' + planToolUseId
}

/** Load every sidecar into a map keyed by `${sessionId}__${planToolUseId}`. Used once by the indexer. */
export async function loadAllAnnotations(): Promise<AnnotationIndex> {
  await ensureDir()
  const out: AnnotationIndex = {}
  try {
    const files = await readdir(ROOT)
    await runBounded(
      files
        .filter((f) => f.endsWith('.json'))
        .map((f) => async () => {
          try {
            const text = await readFile(join(ROOT, f), 'utf8')
            const parsed = JSON.parse(text) as PlanAnnotations
            if (parsed.sessionId && parsed.planToolUseId) {
              out[`${parsed.sessionId}__${parsed.planToolUseId}`] = parsed
            }
          } catch {}
        }),
      24,
    )
  } catch {}
  return out
}
