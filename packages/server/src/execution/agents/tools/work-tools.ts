import { workspaceToolContext } from '../../../data/workspace/tool-context'
import { workRecord } from '@solus/contracts/solus-api/records'
import { SolusApiError } from '../../../admission/workspace-error'
import { formatExternalThreads, refreshWorkExternalComments } from '../../../data/works/work-comments'
import { z } from 'zod'
import { GOOGLE_WORK_READ_ONLY } from '../../../data/works/work'
import { loadWorkAnnotations } from '../../../data/works/work-annotations'
import { formatOpenThreads } from '../../../annotations/comment-tools'
import { serializeWorkEmbed } from '@solus/contracts/work-embed'
import { mentionsAsText, restoreMentions } from '@solus/contracts/mentions'
import type { AgentId, WorkType } from '@solus/contracts/types'
import type { WorkspaceRecordHome } from '@solus/contracts/solus-api'
import { createLogger } from '../../../logger'
import type { AgentTool } from './agent-tool'
import { readWorkFile } from './work-file'
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

/** The organization whose Solus API holds the work; null when it is on this host. */
type WorkOwner = { organizationId: string | null }

function organizationOf(home: WorkspaceRecordHome): string | null {
  return home.kind === 'organization' ? home.organizationId : null
}

export interface WorkUpdatedPayload extends WorkOwner {
  contentVersion: number
  workId: string
  title: string
  docType: WorkType
  content: string
  updatedAt: string
}

export type OnWorkUpdated = (work: WorkUpdatedPayload) => void

export interface WorkCreatedPayload extends WorkOwner {
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
  type: z.enum(['doc', 'slides', 'artifact', 'any']).default('any').describe("Restrict a search to one kind of work. Defaults to 'any'; ignored when listing."),
  limit: z.number().int().min(1).default(10).describe('Maximum search results to return. Defaults to 10, at most 20 (larger values return 20); ignored when listing.'),
}

const markdownPathField = z.string().optional().describe('Path to a .md file on this host to use as the content, relative to your working directory.')

const updateWorkFields = {
  work_id: z.string().describe('The id of the work to update (from find_works).'),
  content: z.string().optional().describe('The full new content. Replaces the existing content.'),
  markdown_path: markdownPathField,
  html_path: z.string().optional().describe('Artifacts only: path to an .html file on this host, such as the visual-artifacts bundle.html, relative to your working directory.'),
  title: z.string().optional().describe('Optional new title for the work.'),
  expected_content_version: z.number().int().min(0).describe('The content_version read_work returned.'),
}

const createWorkFields = {
  title: z.string().describe('A short, human-readable title for the work.'),
  doc_type: z.enum(['doc', 'slides']).describe(
    "The kind of work: 'doc' (markdown document) or 'slides' (slide deck).",
  ),
  content: z.string().optional().describe('The full content as markdown. Pass this or markdown_path.'),
  markdown_path: markdownPathField,
}

const FIND_DESC =
  "Find the user's works — documents, slide decks, HTML artifacts. Pass `query` to search titles AND content: reach for this WHENEVER the user refers to an artifact that already exists — 'that doc', 'the deck about X', 'the diagram we drew', 'update the spec' — rather than answering from memory. Omit `query` to list every work open in Solus with its id, title, type and last-updated time. Either way each result carries the work's id; take that id and call read_work to load the full content before you revise it with update_work."
const READ_DESC =
  'Read the full current content of a work by id, including any edits the user made manually, and its content_version. Always call this before update_work so you revise the latest version, and pass that content_version to update_work as expected_content_version.'
const CREATE_DESC = [
  'Create a NEW durable document or slide deck the user will keep, export, or hand off. It streams into a card in the conversation.',
  'Not for routine answers, reviews, analyses, comparisons, or plans: those go inline in your reply. When in doubt, answer inline. Never write a work as a fenced code block in your reply. To revise an existing work, call read_work then update_work; never create a duplicate.',
  'Pass the markdown as content or, for a file you already wrote, its path as markdown_path, so the text does not pass through your output.',
  'For an architecture, system, data-flow, or ER view, call render_artifact and embed the token it returns. To embed an artifact, put the token find_works or read_work prints on its own line: [<title>](work://embed?workId=<work_id>&type=artifact). A standalone work://embed link or a ```html fence in existing content is a live render: keep it unless the user asks to remove it.',
].join('\n')
const UPDATE_DESC = [
  'Replace the content, and optionally the title, of an existing work by id. Call read_work first and pass its content_version as expected_content_version; if the work changed since, nothing is saved and you must read it again.',
  'Pass the new body as one of: content (markdown, or the full HTML of an artifact), markdown_path (a .md file, for a document or deck), or html_path (an .html file, for an artifact).',
  'Keep every standalone work://embed link and ```html fence already in the content: they are live renders.',
  'Google-linked works are read-only: edit them in Google Docs and pull the latest content.',
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
  doc_type?: 'doc' | 'slides'
  content?: string
  html_path?: string
  markdown_path?: string
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
  organizationId: string | null
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
   *  ticket, so `render_artifact` passes false. A dispatched
   *  session's works are created on the task by construction either way. */
  linkToTask = true,
): Promise<AgentWorkCreated> {
  const foreignTaskId = foreignTaskIdFor(ctx?.sessionId)
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
    applyWorkOpToForeignTask(ctx?.sessionId, op)
    return { workId, title, foreignTaskId, organizationId: null }
  }

  const { operations, context } = await workspaceToolContext(ctx?.sessionId)
  if (context.actingAgent) context.actingAgent.linkWorkToTask = linkToTask
  // Keep the originating session on every saved work, including artifacts.
  const created = await operations.createWork(context, {
    title, type: docType, content, originSessionId: context.actingAgent?.sessionId,
    agentProvider: ctx?.agentProvider, projectKey: ctx?.cwd,
  }, randomUUID())

  return { workId: created.id, title: created.title, foreignTaskId: null, organizationId: organizationOf(context.home) }
}

/** The ready-made embed token for a work that can be embedded, so an agent
 *  pastes it instead of writing the URL from memory — which is how a document
 *  ended up showing `work://embed?type=artifact&id=…` as text. */
function embedTokenNote(workId: string, title: string, type: WorkType): string {
  if (type !== 'artifact') return ''
  return ` — embed token: ${serializeWorkEmbed({ workId, title, type })}`
}

/** The typed answer to a write against a body the agent did not read. The
 * agent must read again; this tool never supplies a newer version for it. */
function htmlPathNotArtifact(title: string): WorkToolResult {
  return { ok: false, text: `html_path is for artifacts only. "${title}" is not an artifact; pass its content instead. Nothing was saved.` }
}

function markdownPathOnArtifact(title: string): WorkToolResult {
  return { ok: false, text: `markdown_path is for documents and decks. "${title}" is an artifact; pass html_path or its HTML as content. Nothing was saved.` }
}

/** The body a create or update call names: inline `content`, or the file one
 *  path input names, read on this host so it does not pass through the model. */
async function workBody(tool: string, args: WorkToolArgs, cwd: string): Promise<{ content: string } | WorkToolResult> {
  const sources = [args.content, args.markdown_path, args.html_path].filter((source) => source !== undefined)
  if (sources.length > 1) return { ok: false, text: `${tool} takes one of content, markdown_path, or html_path.` }
  const input = args.markdown_path !== undefined ? 'markdown_path' : args.html_path !== undefined ? 'html_path' : null
  if (!input) return { content: args.content ?? '' }
  const read = await readWorkFile(input, args[input] ?? '', cwd)
  if ('error' in read) return { ok: false, text: `${tool} error: ${read.error}` }
  return { content: read.body }
}

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
        const { operations, context } = await workspaceToolContext(deps.ctx?.sessionId)
        const page = await operations.listWorks(context, { limit: 200, cursor: args.cursor })
        const works = page.items
        // A dispatched session's linked works live on the task's host; the
        // shipped copies are the only view of them this host has.
        const foreignWorks = foreignLinkedItemsFor(deps.ctx?.sessionId).filter((item) => item.kind === 'work')
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
      const { operations, context } = await workspaceToolContext(deps.ctx?.sessionId)
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
      const { operations, context, remote } = await workspaceToolContext(deps.ctx?.sessionId)
      const loaded = await operations.getWork(context, workId).catch(error => {
        if (error instanceof SolusApiError && error.status === 404 && error.code !== 'MOVED') return null
        throw error
      })
      const work = loaded ? workRecord(loaded) : null
      if (!work) {
        const foreign = foreignLinkedItemFor(deps.ctx?.sessionId, 'work', workId)
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
      const docType = args.doc_type === 'slides' ? 'slides' : 'doc'
      if (args.html_path !== undefined) return { ok: false, text: 'create_work makes documents and decks; call render_artifact for an HTML file.' }
      const body = await workBody('create_work', args, deps.ctx?.cwd ?? '~')
      if (!('content' in body)) return body
      const { content } = body
      if (!content.trim()) return { ok: false, text: 'create_work requires non-empty content or a markdown_path.' }

      const created = await createAgentWork(title, docType, content, deps.ctx)
      deps.onWorkCreated?.({ workId: created.workId, title: created.title, docType, content, organizationId: created.organizationId })
      const syncNote = created.foreignTaskId
        ? ` It syncs to the task's host and links to task ${created.foreignTaskId}.`
        : created.organizationId
          ? ' It is saved in the organization\'s Solus API.'
          : ''
      return { ok: true, text: `Created "${created.title}" (id: ${created.workId}).${syncNote}` }
    }

    if (name === 'update_work') {
      const workId = String(args.work_id ?? '')
      if (!workId) return { ok: false, text: 'update_work requires a work_id.' }
      const body = await workBody('update_work', args, deps.ctx?.cwd ?? '~')
      if (!('content' in body)) return body
      const { content } = body
      if (!content.trim()) return { ok: false, text: 'update_work requires non-empty content, a markdown_path, or an html_path.' }
      const title = args.title
      const expectedContentVersion = args.expected_content_version
      if (expectedContentVersion === undefined) return { ok: false, text: 'update_work requires expected_content_version: the content_version read_work returned.' }

      const { operations, context } = await workspaceToolContext(deps.ctx?.sessionId)
      const current = await operations.getWork(context, workId).catch(error => {
        if (error instanceof SolusApiError && error.status === 404 && error.code !== 'MOVED') return null
        throw error
      })
      const existing = current ? workRecord(current) : null
      if (!existing) {
        // A shipped (or op-created) work on a dispatched session: the row
        // lives on the task's host, so the update travels as an outbox op.
        const foreign = foreignLinkedItemFor(deps.ctx?.sessionId, 'work', workId)
        const foreignTaskId = foreignTaskIdFor(deps.ctx?.sessionId)
        if (foreign && foreignTaskId) {
          if (args.html_path && foreign.workType !== 'artifact') return htmlPathNotArtifact(foreign.title)
          if (args.markdown_path && foreign.workType === 'artifact') return markdownPathOnArtifact(foreign.title)
          if (foreign.contentVersion !== expectedContentVersion) return staleWrite(foreign.title, expectedContentVersion)
          const payload: WorkUpdateOpPayload = {
            taskId: foreignTaskId,
            content,
            expectedContentVersion,
          }
          if (title !== undefined) payload.title = title
          const op = recordOutboxOp({ domain: 'works', resourceId: workId, name: 'update', payload, sessionId: deps.ctx?.sessionId })
          applyWorkOpToForeignTask(deps.ctx?.sessionId, op)
          deps.onWorkUpdated?.({
            workId,
            title: title ?? foreign.title,
            docType: foreign.workType,
            content,
            updatedAt: new Date().toISOString(),
            contentVersion: foreign.contentVersion,
            organizationId: null,
          })
          return { ok: true, text: `Updated "${title ?? foreign.title}"${foreign.workType === 'artifact' ? ` (artifact, id: ${workId})` : ''}. New content_version: ${foreign.contentVersion}. The change syncs to the task's host.` }
        }
        return { ok: false, text: `No work found with id "${workId}".` }
      }

      // The agent read each mention as `@Name` (read_work); it gets its person back.
      // The record version is fetched now, for If-Match; the content version is
      // the agent's own, and both are checked in the save's transaction.
      if (args.html_path && existing.type !== 'artifact') return htmlPathNotArtifact(existing.title)
      if (args.markdown_path && existing.type === 'artifact') return markdownPathOnArtifact(existing.title)
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
        contentVersion: saved.contentVersion,
        organizationId: organizationOf(context.home),
      })
      // The result text starts as it always has: transcripts project the artifact id from it.
      return { ok: true, text: `Updated "${saved.title}"${saved.type === 'artifact' ? ` (artifact, id: ${saved.id})` : ''}. New content_version: ${saved.contentVersion}.` }
    }

    return { ok: false, text: `Unknown work tool: ${name}` }
  } catch (err: any) {
    // Share moved the work to an organization (cloud-sharing.md §3a): say where, not "not found".
    if (err instanceof SolusApiError && err.code === 'MOVED') {
      return { ok: false, text: `${err.message} Share moved it there, so this host no longer has it, and ${name} cannot read or change it from this session.` }
    }
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
      },
      onWorkCreated: (work) => context.emit({
        type: 'work_created',
        workId: work.workId,
        title: work.title,
        docType: work.docType,
        content: work.content,
        organizationId: work.organizationId,
      }),
      onWorkUpdated: (work) => context.emit({
        type: 'work_updated',
        toolId: context.parentToolUseId(),
        workId: work.workId,
        title: work.title,
        docType: work.docType,
        content: work.content,
        updatedAt: work.updatedAt,
        contentVersion: work.contentVersion,
        organizationId: work.organizationId,
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
