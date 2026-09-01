import type { AgentId, AutomationTrigger, IpcContext, NormalizedEvent, PermissionRequest, QueuedPromptSnapshot, QuestionRequest, Session } from '../../shared/types'
import { encodePathAsFolder } from '../../shared/types'
import type { SessionLoadMessage } from '../../shared/session-history'
import { uuid } from '../../shared/uuid'
import { nextMsgId, progressFromMessages, toPermissionRequest, toQuestionRequest } from './session.utils'
import type { WorkspaceContext } from './workspace.context.svelte'

// ─── Transcript loader ───

/** Matches both Claude (`mcp__solus__create_work`) and Codex (`create_work`). */
function isCreateWorkTool(name: string | undefined): boolean {
  return !!name && name.endsWith('create_work')
}

/** Matches both Claude (`mcp__solus__render_artifact`) and Codex (`render_artifact`). */
function isRenderArtifactTool(name: string | undefined): boolean {
  return !!name && name.endsWith('render_artifact')
}

function isCodexImageGenerationTool(name: string | undefined): boolean {
  return name === 'ImageGeneration'
}

/** Matches create_automation/update_automation for both Claude (mcp__solus__*)
 *  and Codex (bare name). */
function isAutomationSaveTool(name: string | undefined): boolean {
  return !!name && (name.endsWith('create_automation') || name.endsWith('update_automation'))
}

/**
 * Resolve the automation a historical create/update call targeted so its card
 * can re-render. update carries the exact `automation_id`; create only has the
 * name, so we match by name (skipping ids already claimed this pass). Returns
 * undefined if nothing matches (the automation was since deleted) — the card is
 * then skipped, leaving just the tool row.
 */
function resolveSavedAutomation(
  ctx: WorkspaceContext,
  input: { automation_id?: string; name?: string },
  claimed: Set<string>,
): { automationId: string; name: string; trigger: AutomationTrigger; enabled: boolean } | undefined {
  const items = ctx.automationsStore.items
  let found = input.automation_id ? items.find((a) => a.id === input.automation_id) : undefined
  if (!found && input.name) found = items.find((a) => a.name === input.name && !claimed.has(a.id))
  if (!found) return undefined
  claimed.add(found.id)
  return { automationId: found.id, name: found.name, trigger: found.trigger, enabled: found.enabled }
}

function automationIdFromResult(text: string | undefined): string | undefined {
  const match = text?.match(/\(id:\s*([0-9a-f-]{36})\)/i)
  return match?.[1]
}

function toolResultTextFor(history: SessionLoadMessage[], toolId: string | undefined): string | undefined {
  if (!toolId) return undefined
  return history.find((m) => m.role === 'tool_result' && m.toolResultForId === toolId)?.content
}

/**
 * Resolve the persisted work for a historical create_work call. The tool result
 * carrying the real id is dropped during history parsing, so we correlate by
 * title among works this session collaborated on, skipping ids already claimed
 * earlier in the same transcript pass. Returns '' if nothing matches (the card
 * still renders its title, just without a load target).
 */
function resolveCreatedWork(ctx: WorkspaceContext, title: string, sessionId: string, claimed: Set<string>): string {
  const works = Object.values(ctx.worksStore.works)
  const bySessionAndTitle = works.find(
    (w) => w.title === title && !claimed.has(w.id) && (w.sessionIds?.includes(sessionId) || w.sessionId === sessionId),
  )
  if (bySessionAndTitle) { claimed.add(bySessionAndTitle.id); return bySessionAndTitle.id }
  const byTitle = works.find((w) => w.title === title && !claimed.has(w.id))
  if (byTitle) { claimed.add(byTitle.id); return byTitle.id }
  return ''
}

export async function loadSessionTranscript(ctx: WorkspaceContext, args: {
  sessionId: string
  loadPath: string
  displayCwd: string
  provider: AgentId
  ctx: IpcContext
  /** Hydrate only the most recent `limit` messages for a fast initial paint. */
  limit?: number
  shouldApply?: () => boolean
}): Promise<{ messages: any[]; planIds: string[]; progress: any; truncated: boolean }> {
  const history = await window.solus.loadSession(args.sessionId, args.loadPath, args.ctx, args.provider, args.limit)
  // A full window of messages means older ones were left on disk.
  const truncated = !!args.limit && history.length >= args.limit
  if (args.shouldApply && !args.shouldApply()) {
    return { messages: [], planIds: [], progress: null, truncated: false }
  }

  const projectPath = encodePathAsFolder(args.displayCwd)
  const planIds: string[] = []
  const messages: any[] = []
  // Work ids already mapped to a card this pass, so repeated titles across
  // multiple create_work calls don't all resolve to the same work.
  const claimedWorks = new Set<string>()
  const claimedAutomations = new Set<string>()
  // Tool messages by tool_use id (main thread + nested) so sub-agent children
  // and the Agent tool's own result can be reattached to their tool message.
  const toolById = new Map<string, any>()

  // Automation cards resolve against the store; ensure it's hydrated if this
  // transcript created/updated any automations.
  if ((history as SessionLoadMessage[]).some((m) => m.role === 'tool' && isAutomationSaveTool(m.toolName)) && !ctx.automationsStore.loaded) {
    await ctx.automationsStore.loadAll()
  }

  const loadedHistory = history as SessionLoadMessage[]
  for (const m of loadedHistory) {
    if (m.role === 'tool_result') {
      // Land the result on its tool message — the Agent tool's own result flips
      // its card to done; an inner tool's result lands in subMessages. Never a
      // flat user/system bubble, so reloads don't re-leak sub-agent output.
      const target = m.toolResultForId ? toolById.get(m.toolResultForId) : undefined
      if (target) {
        target.toolResult = m.content
        target.toolResultIsError = false
        target.toolStatus = 'completed'
      }
      continue
    }

    // Sub-agent activity reconstructs into the spawning tool's nested transcript,
    // mirroring the live reducer — never the flat thread.
    if (m.parentToolUseId) {
      const parent = toolById.get(m.parentToolUseId)
      if (parent) {
        if (!parent.subMessages) parent.subMessages = []
        if (m.role === 'tool' && m.toolName) {
          const child = {
            id: nextMsgId(),
            role: 'tool' as const,
            content: m.content,
            toolName: m.toolName,
            toolId: m.toolId,
            toolInput: m.toolInput,
            toolStatus: 'completed' as const,
            timestamp: m.timestamp ?? Date.now(),
          }
          parent.subMessages.push(child)
          if (m.toolId) toolById.set(m.toolId, child)
        } else if (m.role === 'assistant' && m.content) {
          parent.subMessages.push({
            id: nextMsgId(),
            role: 'assistant' as const,
            content: m.content,
            timestamp: m.timestamp ?? Date.now(),
          })
        }
        continue
      }
      // Parent missing (truncated window) → fall through to render inline.
    }

    const msg: any = {
      id: nextMsgId(),
      role: m.role,
      content: m.content,
      toolName: m.toolName,
      toolId: m.toolId,
      toolInput: m.toolInput,
      toolStatus: m.toolName ? 'completed' : undefined,
      planToolUseId: m.planToolUseId,
      timestamp: m.timestamp ?? Date.now(),
    }
    if (m.role === 'tool' && m.toolId) toolById.set(m.toolId, msg)

    // A subagent tool call (Task/Agent, or codex_subagent) renders as a SubagentCard,
    // not a plain tool row. The live reducer sets subMessages via isSubagent; reload
    // has no such flag, so re-seed it here. The tool_result pass above reattaches the answer.
    if (m.role === 'tool' && m.toolName === 'mcp__solus__codex_subagent') {
      msg.subMessages = []
      msg.subagentType = 'codex'
    } else if (m.role === 'tool' && (m.toolName === 'Task' || m.toolName === 'Agent')) {
      msg.subMessages = []
      msg.subagentType = 'claude'
    }

    if (m.role === 'plan' && m.planContent) {
      const toolUseId = m.planToolUseId || uuid()
      msg.planToolUseId = toolUseId
      msg.planId = ctx.planStore.upsertFromHistory({
        sessionId: args.sessionId,
        planToolUseId: toolUseId,
        projectPath,
        cwd: args.displayCwd,
        content: m.planContent,
        filePath: m.planFilePath,
        timestamp: m.timestamp ?? Date.now(),
      })
      planIds.push(msg.planId)
    } else if (m.role === 'tool' && isCreateWorkTool(m.toolName)) {
      // A create_work call replays as a tool row (debug visibility) followed by its
      // work card. The real id lived in the dropped tool result, so resolve by title.
      messages.push(msg)
      let title = 'Untitled'
      let docType: 'doc' | 'slides' | 'diagram' = 'doc'
      try {
        const input = JSON.parse(m.toolInput || '{}') as { title?: string; doc_type?: string }
        if (input.title) title = input.title
        if (input.doc_type === 'slides' || input.doc_type === 'diagram') docType = input.doc_type
      } catch {}
      const workId = resolveCreatedWork(ctx, title, args.sessionId, claimedWorks)
      messages.push({
        id: nextMsgId(),
        role: 'assistant' as const,
        content: '',
        workRef: { workId, title, workType: docType },
        timestamp: m.timestamp ?? Date.now(),
      })
      continue
    } else if (m.role === 'tool' && isAutomationSaveTool(m.toolName)) {
      // A create/update_automation call replays as a tool row (debug visibility)
      // followed by its automation card. The id lived in the dropped tool result,
      // so resolve against the store by id (update) or name (create).
      messages.push(msg)
      let input: { automation_id?: string; name?: string } = {}
      try {
        input = JSON.parse(m.toolInput || '{}')
      } catch {}
      const resultId = automationIdFromResult(m.content) ?? automationIdFromResult(toolResultTextFor(loadedHistory, m.toolId))
      if (resultId) input.automation_id = resultId
      const automationRef = resolveSavedAutomation(ctx, input, claimedAutomations)
      if (automationRef) {
        messages.push({
          id: nextMsgId(),
          role: 'assistant' as const,
          content: '',
          automationRef,
          timestamp: m.timestamp ?? Date.now(),
        })
      }
      continue
    } else if (m.role === 'tool' && isRenderArtifactTool(m.toolName)) {
      // A render_artifact call replays as a tool row (debug visibility) followed by
      // its rendered artifact. The tool input carries everything to re-render.
      messages.push(msg)
      try {
        const input = JSON.parse(m.toolInput || '{}') as { kind?: string; html?: string; path?: string }
        const kind = input.kind === 'image' ? 'image' : 'html'
        let path = typeof input.path === 'string' ? input.path : undefined
        // The stored path may be relative to the working directory; resolve it so
        // the solus-artifact protocol can locate the file on reload.
        if (path && !path.startsWith('/')) path = `${args.displayCwd.replace(/\/$/, '')}/${path}`
        messages.push({
          id: nextMsgId(),
          role: 'assistant' as const,
          content: '',
          artifact: { kind, html: input.html, path },
          timestamp: m.timestamp ?? Date.now(),
        })
      } catch {}
      continue
    } else if (m.role === 'tool' && isCodexImageGenerationTool(m.toolName)) {
      // The image path was already resolved in the main process (codexItemToMessage).
      try {
        const input = JSON.parse(m.toolInput || '{}') as { path?: string }
        let path = typeof input.path === 'string' ? input.path : undefined
        if (path && !path.startsWith('/')) path = `${args.displayCwd.replace(/\/$/, '')}/${path}`
        if (path) {
          messages.push({
            id: nextMsgId(),
            role: 'assistant' as const,
            content: '',
            artifact: { kind: 'image', path },
            timestamp: m.timestamp ?? Date.now(),
          })
          continue
        }
      } catch {}
    }

    messages.push(msg)
  }

  return {
    messages,
    planIds,
    progress: progressFromMessages(messages),
    truncated,
  }
}

// ─── Pending input sync ───

export function syncPendingInputFromEvent(ctx: WorkspaceContext, session: Session, events: NormalizedEvent[]): void {
  const newPermissions: PermissionRequest[] = []
  const newQuestions: QuestionRequest[] = []
  const hasPlanEvent = events.some((e) => e.type === 'plan')
  for (const event of events) {
    if (event.type === 'permission_request') newPermissions.push(toPermissionRequest(event as Extract<NormalizedEvent, { type: 'permission_request' }>))
    else if (event.type === 'question_request') newQuestions.push(toQuestionRequest(event as Extract<NormalizedEvent, { type: 'question_request' }>))
  }
  session.permissionQueue.splice(0, session.permissionQueue.length, ...newPermissions)
  session.questionQueue.splice(0, session.questionQueue.length, ...newQuestions)

  if (!hasPlanEvent && session.agentSessionId) {
    ctx.clearPlanWaiting(session.agentSessionId)
  }
}

export function reconcileQueuedPromptsForSession(session: Session, queuedPrompts: QueuedPromptSnapshot[]): void {
  session.serverQueuedPrompts.splice(
    0,
    session.serverQueuedPrompts.length,
    ...queuedPrompts.map((prompt) => ({ ...prompt })),
  )
}
