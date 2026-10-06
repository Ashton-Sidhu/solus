import { z } from 'zod'
import { resolveArtifactTitle } from '@solus/contracts/work-preview'
import { serializeWorkEmbed } from '@solus/contracts/work-embed'
import { join } from 'node:path'
import { createLogger } from '../../../logger'
import { writeAssetUpload } from '../../../data/assets/assets'
import {
  HTML_PREVIEW_DEFAULT_WIDTH,
  inlineHostImages,
  previewArtifactHtml,
  type HtmlPreview,
} from '../../../data/works/artifact-preview'
import { dataDir } from '../../../platform/paths'
import type { AgentTool } from './agent-tool'
import { createAgentWork, type WorkCreateCtx } from './work-tools'
import { readArtifactHtml } from './artifact-file'

const log = createLogger('folio', 'artifact-tools.ts')

/**
 * Agent-facing `render_artifact` tool — declares a *visual* HTML deliverable
 * that renders flush in the conversation (charts, sliders, simulations).
 *
 * The HTML is persisted as an `artifact` work, so it has the same standing as
 * a document or diagram: a durable id, a place in the works gallery, a task
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
  html: z.string().optional().describe('A finished, self-contained HTML document to render. Pass this or html_path, not both.'),
  html_path: z.string().optional().describe(
    'The path of a compiled HTML file on this host, such as the visual-artifacts bundle.html. A relative path is relative to your working directory. Solus reads the file, so its content does not pass through your output. Pass this or html, not both.',
  ),
  title: z.string().optional().describe(
    'A short, human-readable title for the artifact, as it should read in the works gallery and on a task. Defaults to the document <title>.',
  ),
  link_to_task: z.boolean().optional().describe(
    'Also link the artifact to the session\'s task, so it shows on the task page and on any pull request the task is linked to. Default false: the reader links or pins it from the render\'s rail when they want it there. Pass true when the user asked for it on the task.',
  ),
  preview: z.boolean().optional().describe(
    'Check the page instead of saving it: returns a screenshot path to read, the page height, console output and errors, and missing local images. Saves nothing and shows nothing to the user. Use it before a ```html fence as well as before saving an artifact.',
  ),
  preview_width: z.number().int().optional().describe(
    `Preview width in CSS pixels, 320-1440. Defaults to ${HTML_PREVIEW_DEFAULT_WIDTH}, the reply column; use about 390 to check a phone.`,
  ),
  preview_appearance: z.enum(['light', 'dark']).optional().describe('Theme to preview in. Defaults to light.'),
} as const

export const ARTIFACT_TOOL_DESC = [
  'Render a finished, self-contained HTML artifact flush in the conversation (charts, diagrams, simulations, interactive widgets).',
  'The artifact is saved as a work: the result names its work_id, which read_work and update_work accept, which link_to_task files on the session\'s task, and which embeds it in a document or plan.',
  'Only call this when the render needs that durable identity — you will revise it by id, it belongs on a task, or the user asked to keep it. It is not linked to a task unless link_to_task is true.',
  'For something visual the user reads once, write a fenced ```html block in your reply instead: Solus renders it live in the same sandboxed frame, with no tool call. A fence carrying a <style>, a <script>, or a whole document renders; a bare fragment stays code to read. Write ```html render or ```html source to say which when the content does not make it obvious.',
  'Solus injects its active theme as CSS custom properties on :root, and they follow the user\'s light or dark mode live: --background (page background, identical to the conversation around the frame), --foreground, --muted, --muted-foreground, --card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring, --primary, --primary-foreground (solid buttons), --accent, --accent-foreground (brand accent), --accent-surface, --accent-surface-foreground, --destructive, --destructive-foreground, --destructive-surface, --warning, --warning-foreground, --warning-surface, --success, --success-foreground, --info, --info-foreground, --code-background, --code-foreground, --chart-1 … --chart-6 (categorical series for charts, in order), --radius, --font-sans, --font-mono. The base stylesheet sets html background, color, and a 14px font from these, body margin to 0, and monospace for code; your own CSS overrides it. Style with these variables, never fixed colors.',
  'The frame is borderless on the conversation background and as wide as the reply column. Use a fluid width with no horizontal padding on the outermost element, and no outer card, border, or banner title: the page is part of your reply. Give charts fixed pixel heights rather than heights that scale with width. Let content set the page height; avoid 100vh or height:100% on html or body. To show a local image such as a screenshot, write its absolute path in src or CSS url(); Solus writes the file into the page.',
  'Give inline HTML fences a stable conversation-local identity: ```html render artifact=revenue-chart. Reuse that artifact= value when revising the same visual in later replies; use a new value for a separate visual or alternative. Use only letters, digits, hyphens, and underscores, up to 80 characters. Completed revisions collapse earlier previews, which remain available. Emit only one completed revision per identity in a reply. Saved artifact works are revised with update_work, which renders the new version inline automatically.',
  'Check a page before the user sees it: call render_artifact with preview: true. It renders the HTML in a headless browser with the Solus theme at the reply width and returns a screenshot to read, the height the page needs, its console output and errors, and any local image it could not find. A preview saves nothing and shows nothing. Fix what it shows, then write the ```html fence in your reply or call render_artifact again without preview to save it.',
  'For a compiled file, such as the visual-artifacts bundle.html, pass html_path rather than the file content: Solus reads the file on this host.',
  'Either way, do NOT hand-author the HTML directly. Use the `visual-artifacts` skill — it owns the Solus design system and the sandbox constraints, authors the HTML, and calls this tool for you when a tool call is the right one.',
].join('\n')

export interface ArtifactToolResult {
  ok: boolean
  text: string
}

interface ArtifactToolArgs {
  html?: string
  html_path?: string
  title?: string
  link_to_task?: boolean
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
    .map((entry) => `  [${entry.level}] ${entry.text.slice(0, 300)}`)
}

const ALL_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug'])
const ERROR_LEVELS = new Set(['error'])

async function previewReport(title: string, preview: HtmlPreview): Promise<string> {
  const stored = await writeAssetUpload({ name: 'html-preview.png', mime: 'image/png', dataUrl: preview.screenshot })
  const lines = [
    `Preview of "${title}" at ${preview.width}px, ${preview.appearance}: the page is ${preview.contentHeight}px tall. Nothing was saved or shown to the user.`,
    `screenshot: ${join(dataDir(), 'assets', stored.id)}  (read this path to look at it)`,
  ]
  const logged = consoleLines(preview.console, ALL_LEVELS)
  lines.push(logged.length ? `console (${preview.console.length}):\n${logged.join('\n')}` : 'console: nothing logged.')
  if (preview.missingImages.length) {
    lines.push(`missing images (not found, or over 8 MB): ${preview.missingImages.join(', ')}`)
  }
  return lines.join('\n')
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
): Promise<ArtifactToolResult> {
  try {
    const input = artifactInputSchema.parse(args)
    if (input.html && input.html_path) return { ok: false, text: 'render_artifact takes html or html_path, not both.' }
    let html = input.html
    if (input.html_path) {
      const read = await readArtifactHtml(input.html_path, deps.ctx?.cwd ?? '~')
      if ('error' in read) return { ok: false, text: `render_artifact error: ${read.error}` }
      html = read.html
    }
    if (!html.trim()) return { ok: false, text: 'render_artifact requires non-empty html or an html_path.' }
    const title = resolveArtifactTitle(input.title, html)
    if (input.preview) {
      const preview = await (deps.preview ?? previewArtifactHtml)({
        html,
        width: input.preview_width,
        appearance: input.preview_appearance,
      })
      return { ok: true, text: await previewReport(title, preview) }
    }
    // A saved artifact carries its local images, so it renders on any client
    // and matches what a preview showed.
    html = (await (deps.inlineImages ?? inlineHostImages)(html)).html
    const created = await createAgentWork(title, 'artifact', html, deps.ctx, input.link_to_task === true)
    deps.onArtifact?.({ html, workId: created.workId, title: created.title })
    const syncNote = created.foreignTaskId
      ? ` It syncs to the task's host and links to task ${created.foreignTaskId}.`
      : created.organizationOwned
        ? ` It is saved in the organization's Solus API${input.link_to_task ? ' and linked to the session\'s task there' : ''}.`
      : input.link_to_task
        ? ' It is linked to the session\'s task.'
        : ' It is not linked to a task; pass link_to_task: true, or the reader can link it from the rail.'
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
  title: z.string().optional().catch(undefined),
  link_to_task: z.boolean().optional().catch(undefined),
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
    }),
  }),
}
