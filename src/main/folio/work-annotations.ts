import { getDb } from '../db'
import type { WorkAnnotations } from '../../shared/types'

interface WorkAnnotationRow {
  data: string | null
}

export async function loadWorkAnnotations(workId: string): Promise<WorkAnnotations | null> {
  try {
    const row = getDb().prepare('SELECT data FROM work_annotations WHERE work_id = ?').get(workId) as WorkAnnotationRow | undefined
    return row?.data ? JSON.parse(row.data) as WorkAnnotations : null
  } catch {
    return null
  }
}

export async function saveWorkAnnotations(ann: WorkAnnotations): Promise<void> {
  const merged: WorkAnnotations = { ...ann, version: 1, updatedAt: Date.now() }
  getDb().prepare(`
    INSERT INTO work_annotations (work_id, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(work_id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `).run(merged.workId, JSON.stringify(merged), merged.updatedAt)
}
