import { loadHistoryPage, type HistorySegment } from './history-page'
import { lineageSwitchDivider } from './thread-activity'
import { createLogger } from '../../logger'
import { isRawReviewSkill } from '../agents/review-command'
import { getIndexedSession } from '../../db/session-indexer'
import { resolveSessionLineageById } from '../../data/sessions/session-lineage'
import type { AgentId, AgentUsageLimits, IpcContext, PlanDescriptor, PluginCommandsResult, SessionMeta, SessionDescription, ThreadGoal, ThreadGoalSetRequest } from '@solus/contracts/types'
import type { SessionHistoryPageRequest, ProviderHistoryPage, SessionLoadMessage, SessionPreviewResult } from '@solus/contracts/session-history'
import { type TurnSeat } from '../seats/seat-manager'
import type { SessionRuntime } from '../session-runtime'

const log = createLogger('SessionRuntime', 'session-history.ts')

const AGENT_DISPLAY_NAMES = new Map<AgentId, string>([
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['opencode', 'OpenCode'],
])

/**
 * Reads of a session's durable history across its provider lineage, and
 * of what each provider keeps: plans, goals, commands, and usage.
 */
export class SessionHistory {
  constructor(private readonly rt: SessionRuntime) {}

  async listPlansForProviders(agentIds: AgentId[], projectPath: string | undefined, allProjects: boolean): Promise<PlanDescriptor[]> {
    const settled = await Promise.allSettled(
      agentIds.map((agentId) => this.rt.backendFor(agentId).listPlans(projectPath, allProjects)),
    )
    const plans = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    plans.sort((a, b) => b.timestamp - a.timestamp)
    return plans
  }

  invalidatePlanCaches(sessionId: string): void {
    for (const agentId of this.rt.getBackendIds()) {
      this.rt.backendFor(agentId).invalidatePlanCache?.(sessionId)
    }
  }

  async loadSessionPage(request: SessionHistoryPageRequest): Promise<ProviderHistoryPage> {
    const { provider, sessionId, projectPath } = request
    const lineage = resolveSessionLineageById(sessionId)
    const segments: HistorySegment[] = lineage ? lineage.members.map((member, index) => {
      const previous = lineage.members[index - 1]
      return {
        provider: member.provider,
        sessionId: member.providerSessionId,
        projectPath: member.cwd || projectPath,
        divider: previous ? lineageSwitchDivider(lineage.sessionId, previous, member) : undefined,
      }
    }) : [{ provider, sessionId, projectPath }]
    return loadHistoryPage(
      JSON.stringify(lineage ? [lineage.sessionId] : [provider, sessionId]), segments,
      request.turnLimit, request.before,
      async (segment, turnLimit, before) => {
        const backend = this.rt.backendFor(segment.provider)
        if (!backend.loadSessionPage) throw new Error('This provider does not support history pages.')
        return backend.loadSessionPage(segment.sessionId!, segment.projectPath, turnLimit, before)
      },
    )
  }

  async loadSession(agentId: AgentId, sessionId: string, projectPath?: string, limit?: number): Promise<SessionLoadMessage[]> {
    let handoff = resolveSessionLineageById(sessionId)
    if (!handoff) return this.rt.handoffs.handoffCarry.merge(sessionId, await this.rt.backendFor(agentId).loadSession(sessionId, projectPath, limit))

    for (let attempt = 0; attempt < 2; attempt++) {
      const loaded: SessionLoadMessage[][] = []
      for (const member of handoff.members) {
        if (!member.providerSessionId) {
          loaded.push([])
          continue
        }
        try {
          loaded.push(this.rt.handoffs.handoffCarry.merge(member.providerSessionId, await this.rt.backendFor(member.provider).loadSession(
            member.providerSessionId,
            member.cwd || projectPath,
            limit,
          )))
        } catch (error) {
          log.warn('session_handoff_segment_load_failed', {
            sessionId: handoff.sessionId,
            provider: member.provider,
            agentSessionId: member.providerSessionId,
            error: error instanceof Error ? error.message : String(error),
          })
          loaded.push([{
            messageId: `handoff-unavailable:${handoff.sessionId}:${member.position}`,
            role: 'system',
            content: `${AGENT_DISPLAY_NAMES.get(member.provider)} transcript unavailable`,
            timestamp: member.startedAt,
          }])
        }
      }

      const latest = resolveSessionLineageById(handoff.sessionId)
      if (latest && latest.lineageToken !== handoff.lineageToken && attempt === 0) {
        handoff = latest
        continue
      }

      const composite: SessionLoadMessage[] = []
      for (let index = 0; index < handoff.members.length; index++) {
        const member = handoff.members[index]
        if (index > 0) composite.push(lineageSwitchDivider(handoff.sessionId, handoff.members[index - 1], member))
        composite.push(...loaded[index].map((message) => ({ ...message, sourceProvider: member.provider, sourceSessionId: member.providerSessionId ?? undefined })))
      }
      return limit && composite.length > limit ? composite.slice(-limit) : composite
    }
    return []
  }

  /** One read for opening a saved session: its lineage and its metadata. */
  async describeSession(sessionId: string): Promise<SessionDescription> {
    const lineage = resolveSessionLineageById(sessionId)
    // An active member with no transcript yet has no metadata to read; the
    // lineage alone carries what the client needs for it.
    if (lineage && !lineage.active.providerSessionId) return { lineage, meta: null }
    return { lineage, meta: await this.getSessionInfo(sessionId) }
  }

  /** A session's metadata, read from the index row of its active thread. A
   *  session with no lineage is its own thread (docs/plans/session-identity.md). */
  async getSessionInfo(sessionId: string): Promise<SessionMeta | null> {
    const handoff = resolveSessionLineageById(sessionId)
    const metadataMember = handoff?.active.providerSessionId
      ? handoff.active
      : handoff?.members.findLast((member) => !!member.providerSessionId)
    const indexedSessionId = metadataMember?.providerSessionId ?? sessionId
    const meta = getIndexedSession(indexedSessionId)
    if (!meta) return null
    if (handoff) {
      meta.sessionId = handoff.sessionId
      meta.provider = handoff.active.provider
      meta.cwd = handoff.active.cwd
    }
    const active = this.rt.activeSessions.get(sessionId)
    if (active) {
      meta.provider = active.backendId
      const runtimeAgentSessionId = active.agentSessionId ?? indexedSessionId
      const pendingRateLimit = this.rt.rateLimitPark.currentRateLimitEvent(sessionId)
      meta.status = pendingRateLimit
        ? 'rate_limited'
        : active.status === 'completed'
          && this.rt.backendFor(active.backendId).isSessionRunning(runtimeAgentSessionId)
          ? 'running'
          : active.status
      meta.currentTurnStartedAt = this.rt.backendFor(active.backendId)
        .getSessionHandle(runtimeAgentSessionId)?.startedAt
      meta.lastTimestamp = new Date(active.lastActivityAt).toISOString()
    }
    return meta
  }

  loadSessionPreview(agentId: AgentId, sessionId: string, projectPath?: string): Promise<SessionPreviewResult> {
    // Every session has a lineage now, so its mere existence says nothing. Only a
    // multi-member lineage needs the composite read; a single member is one
    // provider transcript and keeps the backend's cheap preview. This is the
    // session picker's hot path — reading full transcripts here would cost a
    // whole-list stall on every open.
    const lineage = resolveSessionLineageById(sessionId)
    if (lineage && lineage.members.length > 1) {
      return this.loadSession(agentId, sessionId, projectPath).then((allMsgs) => {
        const msgs = allMsgs.filter((message) => message.role !== 'reasoning')
        return {
          head: msgs.slice(0, 4),
          tail: msgs.slice(-1),
          totalMessages: msgs.length,
        }
      })
    }
    // A task link names the stable Solus session. A lineage of one is still
    // backed by a provider thread with a different id, so route the cheap read
    // to that endpoint instead of asking the provider for the Solus id. The old
    // session picker did not expose this because its history rows carried the
    // provider thread id directly.
    const member = lineage?.active.providerSessionId
      ? lineage.active
      : lineage?.members.findLast((candidate) => !!candidate.providerSessionId)
    const previewAgentId = member?.provider ?? agentId
    const previewSessionId = member?.providerSessionId ?? sessionId
    const previewProjectPath = member?.cwd || projectPath
    const backend = this.rt.backendFor(previewAgentId)
    if (backend.loadSessionPreview) {
      return backend.loadSessionPreview(previewSessionId, previewProjectPath)
    }
    return backend.loadSession(previewSessionId, previewProjectPath).then((allMsgs) => {
      // Reasoning turns ride along for provider handoffs; a preview shows real
      // conversation, so drop them before sampling the head/tail.
      const msgs = allMsgs.filter((m) => m.role !== 'reasoning')
      return {
        head: msgs.slice(0, 4),
        tail: msgs.slice(-1),
        totalMessages: msgs.length,
      }
    })
  }

  listPlans(agentId: AgentId, projectPath: string | undefined, allProjects: boolean): Promise<PlanDescriptor[]> {
    return this.rt.backendFor(agentId).listPlans(projectPath, allProjects)
  }

  loadPlanContent(agentId: AgentId, sessionId: string, projectPath: string, planToolUseId: string): Promise<string | null> {
    return this.rt.backendFor(agentId).loadPlanContent(sessionId, projectPath, planToolUseId)
  }

  getThreadGoal(agentId: AgentId, threadId: string): Promise<ThreadGoal | null> {
    if (agentId === 'claude-code') return Promise.resolve(this.rt.claudeGoals.get(threadId))
    const backend = this.rt.backendFor(agentId)
    if (!backend.getThreadGoal) throw new Error(`${agentId} does not support thread goals`)
    return backend.getThreadGoal(threadId)
  }

  setThreadGoal(agentId: AgentId, request: ThreadGoalSetRequest): Promise<ThreadGoal> {
    if (agentId === 'claude-code') {
      const goal = this.rt.claudeGoals.create(request)
      // Goals are stored against the provider's thread id, so resolve first.
      const sessionId = this.rt.agentSessionToSession.get(request.threadId)
      if (sessionId) this.rt.publish(sessionId, { type: 'goal_updated', goal })
      return Promise.resolve(goal)
    }
    const backend = this.rt.backendFor(agentId)
    if (!backend.setThreadGoal) throw new Error(`${agentId} does not support thread goals`)
    return backend.setThreadGoal(request)
  }

  clearThreadGoal(agentId: AgentId, threadId: string): Promise<boolean> {
    if (agentId === 'claude-code') throw new Error('Clearing goals is only supported for Codex sessions')
    const backend = this.rt.backendFor(agentId)
    if (!backend.clearThreadGoal) throw new Error(`${agentId} does not support thread goals`)
    return backend.clearThreadGoal(threadId)
  }

  async listPluginCommands(agentId: AgentId, workingDirectory: string, ctx?: IpcContext): Promise<PluginCommandsResult> {
    const result = await this.rt.backendFor(agentId).listPluginCommands(workingDirectory, ctx)
    const aliases = [
      { name: 'review', description: 'Review working-tree changes', kind: 'skill' as const },
      { name: 'review:working-tree', description: 'Review staged, unstaged, and untracked changes', kind: 'skill' as const },
      { name: 'review:session', description: 'Review this session\'s changes', kind: 'skill' as const },
      { name: 'review:branch', description: 'Review the current branch', kind: 'skill' as const },
      { name: 'review:pr', description: 'Review a pull request', argumentHint: 'PR URL', kind: 'skill' as const },
    ]
    const listed: PluginCommandsResult = {
      global: [...aliases, ...result.global.filter((command) => !isRawReviewSkill(command))],
      project: result.project.filter((command) => !isRawReviewSkill(command)),
    }
    if (result.builtin) listed.builtin = result.builtin.filter((command) => !isRawReviewSkill(command))
    return listed
  }

  async refreshPluginCommands(): Promise<void> {
    await Promise.all([...this.rt.backends.values()].map((backend) => backend.refreshPluginCommands()))
  }

  /** Agents whose backend can report subscription quota. */
  usageCapableAgents(): AgentId[] {
    return [...this.rt.backends.entries()]
      .filter(([, backend]) => backend.readUsageLimits)
      .map(([agentId]) => agentId)
  }

  /** Null when the provider exposes no quota, or its report didn't parse. With a seat, that member's quota. */
  readUsageLimits(agentId: AgentId, seat?: TurnSeat): Promise<AgentUsageLimits | null> {
    const backend = this.rt.backendFor(agentId)
    return backend.readUsageLimits?.(seat) ?? Promise.resolve(null)
  }
}
