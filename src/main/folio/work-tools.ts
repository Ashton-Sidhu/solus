import { z } from 'zod'
import { listWorks, loadWork, agentSaveWork, createWork } from './works'
import { searchWorks } from './work-search'
import { loadWorkAnnotations } from './work-annotations'
import { workPreview } from '../../shared/work-preview'
import { parseDiagram, serializeDiagram } from '../../shared/diagram-types'
import { reapplyLayout } from '../../shared/diagram-layout'
import type { AgentId } from '../../shared/types'
import { createLogger } from '../logger'
import type { AgentTool } from '../agents/tools/agent-tool'

const log = createLogger('folio', 'work-tools.ts')

/** Provider-neutral work tools. Invalid input returns error text so the agent
 * can recover from a bad call without terminating its run. */

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

const searchWorksShape = {
  query: z.string().describe('Full-text query to match against work titles and content.'),
  type: z.enum(['doc', 'slides', 'diagram', 'any']).default('any').describe("Restrict to one kind of work. Defaults to 'any'."),
  limit: z.number().int().min(1).max(20).default(10).describe('Maximum results to return. Defaults to 10.'),
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
  'List the works (documents, slide decks, architecture diagrams) the user has open in Solus, with their id, title, type and last-updated time. Call this first to discover a work_id before reading or updating.'
const SEARCH_DESC =
  "Full-text search over the user's works (documents, slide decks, diagrams) by title AND content. Reach for this WHENEVER the user refers to an artifact that already exists — 'that doc', 'the deck about X', 'the diagram we drew', 'update the spec' — instead of guessing from list_works titles, which carry no content. Put the topic in `query`. Each result carries the work's id; take that id and call read_work to load the full content before you revise it with update_work."
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
  'The `content` arg takes the same payload shapes as create_work; see its description for the diagram contract.',
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

    if (name === 'search_works') {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) return { ok: false, text: 'search_works requires a non-empty query.' }
      const rawType = String(args.type ?? 'any')
      const type = rawType === 'doc' || rawType === 'slides' || rawType === 'diagram' ? rawType : undefined
      const limit = typeof args.limit === 'number' ? Math.min(20, Math.max(1, Math.floor(args.limit))) : 10

      const hits = await searchWorks(query, { type, cwd: deps.ctx?.cwd, limit })
      if (!hits.length) return { ok: true, text: `No works match "${query}".` }
      const lines = hits.map(
        (hit) =>
          `- ${hit.id} — "${hit.title}" (${hit.type}, ${hit.storage}), cwd ${hit.cwd}, updated ${hit.updatedAt}\n  ${hit.snippet}`,
      )
      const nextStep = '→ To read any result in full, call read_work with its id.'
      return { ok: true, text: `Works matching "${query}":\n${lines.join('\n')}\n\n${nextStep}` }
    }

    if (name === 'read_work') {
      const workId = String(args.work_id ?? '')
      if (!workId) return { ok: false, text: 'read_work requires a work_id.' }
      const work = await loadWork(workId, deps.ctx?.cwd)
      if (!work) return { ok: false, text: `No work found with id "${workId}".` }
      // Surface the user's open threads alongside the content so the agent sees
      // feedback without the user having to paste it into chat. Diagram
      // comments carry the anchored node id; use it to target the revision.
      // Resolved threads are left out — they have already been dealt with, and
      // re-serving them reads as a fresh request.
      const annotations = await loadWorkAnnotations(workId)
      let commentsBlock = ''
      const openComments = (annotations?.comments ?? []).filter((c) => !c.resolvedAt)
      if (openComments.length) {
        const lines = openComments.map((c) => {
          const head = c.nodeId
            ? `- On node "${c.selectedText}" (node id: ${c.nodeId}): ${c.comment}`
            : `- On "${c.selectedText}": ${c.comment}`
          const replies = (c.replies ?? []).map(
            (r) => `  - ${r.author === 'solus' ? 'Solus' : 'User'}: ${r.text}`,
          )
          return [head, ...replies].join('\n')
        })
        commentsBlock = `\n\nOpen user threads on this work (${lines.length}) — address them when revising:\n${lines.join('\n')}`
      }
      return {
        ok: true,
        text: `Work "${work.title}" (${work.type}, id: ${work.id}):\n\n${work.content}${commentsBlock}`,
      }
    }

    if (name === 'create_work') {
      const title = typeof args.title === 'string' && args.title.trim() ? args.title : 'Untitled'
      const rawType = String(args.doc_type ?? 'doc')
      const docType: 'doc' | 'slides' | 'diagram' =
        rawType === 'slides' || rawType === 'diagram' ? rawType : 'doc'
      let content = typeof args.content === 'string' ? args.content : ''
      if (!content.trim()) return { ok: false, text: 'create_work requires non-empty content.' }

      if (docType === 'diagram') {
        try {
          // A new agent-authored diagram has no user placement to preserve.
          // Always replace supplied/default geometry with the same clean LR
          // layout as the canvas Auto-layout action before persisting it.
          content = serializeDiagram(reapplyLayout(parseDiagram(content)))
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

      // Same guard as create_work: a malformed diagram update would otherwise
      // overwrite good content and render as a silently blank canvas.
      if (existing.type === 'diagram') {
        try {
          parseDiagram(content)
        } catch (err: any) {
          return {
            ok: false,
            text: `Invalid diagram content: ${String(err?.message ?? err)}. The content must be JSON shaped like {"nodes":[...],"edges":[...]}.`,
          }
        }
      }

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
    log.error('work_tool_failed', { tool: name, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, text: `Work tool error: ${String(err?.message ?? err)}` }
  }
}

function workAgentTool(
  name: string,
  description: string,
  inputShape: z.ZodRawShape,
  requiresApproval: boolean,
): AgentTool {
  return {
    name,
    description,
    inputShape,
    requiresApproval,
    execute: async (args, context) => executeWorkTool(name, args, {
      ctx: {
        sessionId: context.sessionId(),
        agentProvider: context.provider,
        cwd: context.cwd,
      },
      onWorkCreated: (work) => context.emit({
        type: 'work_created',
        workId: work.workId,
        title: work.title,
        docType: work.docType,
        content: work.content,
      }),
      onWorkUpdated: (work) => context.emit({
        type: 'work_updated',
        workId: work.workId,
        title: work.title,
        docType: work.docType,
        content: work.content,
        updatedAt: work.updatedAt,
      }),
    }),
  }
}

export const listWorksAgentTool = workAgentTool('list_works', LIST_DESC, listWorksShape, false)
export const searchWorksAgentTool = workAgentTool('search_works', SEARCH_DESC, searchWorksShape, false)
export const readWorkAgentTool = workAgentTool('read_work', READ_DESC, readWorkShape, false)
export const createWorkAgentTool = workAgentTool('create_work', CREATE_DESC, createWorkShape, false)
export const updateWorkAgentTool = workAgentTool('update_work', UPDATE_DESC, updateWorkShape, true)

export const workAgentTools: AgentTool[] = [
  listWorksAgentTool,
  searchWorksAgentTool,
  readWorkAgentTool,
  createWorkAgentTool,
  updateWorkAgentTool,
]
