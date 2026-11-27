import { z } from 'zod'
import type { Attachment, Prompt } from '@solus/contracts/types'
import { agentIdSchema } from '@solus/contracts/types'

export const MAX_STASHED_PROMPTS = 100
export const STASH_FILE_LIFETIME_MS = 24 * 60 * 60 * 1000

const point = z.object({ x: z.number(), y: z.number() })
const attachment = z.object({
  id: z.string(),
  type: z.enum(['image', 'file', 'design-selection']),
  name: z.string(),
  path: z.string(),
  hostPath: z.string().optional(),
  hostServerId: z.string().optional(),
  mimeType: z.string().optional(),
  dataUrl: z.string().optional(),
  size: z.number().optional(),
  needsReattach: z.literal(true).optional(),
  designData: z.object({
    screenshot: z.string(),
    cssSelector: z.string().optional(),
    componentName: z.string().optional(),
    componentFile: z.string().optional(),
    pageURL: z.string().optional(),
    viewport: z.object({ width: z.number(), height: z.number() }).optional(),
    annotationContext: z.string().optional(),
    browserAppearance: z.enum(['light', 'dark']).optional(),
    browserMarks: z.array(z.object({
      id: z.string(), tool: z.enum(['pick', 'region', 'draw']), pin: z.number(),
      selector: z.string().optional(), note: z.string().optional(),
      rect: point.extend({ width: z.number(), height: z.number() }).optional(),
      path: z.array(point).optional(), scroll: point.optional(),
      ref: z.string().optional(), identifier: z.string().optional(),
    })).optional(),
  }).optional(),
})
const prompt = z.object({
  text: z.string(),
  attachments: z.array(attachment),
  planRefs: z.array(z.object({
    planId: z.string(), sessionId: z.string(), planToolUseId: z.string(),
    title: z.string(), status: z.enum(['pending', 'accepted', 'rejected']),
  })),
  workRefs: z.array(z.object({
    workId: z.string(), title: z.string(), type: z.enum(['doc', 'slides', 'artifact']),
  })),
  sessionRefs: z.array(z.object({
    sessionId: z.string(), provider: agentIdSchema,
    title: z.string(), cwd: z.string(), serverId: z.string().optional(),
  })),
}) satisfies z.ZodType<Prompt>

const entrySchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  serverId: z.string(),
  sessionId: z.string(),
  draftId: z.string().optional(),
  prompt,
})
export type PromptStashEntry = z.infer<typeof entrySchema>
const entries = z.array(entrySchema)

export function promptStashKey(account: string | null, organizationId: string | null): string {
  return `solus:prompt-stash:v1:${JSON.stringify([account, organizationId])}`
}

export class PromptStash {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'>) {}

  read(key: string): PromptStashEntry[] {
    const raw = this.storage.getItem(key)
    if (raw === null) return []
    return entries.parse(JSON.parse(raw))
  }

  save(key: string, entry: PromptStashEntry) {
    const current = this.read(key)
    if (current.length >= MAX_STASHED_PROMPTS) return { status: 'full' as const, entries: current }
    const next = [entrySchema.parse(entry), ...current]
    this.storage.setItem(key, JSON.stringify(next))
    return { status: 'saved' as const, entries: next }
  }

  take(key: string, id: string) {
    const current = this.read(key)
    const entry = current.find((entry) => entry.id === id)
    if (!entry) return { entry, entries: current }
    const next = current.filter((entry) => entry.id !== id)
    this.storage.setItem(key, JSON.stringify(next))
    return { entry, entries: next }
  }
}

export function hasStashContent(prompt: Prompt): boolean {
  return !!(prompt.text.trim() || prompt.attachments.length ||
    prompt.planRefs.length || prompt.workRefs.length || prompt.sessionRefs.length)
}

export function stashPreview(prompt: Prompt): string {
  const text = prompt.text.trim().replace(/\s+/g, ' ')
  if (text.length > 90) return `${text.slice(0, 90).replace(/[\uD800-\uDBFF]$/, '')}…`
  if (text) return text

  const files = prompt.attachments.filter((attachment) => attachment.type === 'file').length
  const images = prompt.attachments.filter((attachment) => attachment.type === 'image').length
  const count = files + images
  if (!count) return 'Attached context'
  const unit = files && images ? 'attachment' : files ? 'file' : 'image'
  return `(${count} ${unit}${count === 1 ? '' : 's'})`
}

function appendUnique<Item>(current: Item[], restored: Item[], keyOf: (item: Item) => string): void {
  const existing = new Set(current.map(keyOf))
  for (const item of restored) {
    const key = keyOf(item)
    if (existing.has(key)) continue
    existing.add(key)
    current.push(item)
  }
}

export function restoreStashedPrompt(current: Prompt, restored: Prompt): void {
  if (restored.text) {
    current.text = current.text.trim() ? `${current.text.trimEnd()}\n\n${restored.text}` : restored.text
  }
  appendUnique(current.attachments, restored.attachments, (attachment) => attachment.id)
  appendUnique(current.planRefs, restored.planRefs, (reference) => reference.planId)
  appendUnique(current.workRefs, restored.workRefs, (reference) => reference.workId)
  appendUnique(current.sessionRefs, restored.sessionRefs, (reference) => reference.sessionId)
}

export function stashAttachmentHost(attachment: Attachment, sourceServerId: string): string | undefined {
  if (attachment.type === 'image' && attachment.dataUrl) return undefined
  if (attachment.type === 'design-selection' && !attachment.hostPath) return undefined
  return attachment.hostServerId ?? sourceServerId
}

export function stashedFileExpired(entry: PromptStashEntry, attachment: Attachment, now: number): boolean {
  return !!attachment.hostPath && stashAttachmentHost(attachment, entry.serverId) !== undefined &&
    now - entry.createdAt >= STASH_FILE_LIFETIME_MS
}
