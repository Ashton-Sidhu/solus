import type { Attachment, SavedPrompt } from '../../shared/types'
import { getDb } from '../db'

interface SavedPromptRow {
  id: string
  project_root: string
  text: string
  attachments: string
  created_at: number
}

/**
 * Ceiling on the serialized attachment set. Screenshots arrive as base64 data
 * URLs and a retina full-screen capture runs 3-6 MB, so a couple of them is the
 * point where the list payload — which crosses a WebSocket even on desktop —
 * starts to hurt. Rejecting at the write is kinder than a list that slows down
 * every time the sheet opens.
 */
const MAX_ATTACHMENTS_BYTES = 8 * 1024 * 1024

function parseAttachments(raw: string): Attachment[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Saved prompts for one project, newest first. */
export async function listSavedPrompts(projectRoot: string): Promise<SavedPrompt[]> {
  const rows = getDb().prepare(`
    SELECT id, project_root, text, attachments, created_at
    FROM saved_prompts
    WHERE project_root = ?
    ORDER BY created_at DESC
  `).all(projectRoot) as unknown as SavedPromptRow[]
  return rows.map((row) => ({
    id: row.id,
    projectRoot: row.project_root,
    text: row.text,
    attachments: parseAttachments(row.attachments),
    createdAt: row.created_at,
  }))
}

/**
 * INSERT OR REPLACE rather than INSERT: undoing a delete re-sends the original
 * record, and keeping its id and createdAt puts the row back where it was.
 */
export async function createSavedPrompt(prompt: SavedPrompt): Promise<SavedPrompt[]> {
  const attachments = JSON.stringify(prompt.attachments ?? [])
  if (attachments.length > MAX_ATTACHMENTS_BYTES) {
    throw new Error('These attachments are too large to save with a prompt')
  }
  getDb().prepare(`
    INSERT OR REPLACE INTO saved_prompts (id, project_root, text, attachments, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(prompt.id, prompt.projectRoot, prompt.text, attachments, prompt.createdAt)
  return listSavedPrompts(prompt.projectRoot)
}

/** Idempotent, so two windows deleting the same prompt both succeed. */
export async function deleteSavedPrompt(projectRoot: string, id: string): Promise<SavedPrompt[]> {
  getDb().prepare('DELETE FROM saved_prompts WHERE id = ?').run(id)
  return listSavedPrompts(projectRoot)
}
