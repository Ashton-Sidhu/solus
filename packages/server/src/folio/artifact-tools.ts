import { z } from 'zod'
import { resolveArtifactTitle } from '@solus/contracts/work-preview'
import { createLogger } from '../logger'
import type { AgentTool } from '../agents/tools/agent-tool'
import { createAgentWork, type WorkCreateCtx } from './work-tools'

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
}

export const ARTIFACT_TOOL_NAME = 'render_artifact'

const artifactFields = {
  html: z.string().describe('A finished, self-contained HTML document to render.'),
  title: z.string().optional().describe(
    'A short, human-readable title for the artifact, as it should read in the works gallery and on a task. Defaults to the document <title>.',
  ),
} as const

export const ARTIFACT_TOOL_DESC = [
  'Render a finished, self-contained HTML artifact flush in the conversation (charts, diagrams, simulations, interactive widgets).',
  'The artifact is saved as a work: the result names its work_id, which read_work and update_work accept, and which links it to the session\'s task.',
  'Do NOT call this directly with hand-authored HTML. To create an artifact, use the `visual-artifacts` skill — it owns the Solus design system and the sandbox constraints, authors the HTML, and calls this tool for you as its final step.',
].join('\n')

export interface ArtifactToolResult {
  ok: boolean
  text: string
}

interface ArtifactToolArgs {
  html?: string
  title?: string
}

export async function executeArtifactTool(
  args: ArtifactToolArgs,
  deps: ArtifactToolDeps = {},
): Promise<ArtifactToolResult> {
  try {
    const input = artifactInputSchema.parse(args)
    const html = input.html
    if (!html.trim()) return { ok: false, text: 'render_artifact requires non-empty html.' }
    const title = resolveArtifactTitle(input.title, html)
    const created = await createAgentWork(title, 'artifact', html, deps.ctx)
    deps.onArtifact?.({ html, workId: created.workId, title: created.title })
    const syncNote = created.foreignTaskId
      ? ` It syncs to the task's host and links to task ${created.foreignTaskId}.`
      : ''
    return {
      ok: true,
      text: `Rendered "${created.title}" in the conversation and saved it as an artifact (id: ${created.workId}). Revise it with update_work; do not render a second copy.${syncNote}`,
    }
  } catch (err: any) {
    log.error('artifact_tool_failed', { error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `render_artifact error: ${String(err?.message ?? err)}` }
  }
}

const artifactInputSchema = z.object({
  html: z.string().catch(''),
  title: z.string().optional().catch(undefined),
})

export const renderArtifactAgentTool: AgentTool = {
  name: ARTIFACT_TOOL_NAME,
  description: ARTIFACT_TOOL_DESC,
  inputFields: artifactFields,
  requiresApproval: false,
  execute: async (args, context) => executeArtifactTool(args, {
    ctx: {
      sessionId: context.sessionId(),
      agentProvider: context.provider,
      cwd: context.cwd,
      solusSessionId: context.solusSessionId(),
    },
    onArtifact: (artifact) => context.emit({
      type: 'artifact_created',
      kind: 'html',
      html: artifact.html,
      workId: artifact.workId,
      title: artifact.title,
    }),
  }),
}
