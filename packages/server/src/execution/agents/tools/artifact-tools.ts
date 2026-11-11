import { z } from 'zod'
import { serializeWorkEmbed } from '@solus/contracts/work-embed'
import { cutText } from '@solus/contracts/text-cut'
import { join } from 'node:path'
import { createLogger } from '../../../logger'
import { writeAssetUpload } from '../../../data/assets/assets'
import { agentReadablePath } from '../../../data/assets/attachment-store'
import {
  HTML_PREVIEW_DEFAULT_WIDTH,
  inlineHostImages,
  previewArtifactHtml,
  type HtmlPreview,
} from '../../../data/works/artifact-preview'
import { dataDir } from '../../../platform/paths'
import { agentToolImageFromDataUrl, type AgentTool, type AgentToolResult } from './agent-tool'
import { createAgentWork, type WorkCreateCtx } from './work-tools'
import { readWorkFile } from './work-file'

const log = createLogger('folio', 'artifact-tools.ts')

/**
 * Agent-facing `render_artifact` tool — declares a *visual* HTML deliverable
 * that renders flush in the conversation (charts, sliders, simulations).
 *
 * The HTML is persisted as an `artifact` work, so it has the same standing as
 * a document: a durable id, a place in the works gallery, a task
 * link, `read_work`/`update_work`, and a copy that ships with a dispatched
 * task snapshot. The conversation still renders it inline from the event.
 *
 * Image artifacts are NOT produced here — they arrive only from Codex's native
 * ImageGeneration tool, normalized into the same `artifact_created` event and
 * rendered by the shared ArtifactView. They are not works.
 *
 * The executor returns error text rather than throwing so a bad call degrades
 * to a message the agent can recover from.
 */

export interface ArtifactPayload {
  html: string
  workId: string
  title: string
  /** The organization whose Solus API holds the artifact; null when it is on this host. */
  organizationId: string | null
}

export type OnArtifact = (artifact: ArtifactPayload) => void

/** Side-effects and creation context threaded into the executor per call. */
export interface ArtifactToolDeps {
  onArtifact?: OnArtifact
  ctx?: WorkCreateCtx
  /** Renders a page in the headless browser. Replaced in tests. */
  preview?: typeof previewArtifactHtml
  /** Writes a page's local images into it. Replaced in tests. */
  inlineImages?: typeof inlineHostImages
}

export const ARTIFACT_TOOL_NAME = 'render_artifact'

const artifactFields = {
  html: z.string().optional().describe('A finished, self-contained HTML document to render. Pass this or html_path.'),
  html_path: z.string().optional().describe(
    'Path to an .html file on this host, such as the visual-artifacts bundle.html, relative to your working directory. Pass this or html.',
  ),
  title: z.string().describe(
    'A short, human-readable title for the artifact, as it should read in the works gallery in the session.',
  ),
  preview: z.boolean().optional().describe(
    'Check the page instead of saving it. Use it before a ```html fence as well as before saving an artifact.',
  ),
  preview_width: z.number().int().optional().describe(
    `Preview width in CSS pixels, 320-1440. Defaults to ${HTML_PREVIEW_DEFAULT_WIDTH}, the reply column; use about 390 to check a phone.`,
  ),
  preview_appearance: z.enum(['light', 'dark']).optional().describe('Theme to preview in. Defaults to light.'),
} as const

export const ARTIFACT_TOOL_DESC = [
  'Render a finished, self-contained HTML artifact in the conversation (charts, diagrams, simulations, interactive widgets) and save it as a work. The result names its work_id, which read_work, update_work, and link accept and which embeds it in a document or plan. update_work revises it and renders the new version inline.',
  'Call this only when the render needs that durable identity: you will revise it by id, it belongs in the session, or the user asked to keep it.',
  'For a visual the user reads once, write a ```html fence in your reply instead: Solus renders it live in the same sandboxed frame, with no tool call. A fence with a <style>, a <script>, or a whole document renders; a bare fragment stays code. Write ```html render or ```html source when the content does not make it obvious. Give a fence an identity, ```html render artifact=revenue-chart (letters, digits, - and _, up to 80 characters): reuse it to revise that visual, use a new one for a separate visual, and emit one completed revision per identity in a reply.',
  'The reader sees the page as part of your reply: do not announce it, say where it is, or restate it.',
  'Solus sets its theme as CSS variables on :root, following light and dark mode live. Style with them, never fixed colors: --background (the conversation background), --foreground, --muted, --muted-foreground, --card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring, --primary, --primary-foreground (solid buttons), --accent, --accent-foreground, --accent-surface, --accent-surface-foreground, --brand, --brand-foreground (solid buttons in a mock-up of Solus itself), --destructive, --destructive-foreground, --destructive-surface, --warning, --warning-foreground, --warning-surface, --success, --success-foreground, --info, --info-foreground, --code-background, --code-foreground, --chart-1 … --chart-6 (chart series), --radius, --font-sans, --font-mono. The base stylesheet sets a 14px font, body margin 0, monospace code, and a hidden scrollbar.',
  `The frame is borderless, as wide as the reply column (${HTML_PREVIEW_DEFAULT_WIDTH}px by default, about 360px on a phone), and aligned with your text. Give html, body, and the outermost element no background color (this overrides a style preference for a page background), no horizontal padding, and no outer card, border, or banner title. A box with its own background gets at least 16px padding and var(--radius) corners. Give charts fixed pixel heights. Let content set the height: never 100vh or height:100% on html or body.`,
  'For a local image, write its absolute path in src or CSS url() and Solus writes the file into the page. Remote http(s) URLs, such as a CDN library, load as they are.',
  'Check a page first with preview: true. It renders the page in a headless browser with the Solus theme at the reply width and returns a screenshot you see, the page height, console output and errors, and missing local images. It saves and shows nothing. Fix what it shows, then write the fence or call again without preview.',
  'For a file on disk, such as the visual-artifacts bundle.html, pass html_path instead of html, so the page does not pass through your output.',
  'Do NOT hand-author the HTML: use the `visual-artifacts` skill. It owns the Solus design system and the sandbox rules, and calls this tool when a tool call is right.',
].join('\n')

interface ArtifactToolArgs {
  html?: string
  html_path?: string
  title: string
  preview?: boolean
  preview_width?: number
  preview_appearance?: 'light' | 'dark'
}

/** How long a save waits for its render check before it reports without one. */
const SAVE_CHECK_TIMEOUT_MS = 8_000
const MAX_REPORTED_CONSOLE_ENTRIES = 20

function consoleLines(entries: HtmlPreview['console'], levels: ReadonlySet<string>): string[] {
  return entries
    .filter((entry) => levels.has(entry.level))
    .slice(0, MAX_REPORTED_CONSOLE_ENTRIES)
    .map((entry) => `  [${entry.level}] ${cutText(entry.text, 300)}`)
}

const ALL_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug'])
const ERROR_LEVELS = new Set(['error'])

/** The screenshot comes back as an image the agent sees, so checking a page
 *  takes one call. One too large for a tool result is stored as a file to read. */
async function previewReport(title: string, preview: HtmlPreview): Promise<AgentToolResult> {
  const image = await agentToolImageFromDataUrl(preview.screenshot)
  const lines = [
    `Preview of "${title}" at ${preview.width}px, ${preview.appearance}: the page is ${preview.contentHeight}px tall. No work was saved and nothing was rendered in the conversation.`,
    'To show the page, write it in a ```html fence in your reply, or call render_artifact again without preview. Do not show this screenshot in its place.',
  ]
  if (image) lines.push('screenshot: attached to this result.')
  else {
    const stored = await writeAssetUpload({ name: 'html-preview.png', mime: 'image/png', dataUrl: preview.screenshot })
    const path = await agentReadablePath(join(dataDir(), 'assets', stored.id))
    lines.push(`screenshot: ${path}  (too large to attach; read this path to look at it)`)
  }
  const logged = consoleLines(preview.console, ALL_LEVELS)
  lines.push(logged.length ? `console (${preview.console.length}):\n${logged.join('\n')}` : 'console: nothing logged.')
  if (preview.missingImages.length) {
    lines.push(`missing images (not found, or over 8 MB): ${preview.missingImages.join(', ')}`)
  }
  const report: AgentToolResult = { ok: true, text: lines.join('\n') }
  if (image) report.image = image
  return report
}

/** Errors a saved page raises, so a broken render is reported rather than silent.
 *  A host with no headless browser, or a slow page, saves without the check. */
async function saveCheckNote(html: string, deps: ArtifactToolDeps): Promise<string> {
  const preview = deps.preview ?? previewArtifactHtml
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SAVE_CHECK_TIMEOUT_MS) })
  const checked = await Promise.race([preview({ html }).catch(() => null), timeout])
  clearTimeout(timer)
  if (!checked) return ''
  const errors = consoleLines(checked.console, ERROR_LEVELS)
  const notes = []
  if (errors.length) notes.push(`The page raised errors when rendered:\n${errors.join('\n')}`)
  if (checked.missingImages.length) notes.push(`These local images could not be loaded: ${checked.missingImages.join(', ')}`)
  return notes.length ? `\n\n${notes.join('\n')}\nFix them with update_work.` : ''
}

export async function executeArtifactTool(
  args: ArtifactToolArgs,
  deps: ArtifactToolDeps = {},
): Promise<AgentToolResult> {
  try {
    const input = artifactInputSchema.parse(args)
    if (input.html && input.html_path) return { ok: false, text: 'render_artifact takes html or html_path, not both.' }
    let html = input.html
    if (input.html_path) {
      const read = await readWorkFile('html_path', input.html_path, deps.ctx?.cwd ?? '~')
      if ('error' in read) return { ok: false, text: `render_artifact error: ${read.error}` }
      html = read.body
    }
    if (!html.trim()) return { ok: false, text: 'render_artifact requires non-empty html or an html_path.' }
    const title = input.title.trim()
    if (!title) return { ok: false, text: 'render_artifact requires a title.' }
    if (input.preview) {
      const preview = await (deps.preview ?? previewArtifactHtml)({
        html,
        width: input.preview_width,
        appearance: input.preview_appearance,
      })
      return await previewReport(title, preview)
    }
    // A saved artifact carries its local images, so it renders on any client
    // and matches what a preview showed.
    html = (await (deps.inlineImages ?? inlineHostImages)(html)).html
    const created = await createAgentWork(title, 'artifact', html, deps.ctx, false)
    deps.onArtifact?.({ html, workId: created.workId, title: created.title, organizationId: created.organizationId })
    const syncNote = created.foreignTaskId
      ? ` It syncs to the task's host and keeps its originating session.`
      : created.organizationId
        ? ' It is saved in the organization’s Solus API and associated with this session.'
        : ' It is associated with this session.'
    const checkNote = await saveCheckNote(html, deps)
    const embedNote = `\n\nTo embed this artifact in a Solus document or plan, place this token on its own line:\n\n${serializeWorkEmbed({ workId: created.workId, title: created.title, type: 'artifact' })}`
    return {
      ok: true,
      text: `Rendered "${created.title}" in the conversation and saved it as an artifact (id: ${created.workId}). Revise it with update_work; do not render a second copy.${syncNote}${checkNote}${embedNote}`,
    }
  } catch (err: any) {
    log.error('artifact_tool_failed', { error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `render_artifact error: ${String(err?.message ?? err)}` }
  }
}

const artifactInputSchema = z.object({
  html: z.string().catch(''),
  html_path: z.string().optional().catch(undefined),
  title: z.string().catch(''),
  preview: z.boolean().optional().catch(undefined),
  preview_width: z.number().int().optional().catch(undefined),
  preview_appearance: z.enum(['light', 'dark']).optional().catch(undefined),
})

export const renderArtifactAgentTool: AgentTool = {
  name: ARTIFACT_TOOL_NAME,
  description: ARTIFACT_TOOL_DESC,
  inputFields: artifactFields,
  requiresApproval: false,
  // The description is where the agent learns that a ```html fence renders
  // live. Deferred behind tool search, that rule is invisible until too late.
  alwaysLoad: true,
  execute: async (args, context) => executeArtifactTool(args, {
    ctx: {
      sessionId: context.sessionId(),
      agentProvider: context.provider,
      cwd: context.cwd,
    },
    onArtifact: (artifact) => context.emit({
      type: 'artifact_created',
      toolId: context.parentToolUseId(),
      kind: 'html',
      html: artifact.html,
      workId: artifact.workId,
      title: artifact.title,
      organizationId: artifact.organizationId,
    }),
  }),
}
