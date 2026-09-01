import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from '../logger'

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
 * Exports the same three shapes as work-tools.ts (SDK `tool(...)`, a Codex
 * JSON-schema descriptor, and a plain executor) so both backends + the mock can
 * drive it. The executor returns error TEXT (never throws), matching
 * `executeWorkTool`, so a bad call degrades to a message the agent recovers from.
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

const artifactShape = {
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
  args: Record<string, unknown>,
  deps: ArtifactToolDeps = {},
): Promise<ArtifactToolResult> {
  try {
    const html = typeof args.html === 'string' ? args.html : ''
    if (!html.trim()) return { ok: false, text: 'render_artifact requires non-empty html.' }
    deps.onArtifact?.({ html })
    return { ok: true, text: 'Rendered the HTML artifact in the conversation.' }
  } catch (err: any) {
    log.error(`executeArtifactTool failed: ${String(err)}`)
    return { ok: false, text: `render_artifact error: ${String(err?.message ?? err)}` }
  }
}

// ─── Shape 1: Claude SDK tool (registered on the shared solus MCP server) ───

export function artifactTool(deps: ArtifactToolDeps) {
  return tool(ARTIFACT_TOOL_NAME, ARTIFACT_TOOL_DESC, artifactShape, async (args) => {
    const r = await executeArtifactTool(args as Record<string, unknown>, deps)
    return {
      content: [{ type: 'text' as const, text: r.text }],
      ...(r.ok ? {} : { isError: true as const }),
    }
  })
}

// ─── Shape 2: Codex dynamicTools JSON-schema descriptor ───

export const ARTIFACT_TOOL_JSON_SCHEMA = {
  name: ARTIFACT_TOOL_NAME,
  description: ARTIFACT_TOOL_DESC,
  inputSchema: z.toJSONSchema(z.object(artifactShape)) as Record<string, unknown>,
}
