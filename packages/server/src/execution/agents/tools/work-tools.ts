import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { workRecord } from '@solus/contracts/solus-api/records'
import { SolusApiError } from '../../../admission/workspace-error'
import { formatExternalThreads, refreshWorkExternalComments } from '../../../data/works/work-comments'
import { z } from 'zod'
import { GOOGLE_WORK_READ_ONLY, WorkContentInvalidError, validateWorkContent } from '../../../data/works/work'
import { loadWorkAnnotations } from '../../../data/works/work-annotations'
import { formatOpenThreads } from '../../../annotations/comment-tools'
import { parseDiagram, serializeDiagram } from '@solus/contracts/diagram-types'
import { reapplyLayout } from '@solus/contracts/diagram-layout'
import { serializeDiagramEmbed } from '@solus/contracts/diagram-embed'
import { serializeWorkEmbed } from '@solus/contracts/work-embed'
import { mentionsAsText, restoreMentions } from '@solus/contracts/mentions'
import type { AgentId, WorkType } from '@solus/contracts/types'
import { createLogger } from '../../../logger'
import type { AgentTool } from './agent-tool'
import { ANY_ORGANIZATION } from '../../../admission/principal'
import { randomUUID } from 'node:crypto'
import {
  applyWorkOpToForeignTask,
  foreignLinkedItemFor,
  foreignLinkedItemsFor,
  foreignTaskIdFor,
} from '../../../data/tasks/foreign-tasks'
import { recordOutboxOp } from '../../../sync/outbox/outbox-store'

import type { WorkCreateOpPayload, WorkUpdateOpPayload } from '@solus/contracts/outbox-types'

const log = createLogger('folio', 'work-tools.ts')

/** Provider-neutral work tools. Invalid input returns error text so the agent
 * can recover from a bad call without terminating its run. */

export interface WorkUpdatedPayload {
  workId: string
  title: string
  docType: WorkType
  content: string
  updatedAt: string
}

export type OnWorkUpdated = (work: WorkUpdatedPayload) => void

export interface WorkCreatedPayload {
  workId: string
  title: string
  docType: WorkType
  content: string
}

export type OnWorkCreated = (work: WorkCreatedPayload) => void

/** Origin context for a newly created work (who/where it came from). */
export interface WorkCreateCtx {
  sessionId: string | undefined
  agentProvider: AgentId
  cwd: string
  /** Solus session id — keys the dispatched session's shipped task snapshot,
   *  whose linked works answer reads this host's own store cannot. */
  solusSessionId?: string
}

/** Side-effects + creation context threaded into the executor per call. */
export interface WorkToolDeps {
  onWorkUpdated?: OnWorkUpdated
  onWorkCreated?: OnWorkCreated
  ctx?: WorkCreateCtx
}

// ─── Schemas (raw zod shapes, reused by every shape we export) ───

const readWorkFields = {
  work_id: z.string().describe('The id of the work to read (from find_works).'),
}

const findWorksFields = {
  cursor: z.string().max(2048).optional().describe('Continue an open-work listing with its next cursor.'),
  query: z.string().optional().describe('Full-text query to match against work titles and content. Omit it to list every open work.'),
  type: z.enum(['doc', 'slides', 'diagram', 'artifact', 'any']).default('any').describe("Restrict a search to one kind of work. Defaults to 'any'; ignored when listing."),
  limit: z.number().int().min(1).max(20).default(10).describe('Maximum search results to return. Defaults to 10; ignored when listing.'),
}

const updateWorkFields = {
  work_id: z.string().describe('The id of the work to update (from find_works).'),
  content: z.string().describe('The full new content of the work. Replaces the existing content entirely.'),
  title: z.string().optional().describe('Optional new title for the work.'),
  expected_content_version: z.number().int().min(0).describe('The content_version that read_work returned for the content you revised. If the work changed since then, nothing is saved and you must call read_work again.'),
}

const createWorkFields = {
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
  'Before authoring or editing a diagram, load the `diagrams` skill — it owns the full node/edge contract, icons, data-model entities (typed fields + keys), relationship cardinality, groups, drill-down details, embedding workflow, and worked examples.',
].join('\n')

const FIND_DESC =
  "Find the user's works — documents, slide decks, architecture diagrams, HTML artifacts. Pass `query` to search titles AND content: reach for this WHENEVER the user refers to an artifact that already exists — 'that doc', 'the deck about X', 'the diagram we drew', 'update the spec' — rather than answering from memory. Omit `query` to list every work open in Solus with its id, title, type and last-updated time. Either way each result carries the work's id; take that id and call read_work to load the full content before you revise it with update_work."
const READ_DESC =
  'Read the full current content of a work by id, including any edits the user made manually, and its content_version. Always call this before update_work so you revise the latest version, and pass that content_version to update_work as expected_content_version.'
const CREATE_DESC = [
  'Create a NEW standalone artifact the user will keep, export, or hand off — a document, slide deck, or architecture diagram.',
  'The content streams into a card in the conversation as you write it. Use this only for brand-new works; to revise a work the user already has open, call read_work then update_work instead (never create a duplicate).',
  '',
  'Reach for this only for durable artifacts worth keeping — NOT for routine answers, reviews, analyses, comparisons, or plans, which belong inline in the conversation. When in doubt, answer inline. A work is never authored as a fenced code block in your reply; the content arg is the deliverable.',
  '',
  'When a durable document or plan needs an architecture, system, data-flow, or ER view, create the diagram work FIRST and embed the token this tool returns on its own line in the document. Do that only when relationships are central to understanding the content; prose is enough for routine plans.',
  'To embed an existing diagram or artifact, put this exact markdown link on a line of its own: [<title>](work://embed?workId=<work_id>&type=<diagram|artifact>). find_works and read_work print the ready-made token for each embeddable work; paste it rather than writing the URL by hand. A standalone work://embed link in existing content is a live embed — preserve it unless the user asks to remove or replace it. A fenced ```html block in a document is a live render too, and is likewise not stale text.',
  '',
  DIAGRAM_GUIDANCE,
].join('\n')
const UPDATE_DESC = [
  'Google-linked works are read-only in Solus. Edit in Google Docs and pull the latest content; local and shared comments remain available.',
  'Replace the content (and optionally the title) of an existing work by id. Use this to revise a document, diagram, or HTML artifact the user is looking at — never create a new work to revise one that already exists.',
  'The `content` arg takes the same payload shapes as create_work; see its description for the diagram contract. For an artifact, `content` is the full self-contained HTML document.',
  'Call read_work first so you revise the latest version, and carry forward any standalone work://embed link and any fenced ```html block already in the content — both are live renders, not stale text.',
  'Pass the content_version read_work returned as `expected_content_version`. If the user or another writer changed the work after your read, nothing is saved: call read_work again and apply your change to that content. On success the new content_version is returned.',
].join('\n')

// ─── Executor (shared by Codex handler + mock backend) ───

export interface WorkToolResult {
  ok: boolean
  text: string
}

interface WorkToolArgs {
  cursor?: string
  work_id?: string
  query?: string
  type?: WorkType | 'any'
  limit?: number
  title?: string
  doc_type?: 'doc' | 'slides' | 'diagram'
  content?: string
  expected_content_version?: number
}

export interface AgentWorkCreated {
  workId: string
  title: string
  /** Set when the work was recorded as an outbox op for a dispatched
   *  session's task host instead of landing in this host's store. */
  foreignTaskId: string | null
  /** Set when the work was created on the organization's Solus API, where the
   *  session's records live (organization-vms §3), instead of this host's store. */
  organizationOwned: boolean
}

/**
 * Persist a work the agent authored. On the task's own host it lands in the
 * folio store and links to the session's task. A dispatched session's work
 * belongs to its task's host, not this borrowed machine: it becomes an outbox
 * op the client couriers there, with an overlay so the agent's own reads see
 * it before delivery and the owner-side link brings it back with the next
 * snapshot re-ship. An organization session on an attached machine creates it
 * on the organization's Solus API, synchronously, which links it to the
 * session's task itself. Shared by `create_work` and `render_artifact`.
 */
export async function createAgentWork(
  title: string,
  docType: WorkType,
  content: string,
  ctx: WorkCreateCtx | undefined,
  /** File the work on the session's task. A document written for a task
   *  belongs on it; an artifact is a render the reader may not want on the
   *  ticket, so `render_artifact` passes false unless asked. A dispatched
   *  session's works are created on the task by construction either way. */
  linkToTask = true,
): Promise<AgentWorkCreated> {
  const foreignTaskId = foreignTaskIdFor(ctx?.solusSessionId)
  if (foreignTaskId) {
    const workId = randomUUID()
    const payload: WorkCreateOpPayload = {
      taskId: foreignTaskId,
      title,
      docType,
      content,
      agentProvider: ctx?.agentProvider ?? 'claude-code',
      originSessionId: ctx?.sessionId,
      cwd: ctx?.cwd,
    }
    const op = recordOutboxOp({ domain: 'works', resourceId: workId, name: 'create', payload, sessionId: ctx?.sessionId })
    applyWorkOpToForeignTask(ctx?.solusSessionId, op)
    return { workId, title, foreignTaskId, organizationOwned: false }
  }

  const { operations, context, remote } = await workspaceToolContext(ctx?.sessionId, ctx?.solusSessionId)
  if (context.actingAgent) context.actingAgent.linkWorkToTask = linkToTask
  // The Solus API files a work that names its session on that session's task; one the
  // reader did not ask to link names no session there, so it is not filed.
  const created = await operations.createWork(context, {
    title, type: docType, content, originSessionId: remote && !linkToTask ? undefined : context.actingAgent?.sessionId,
    agentProvider: ctx?.agentProvider, projectKey: ctx?.cwd,
  }, randomUUID())

  return { workId: created.id, title: created.title, foreignTaskId: null, organizationOwned: remote }
}

/** The ready-made embed token for a work that can be embedded, so an agent
 *  pastes it instead of writing the URL from memory — which is how a document
 *  ended up showing `work://embed?type=artifact&id=…` as text. */
function embedTokenNote(workId: string, title: string, type: WorkType): string {
  if (type !== 'diagram' && type !== 'artifact') return ''
  return ` — embed token: ${serializeWorkEmbed({ workId, title, type })}`
}

/** The typed answer to a write against a body the agent did not read. The
 * agent must read again; this tool never supplies a newer version for it. */
function staleWrite(title: string, expectedContentVersion: number): WorkToolResult {
  return {
    ok: false,
    text: `Stale write: "${title}" changed after you read it at content_version ${expectedContentVersion}. Nothing was saved. Call read_work again, apply your change to the current content, and pass its content_version as expected_content_version.`,
  }
}

export async function executeWorkTool(
  name: string,
  args: WorkToolArgs,
  deps: WorkToolDeps = {},
): Promise<WorkToolResult> {
  try {
    if (name === 'find_works') {
      const query = args.query?.trim() ?? ''
      // No query is the list: every open work, titles only. A query searches
      // content too, which is the only way to answer "that doc about X".
      if (!query) {
        const { operations, context } = await workspaceToolContext(deps.ctx?.sessionId, deps.ctx?.solusSessionId)
        const page = await operations.listWorks(context, { limit: 200, cursor: args.cursor })
        const works = page.items
        // A dispatched session's linked works live on the task's host; the
        // shipped copies are the only view of them this host has.
        const foreignWorks = foreignLinkedItemsFor(deps.ctx?.solusSessionId).filter((item) => item.kind === 'work')
        if (works.length === 0 && foreignWorks.length === 0) {
          return { ok: true, text: 'No works are currently open.' }
        }
        const lines = [
          ...works.map(
            (w) => `- ${w.id} — "${w.title}" (${w.type}), updated ${w.updatedAt}${embedTokenNote(w.id, w.title, w.type)}`,
          ),
          ...foreignWorks.map(
            (w) => `- ${w.key} — "${w.title}" (${w.workType}, shipped from the task's host, read-only), updated ${w.updatedAt ?? 'unknown'}`,
          ),
        ]
        return { ok: true, text: `Open works:\n${lines.join('\n')}${page.nextCursor ? '\nNext cursor: ' + page.nextCursor : ''}` }
      }

      const rawType = args.type ?? 'any'
      const type = rawType === 'any' ? undefined : rawType
      const limit = args.limit === undefined ? 10 : Math.min(20, Math.max(1, Math.floor(args.limit)))

      // Searched where the session's works live: this host's store, or its organization's Solus API.
      const { operations, context } = await workspaceToolContext(deps.ctx?.sessionId, deps.ctx?.solusSessionId)
      const hits = (await operations.searchWorks(context, { q: query, type, limit })).items
      if (!hits.length) return { ok: true, text: `No works match "${query}".` }
      const lines = hits.map(
        (hit) =>
          `- ${hit.id} — "${hit.title}" (${hit.type}), updated ${hit.updatedAt}${embedTokenNote(hit.id, hit.title, hit.type)}\n  ${hit.snippet}`,
      )
      const nextStep = '→ To read any result in full, call read_work with its id.'
      return { ok: true, text: `Works matching "${query}":\n${lines.join('\n')}\n\n${nextStep}` }
    }

    if (name === 'read_work') {
      const workId = String(args.work_id ?? '')
      if (!workId) return { ok: false, text: 'read_work requires a work_id.' }
      const { operations, context, remote } = await workspaceToolContext(deps.ctx?.sessionId, deps.ctx?.solusSessionId)
      const loaded = await operations.getWork(context, workId).catch(error => {
        if (error instanceof SolusApiError && error.status === 404) return null
        throw error
      })
      const work = loaded ? workRecord(loaded) : null
      if (!work) {
        const foreign = foreignLinkedItemFor(deps.ctx?.solusSessionId, 'work', workId)
        if (foreign) {
          return {
            ok: true,
            text: `Work "${foreign.title}" (${foreign.workType}, id: ${foreign.key}, content_version: ${foreign.contentVersion}) — a read-only copy shipped from the task's host; update_work cannot change it from here:\n\n${foreign.content}`,
          }
        }
        return { ok: false, text: `No work found with id "${workId}".` }
      }
      // An organization's work: its content from the Solus API; its comment threads are on its page there.
      // A mention reads as `@Name`: an agent reads people, it does not write mentions (plan 004 item 13).
      if (remote) return { ok: true, text: mentionsAsText(`Work "${work.title}" (${work.type}, id: ${work.id}, content_version: ${work.contentVersion})${embedTokenNote(work.id, work.title, work.type)}:\n\n${work.content}`) }
      // Surface the open threads alongside the content so the agent sees
      // feedback without the user having to paste it into chat. Rendered by the
      // same formatter as read_plan, so both read identically.
      if (work.mirroredDoc) await refreshWorkExternalComments(ANY_ORGANIZATION, workId)
      const annotations = await loadWorkAnnotations(ANY_ORGANIZATION, workId)
      return {
        ok: true,
        text: mentionsAsText(`Work "${work.title}" (${work.type}, id: ${work.id}, content_version: ${work.contentVersion})${embedTokenNote(work.id, work.title, work.type)}${work.mirroredDoc?.provider === 'gdrive' ? `\n${GOOGLE_WORK_READ_ONLY}` : ''}:\n\n${work.content}${formatOpenThreads(annotations?.comments ?? [])}${formatExternalThreads(work.mirroredDoc?.provider === annotations?.externalComments?.provider && work.mirroredDoc?.externalId === annotations?.externalComments?.documentId && work.mirroredDoc?.externalKey === annotations?.externalComments?.externalKey ? annotations?.externalComments : undefined, work.mirroredDoc?.url)}`),
      }
    }

    if (name === 'create_work') {
      const title = args.title?.trim() ? args.title : 'Untitled'
      const rawType = args.doc_type ?? 'doc'
      const docType: 'doc' | 'slides' | 'diagram' =
        rawType === 'slides' || rawType === 'diagram' ? rawType : 'doc'
      let content = args.content ?? ''
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

      const created = await createAgentWork(title, docType, content, deps.ctx)
      deps.onWorkCreated?.({ workId: created.workId, title: created.title, docType, content })
      const embedGuidance = docType === 'diagram'
        ? `\n\nTo embed this diagram in a Solus document or plan, place this token on its own line:\n\n${serializeDiagramEmbed({ workId: created.workId, title: created.title })}`
        : ''
      const syncNote = created.foreignTaskId
        ? ` It syncs to the task's host and links to task ${created.foreignTaskId}.`
        : created.organizationOwned
          ? ' It is saved in the organization\'s Solus API.'
          : ''
      return { ok: true, text: `Created "${created.title}" (id: ${created.workId}).${syncNote}${embedGuidance}` }
    }

    if (name === 'update_work') {
      const workId = String(args.work_id ?? '')
      if (!workId) return { ok: false, text: 'update_work requires a work_id.' }
      const content = args.content ?? ''
      if (!content.trim()) return { ok: false, text: 'update_work requires non-empty content.' }
      const title = args.title
      const expectedContentVersion = args.expected_content_version
      if (expectedContentVersion === undefined) return { ok: false, text: 'update_work requires expected_content_version: the content_version read_work returned.' }

      const { operations, context } = await workspaceToolContext(deps.ctx?.sessionId, deps.ctx?.solusSessionId)
      const current = await operations.getWork(context, workId).catch(error => {
        if (error instanceof SolusApiError && error.status === 404) return null
        throw error
      })
      const existing = current ? workRecord(current) : null
      if (!existing) {
        // A shipped (or op-created) work on a dispatched session: the row
        // lives on the task's host, so the update travels as an outbox op.
        const foreign = foreignLinkedItemFor(deps.ctx?.solusSessionId, 'work', workId)
        const foreignTaskId = foreignTaskIdFor(deps.ctx?.solusSessionId)
        if (foreign && foreignTaskId) {
          // The owner validates again; refusing here saves a dead-lettered op.
          try {
            validateWorkContent(foreign.workType, content)
          } catch (err) {
            if (err instanceof WorkContentInvalidError) return { ok: false, text: err.message }
            throw err
          }
          if (foreign.contentVersion !== expectedContentVersion) return staleWrite(foreign.title, expectedContentVersion)
          const payload: WorkUpdateOpPayload = {
            taskId: foreignTaskId,
            content,
            expectedContentVersion,
          }
          if (title !== undefined) payload.title = title
          const op = recordOutboxOp({ domain: 'works', resourceId: workId, name: 'update', payload, sessionId: deps.ctx?.sessionId })
          applyWorkOpToForeignTask(deps.ctx?.solusSessionId, op)
          deps.onWorkUpdated?.({
            workId,
            title: title ?? foreign.title,
            docType: foreign.workType,
            content,
            updatedAt: new Date().toISOString(),
          })
          return { ok: true, text: `Updated "${title ?? foreign.title}"${foreign.workType === 'artifact' ? ` (artifact, id: ${workId})` : ''}. New content_version: ${foreign.contentVersion}. The change syncs to the task's host.` }
        }
        return { ok: false, text: `No work found with id "${workId}".` }
      }

      // The agent read each mention as `@Name` (read_work); it gets its person back.
      // The record version is fetched now, for If-Match; the content version is
      // the agent's own, and both are checked in the save's transaction. The
      // work's host validates the body (a diagram must parse).
      let saved
      try {
        saved = await operations.updateWork(context, workId, { content: restoreMentions(content, existing.content), title, expectedContentVersion }, existing.updatedAt)
      } catch (error) {
        if (error instanceof SolusApiError && error.code === 'STALE_VERSION') return staleWrite(existing.title, expectedContentVersion)
        if (error instanceof SolusApiError && error.code === 'INVALID_REQUEST') return { ok: false, text: error.message }
        throw error
      }

      deps.onWorkUpdated?.({
        workId: saved.id,
        title: saved.title,
        docType: saved.type,
        content: saved.content,
        updatedAt: saved.updatedAt,
      })
      // The result text starts as it always has: transcripts project the artifact id from it.
      return { ok: true, text: `Updated "${saved.title}"${saved.type === 'artifact' ? ` (artifact, id: ${saved.id})` : ''}. New content_version: ${saved.contentVersion}.` }
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
  inputFields: AgentTool['inputFields'],
  requiresApproval: boolean,
  alwaysLoad = false,
): AgentTool {
  return {
    name,
    description,
    inputFields,
    requiresApproval,
    alwaysLoad,
    execute: async (args, context) => executeWorkTool(name, args, {
      ctx: {
        sessionId: context.sessionId(),
        agentProvider: context.provider,
        cwd: context.cwd,
        solusSessionId: context.solusSessionId(),
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
        toolId: context.parentToolUseId(),
        workId: work.workId,
        title: work.title,
        docType: work.docType,
        content: work.content,
        updatedAt: work.updatedAt,
      }),
    }),
  }
}

export const findWorksAgentTool = workAgentTool('find_works', FIND_DESC, findWorksFields, false)
export const readWorkAgentTool = workAgentTool('read_work', READ_DESC, readWorkFields, false)
// Both descriptions carry rules the agent needs before it decides to call
// anything: when a work is the wrong shape, and that an embed line or an html
// fence in existing content is a live render. Kept in every prompt.
export const createWorkAgentTool = workAgentTool('create_work', CREATE_DESC, createWorkFields, false, true)
export const updateWorkAgentTool = workAgentTool('update_work', UPDATE_DESC, updateWorkFields, true, true)

export const workAgentTools: AgentTool[] = [
  findWorksAgentTool,
  readWorkAgentTool,
  createWorkAgentTool,
  updateWorkAgentTool,
]
