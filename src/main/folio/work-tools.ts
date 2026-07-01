import { z } from 'zod'
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { listWorks, loadWork, agentSaveWork, createWork } from './works'
import { workPreview } from '../../shared/work-preview'
import { parseDiagram } from '../../shared/diagram-types'
import type { AgentId } from '../../shared/types'
import { createLogger } from '../logger'
import { artifactTool, type ArtifactToolDeps } from './artifact-tools'
import { reviewLedgerTool } from '../review/ledger-tool'
import { automationSdkTools, type OnAutomationSaved } from '../automations/automation-tools'
import { sessionSdkTools, type OnSessionCreated } from '../sessions/session-tools'
import { taskSdkTools } from '../tasks/task-tools'

const log = createLogger('folio', 'work-tools.ts')

/**
 * Single source of truth for the agent-facing work tools (list/read/create/update).
 * Exports three shapes from the same zod schemas:
 *   1. `createSolusMcpServer` — an in-process SDK MCP server for Claude. It hosts
 *      the work tools plus the `render_artifact` tool (see artifact-tools.ts), so
 *      Claude registers a single general-purpose "solus" MCP server.
 *   2. `WORK_TOOL_JSON_SCHEMAS` — JSON-schema descriptors for Codex dynamicTools.
 *   3. `executeWorkTool` — a plain executor for the Codex handler + mock backend.
 *
 * `create_work`/`update_work` return error TEXT (never throw) for invalid input
 * so a bad call degrades to a message the agent can recover from.
 */

export interface WorkUpdatedPayload {
  workId: string
  title: string
  docType: 'doc' | 'slides' | 'diagram'
  content: string
  updatedAt: string
}

export type OnWorkUpdated = (work: WorkUpdatedPayload) => void

export interface WorkCreatedPayload {
  workId: string
  title: string
  docType: 'doc' | 'slides' | 'diagram'
  content: string
}

export type OnWorkCreated = (work: WorkCreatedPayload) => void

/** Origin context for a newly created work (who/where it came from). */
export interface WorkCreateCtx {
  sessionId: string | undefined
  agentProvider: AgentId
  cwd: string
}

/** Side-effects + creation context threaded into the executor per call. */
export interface WorkToolDeps {
  onWorkUpdated?: OnWorkUpdated
  onWorkCreated?: OnWorkCreated
  ctx?: WorkCreateCtx
}

// ─── Schemas (raw zod shapes, reused by every shape we export) ───

const listWorksShape = {} as const

const readWorkShape = {
  work_id: z.string().describe('The id of the work to read (from list_works).'),
}

const updateWorkShape = {
  work_id: z.string().describe('The id of the work to update (from list_works).'),
  content: z.string().describe('The full new content of the work. Replaces the existing content entirely.'),
  title: z.string().optional().describe('Optional new title for the work.'),
}

const createWorkShape = {
  title: z.string().describe('A short, human-readable title for the work.'),
  doc_type: z.enum(['doc', 'slides', 'diagram']).describe(
    "The kind of work: 'doc' (markdown document), 'slides' (slide deck), or 'diagram' (architecture diagram).",
  ),
  content: z.string().describe(
    'The full content. For doc/slides this is markdown. For diagram this is serialized JSON shaped like {"nodes":[...],"edges":[...]}.',
  ),
}

const DIAGRAM_GUIDANCE = [
  'For doc/slides the `content` arg is markdown. For diagrams, `content` must be serialized JSON shaped like {"nodes":[{"id","label",...}],"edges":[{"id","source","target",...}]}. Omit "position" — Solus auto-layouts.',
  'Before authoring or editing a diagram, load the `diagrams` skill — it owns the full node/edge contract, icons, data-model entities (typed fields + keys), relationship cardinality, groups, drill-down details, and worked examples. Create a diagram only when the user asks for a system/architecture/data diagram they can edit.',
].join('\n')

const LIST_DESC =
  'List the works (documents and architecture diagrams) the user has open in Solus, with their id, title, type and last-updated time. Call this first to discover a work_id before reading or updating.'
const READ_DESC =
  'Read the full current content of a work by id, including any edits the user made manually. Always call this before update_work so you revise the latest version.'
const CREATE_DESC = [
  'Create a NEW standalone artifact the user will keep, export, or hand off — a document, slide deck, or architecture diagram.',
  'The content streams into a card in the conversation as you write it. Use this only for brand-new works; to revise a work the user already has open, call update_work instead (never create a duplicate).',
  '',
  DIAGRAM_GUIDANCE,
].join('\n')
const UPDATE_DESC = [
  'Replace the content (and optionally the title) of an existing work by id. Use this to revise a document or diagram the user is looking at — never create a new work to revise one that already exists.',
  '',
  DIAGRAM_GUIDANCE,
].join('\n')

// ─── Executor (shared by Codex handler + mock backend) ───

export interface WorkToolResult {
  ok: boolean
  text: string
}

export async function executeWorkTool(
  name: string,
  args: Record<string, unknown>,
  deps: WorkToolDeps = {},
): Promise<WorkToolResult> {
  try {
    if (name === 'list_works') {
      const works = await listWorks(deps.ctx?.cwd)
      if (works.length === 0) return { ok: true, text: 'No works are currently open.' }
      const lines = works.map(
        (w) => `- ${w.id} — "${w.title}" (${w.type}, ${w.storage?.kind ?? 'local'}), updated ${w.updatedAt}`,
      )
      return { ok: true, text: `Open works:\n${lines.join('\n')}` }
    }

    if (name === 'read_work') {
      const workId = String(args.work_id ?? '')
      if (!workId) return { ok: false, text: 'read_work requires a work_id.' }
      const work = await loadWork(workId, deps.ctx?.cwd)
      if (!work) return { ok: false, text: `No work found with id "${workId}".` }
      return {
        ok: true,
        text: `Work "${work.title}" (${work.type}, id: ${work.id}):\n\n${work.content}`,
      }
    }

    if (name === 'create_work') {
      const title = typeof args.title === 'string' && args.title.trim() ? args.title : 'Untitled'
      const rawType = String(args.doc_type ?? 'doc')
      const docType: 'doc' | 'slides' | 'diagram' =
        rawType === 'slides' || rawType === 'diagram' ? rawType : 'doc'
      const content = typeof args.content === 'string' ? args.content : ''
      if (!content.trim()) return { ok: false, text: 'create_work requires non-empty content.' }

      if (docType === 'diagram') {
        try {
          parseDiagram(content)
        } catch (err: any) {
          return {
            ok: false,
            text: `Invalid diagram content: ${String(err?.message ?? err)}. The content must be JSON shaped like {"nodes":[...],"edges":[...]}.`,
          }
        }
      }

      const preview = workPreview(docType, content)
      const created = await createWork(
        title,
        docType,
        content,
        preview,
        deps.ctx?.sessionId,
        deps.ctx?.agentProvider ?? 'claude-code',
        deps.ctx?.cwd ?? '~',
      )

      deps.onWorkCreated?.({
        workId: created.id,
        title: created.title,
        docType: created.type,
        content: created.content,
      })
      return { ok: true, text: `Created "${created.title}" (id: ${created.id}).` }
    }

    if (name === 'update_work') {
      const workId = String(args.work_id ?? '')
      if (!workId) return { ok: false, text: 'update_work requires a work_id.' }
      const content = typeof args.content === 'string' ? args.content : ''
      if (!content.trim()) return { ok: false, text: 'update_work requires non-empty content.' }
      const title = typeof args.title === 'string' ? args.title : undefined

      const existing = await loadWork(workId, deps.ctx?.cwd)
      if (!existing) return { ok: false, text: `No work found with id "${workId}".` }

      const preview = workPreview(existing.type, content)
      const saved = await agentSaveWork(workId, { content, preview, ...(title !== undefined ? { title } : {}) }, deps.ctx?.cwd)

      deps.onWorkUpdated?.({
        workId: saved.id,
        title: saved.title,
        docType: saved.type,
        content: saved.content,
        updatedAt: saved.updatedAt,
      })
      return { ok: true, text: `Updated "${saved.title}".` }
    }

    return { ok: false, text: `Unknown work tool: ${name}` }
  } catch (err: any) {
    log.error(`executeWorkTool(${name}) failed: ${String(err)}`)
    return { ok: false, text: `Work tool error: ${String(err?.message ?? err)}` }
  }
}

// ─── Shape 1: Claude SDK MCP server ───

function toToolResult(r: WorkToolResult) {
  return {
    content: [{ type: 'text' as const, text: r.text }],
    ...(r.ok ? {} : { isError: true as const }),
  }
}

export interface SolusMcpDeps {
  onWorkUpdated: OnWorkUpdated
  onWorkCreated: OnWorkCreated
  /** Fires when the agent calls render_artifact (see artifact-tools.ts). */
  onArtifact: ArtifactToolDeps['onArtifact']
  /** Fires when the agent creates or updates an automation, so the thread can
   *  render an automation card. */
  onAutomationSaved: OnAutomationSaved
  /** Fires when the agent spawns a new session via create_session, so the thread
   *  can render a card that opens it in a tab. */
  onSessionCreated: OnSessionCreated
  /** Origin context for create_work. `sessionId` is resolved lazily because a
   *  fresh session has no id until session_init, which lands before any tool runs. */
  createCtx: { agentProvider: AgentId; cwd: string; sessionId: () => string | undefined }
}

export function createSolusMcpServer(deps: SolusMcpDeps) {
  const createDeps = (): WorkToolDeps => ({
    onWorkUpdated: deps.onWorkUpdated,
    onWorkCreated: deps.onWorkCreated,
    ctx: {
      sessionId: deps.createCtx.sessionId(),
      agentProvider: deps.createCtx.agentProvider,
      cwd: deps.createCtx.cwd,
    },
  })
  return createSdkMcpServer({
    name: 'solus',
    version: '1.0.0',
    tools: [
      tool('list_works', LIST_DESC, listWorksShape, async () =>
        toToolResult(await executeWorkTool('list_works', {}, createDeps())),
      ),
      tool('read_work', READ_DESC, readWorkShape, async (args) =>
        toToolResult(await executeWorkTool('read_work', args as Record<string, unknown>, createDeps())),
      ),
      tool('create_work', CREATE_DESC, createWorkShape, async (args) =>
        toToolResult(await executeWorkTool('create_work', args as Record<string, unknown>, createDeps())),
      ),
      tool('update_work', UPDATE_DESC, updateWorkShape, async (args) =>
        toToolResult(await executeWorkTool('update_work', args as Record<string, unknown>, createDeps())),
      ),
      artifactTool({ onArtifact: deps.onArtifact }),
      reviewLedgerTool({
        cwd: deps.createCtx.cwd,
        sessionId: deps.createCtx.sessionId,
        now: () => new Date().toISOString(),
      }),
      ...automationSdkTools({
        agentProvider: deps.createCtx.agentProvider,
        cwd: deps.createCtx.cwd,
        sessionId: deps.createCtx.sessionId,
        onAutomationSaved: deps.onAutomationSaved,
      }),
      ...sessionSdkTools({
        agentProvider: deps.createCtx.agentProvider,
        cwd: deps.createCtx.cwd,
        sessionId: deps.createCtx.sessionId,
        onSessionCreated: deps.onSessionCreated,
      }),
      ...taskSdkTools({ cwd: deps.createCtx.cwd }),
    ],
  })
}

// ─── Shape 2: Codex dynamicTools JSON-schema descriptors ───

export interface WorkToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const WORK_TOOL_JSON_SCHEMAS: WorkToolDescriptor[] = [
  { name: 'list_works', description: LIST_DESC, inputSchema: z.toJSONSchema(z.object(listWorksShape)) as Record<string, unknown> },
  { name: 'read_work', description: READ_DESC, inputSchema: z.toJSONSchema(z.object(readWorkShape)) as Record<string, unknown> },
  { name: 'create_work', description: CREATE_DESC, inputSchema: z.toJSONSchema(z.object(createWorkShape)) as Record<string, unknown> },
  { name: 'update_work', description: UPDATE_DESC, inputSchema: z.toJSONSchema(z.object(updateWorkShape)) as Record<string, unknown> },
]

/** Tool names that mutate an existing work — these route through permissions on
 *  Codex. `create_work` is intentionally excluded (creation never prompts). */
export const WORK_MUTATING_TOOLS = new Set(['update_work'])
export const WORK_TOOL_NAMES = new Set(['list_works', 'read_work', 'create_work', 'update_work'])
