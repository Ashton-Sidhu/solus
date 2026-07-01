import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WorkAnnotations } from '../../shared/types'

// Per-work comment sidecar, mirroring src/main/plans/annotations.ts.
const ROOT = join(homedir(), '.solus', 'work-annotations')

function fileFor(workId: string): string {
  const safe = workId.replace(/[^a-zA-Z0-9_\-]/g, '_')
  return join(ROOT, `${safe}.json`)
}

async function ensureDir(): Promise<void> {
  if (!existsSync(ROOT)) {
    await mkdir(ROOT, { recursive: true })
  }
}

export async function loadWorkAnnotations(workId: string): Promise<WorkAnnotations | null> {
  try {
    const file = fileFor(workId)
    if (!existsSync(file)) return null
    return JSON.parse(await readFile(file, 'utf8')) as WorkAnnotations
  } catch {
    return null
  }
}

export async function saveWorkAnnotations(ann: WorkAnnotations): Promise<void> {
  await ensureDir()
  const merged: WorkAnnotations = { ...ann, version: 1, updatedAt: Date.now() }
  await writeFile(fileFor(merged.workId), JSON.stringify(merged, null, 2), 'utf8')
}

/** Remove a work's annotation sidecar (called when the work is deleted). */
export async function deleteWorkAnnotations(workId: string): Promise<void> {
  const file = fileFor(workId)
  if (existsSync(file)) await rm(file)
}
