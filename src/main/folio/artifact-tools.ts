import { z } from 'zod'
import { createLogger } from '../logger'
import type { AgentTool } from '../agents/tools/agent-tool'

const log = createLogger('folio', 'artifact-tools.ts')

/**
 * Agent-facing `render_artifact` tool — declares a *visual* HTML deliverable
 * that renders flush in the conversation (charts, sliders, simulations). Unlike
 * works it is not persisted as a managed artifact; it lives in the transcript
 * and re-renders on reload.
 *
 * Image artifacts are NOT produced here — they arrive only from Codex's native
 * ImageGeneration tool, normalized into the same `artifact_created` event and
 * rendered by the shared ArtifactView.
 *
 * The executor returns error text rather than throwing so a bad call degrades
 * to a message the agent can recover from.
 */

export interface ArtifactPayload {
  html: string
}

export type OnArtifact = (artifact: ArtifactPayload) => void

/** Side-effects threaded into the executor per call. */
export interface ArtifactToolDeps {
  onArtifact?: OnArtifact
}

export const ARTIFACT_TOOL_NAME = 'render_artifact'

const artifactFields = {
  html: z.string().describe('A finished, self-contained HTML document to render.'),
} as const

export const ARTIFACT_TOOL_DESC = [
  'Render a finished, self-contained HTML artifact flush in the conversation (charts, diagrams, simulations, interactive widgets).',
  'Do NOT call this directly with hand-authored HTML. To create an artifact, use the `visual-artifacts` skill — it owns the Solus design system and the sandbox constraints, authors the HTML, and calls this tool for you as its final step.',
].join('\n')

export interface ArtifactToolResult {
  ok: boolean
  text: string
}

export async function executeArtifactTool(
  args: z.input<typeof artifactInputSchema>,
  deps: ArtifactToolDeps = {},
): Promise<ArtifactToolResult> {
  try {
    const html = artifactInputSchema.parse(args).html
    if (!html.trim()) return { ok: false, text: 'render_artifact requires non-empty html.' }
    deps.onArtifact?.({ html })
    return { ok: true, text: 'Rendered the HTML artifact in the conversation.' }
  } catch (err: any) {
    log.error('artifact_tool_failed', { error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `render_artifact error: ${String(err?.message ?? err)}` }
  }
}

const artifactInputSchema = z.object({ html: z.string().catch('') })

export const renderArtifactAgentTool: AgentTool = {
  name: ARTIFACT_TOOL_NAME,
  description: ARTIFACT_TOOL_DESC,
  inputFields: artifactFields,
  requiresApproval: false,
  execute: async (args, context) => executeArtifactTool(args, {
    onArtifact: (artifact) => context.emit({
      type: 'artifact_created',
      kind: 'html',
      html: artifact.html,
    }),
  }),
}
