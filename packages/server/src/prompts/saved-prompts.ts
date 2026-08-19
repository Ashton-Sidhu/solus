import type { Attachment, SavedPrompt } from '@solus/contracts/types'
import { getDb } from '../db'
import { z } from 'zod'

const designAnnotationSchema = z.object({
  id: z.string(),
  type: z.enum(['rectangle', 'arrow', 'pin', 'text']),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  endX: z.number().optional(),
  endY: z.number().optional(),
  label: z.string().optional(),
})
const designSelectionSchema = z.object({
  screenshot: z.string(),
  outerHTML: z.string().optional(),
  cssSelector: z.string().optional(),
  computedStyles: z.record(z.string(), z.string()).optional(),
  componentName: z.string().optional(),
  componentFile: z.string().optional(),
  pageURL: z.string().optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  annotations: z.array(designAnnotationSchema).optional(),
})
const attachmentSchema = z.object({
  id: z.string(),
  type: z.enum(['image', 'file', 'design-selection']),
  name: z.string(),
  path: z.string(),
  hostPath: z.string().optional(),
  hostServerId: z.string().optional(),
  mimeType: z.string().optional(),
  dataUrl: z.string().optional(),
  size: z.number().optional(),
  designData: designSelectionSchema.optional(),
})
const savedPromptRowsSchema = z.array(z.object({
  id: z.string(),
  project_root: z.string(),
  text: z.string(),
  attachments: z.string(),
  created_at: z.number(),
}))

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
    const parsed = z.array(attachmentSchema).safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/** Saved prompts for one project, newest first. */
export async function listSavedPrompts(projectRoot: string): Promise<SavedPrompt[]> {
  const rows = savedPromptRowsSchema.parse(getDb().prepare(`
    SELECT id, project_root, text, attachments, created_at
    FROM saved_prompts
    WHERE project_root = ?
    ORDER BY created_at DESC
  `).all(projectRoot))
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
