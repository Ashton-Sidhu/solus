// The candidate index behind `#`: plans, docs, pull requests, sessions, tasks
// and automations, normalized to one row shape.
//
// It lives apart from the autocomplete controller because it has nothing to do
// with editors or trigger text — the task page's link picker queries exactly the
// same six categories with no caret and no composer anywhere in sight. The
// controller owns the state machine; this owns what there is to reach.
import { planKey } from '../../../../shared/types'
import type { Automation, PlanDescriptor, SessionMeta } from '../../../../shared/types'
import type { PullRequestSummary } from '../../../../shared/providers'
import type { Task } from '../../../../shared/task-types'
import type { PlanStore, WorkspaceContext } from '../../../contexts'
import { matchesOpenProjects } from '../../../lib/sessionUtils'
import { threadTime } from '../../../lib/relative-time'
import { triggerSummary } from '../../automations/lib/automation-format'
import { GLYPH, KIND_NOUN, type RefKind } from './kinds'
import type { MenuItem } from './rows'
import { serverConnections } from '@client-core/server-connections'
import { stampSessionMetas } from '@client-core/session-meta'

/** Per-kind cap: the index behind `#` is for reaching things, not browsing all. */
export const PER_KIND_LIMIT = 20

export function timestamp(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function freshness(value: string | number | undefined | null): string {
  const at = timestamp(value)
  return at ? threadTime(at, Date.now()) : ''
}

/** A referenced session's chip label: its slug, else the first line of its
 *  first message, else a short id. */
function sessionRefTitle(session: SessionMeta): string {
  const slug = session.slug?.trim()
  if (slug) return slug
  const firstLine = session.firstMessage?.split('\n')[0]?.trim()
  if (firstLine) return firstLine
  return session.sessionId.slice(0, 8)
}

export function filterPlanAutocompleteDescriptors(
  descriptors: PlanDescriptor[],
  filter: string,
  projectRoots: string[],
): PlanDescriptor[] {
  const query = filter.toLowerCase()
  const scoped = descriptors.filter((descriptor) =>
    matchesOpenProjects(descriptor.cwd, projectRoots),
  )
  const matching = query
    ? scoped.filter((descriptor) => descriptor.title.toLowerCase().includes(query))
    : scoped
  return matching.sort((a, b) => b.timestamp - a.timestamp).slice(0, 20)
}

export interface ReferenceIndexDeps {
  session: WorkspaceContext
  planStore: PlanStore
  workingDirectory: () => string | undefined
  /** Tab whose server owns the session listing. Omit where there is no tab —
   *  the sessions category is then simply empty. */
  tabId?: () => string | undefined
}

export class ReferenceIndex {
  #prCandidates = $state<PullRequestSummary[]>([])
  #sessionCandidates = $state<SessionMeta[]>([])
  #prLoadId = 0
  #sessionLoadId = 0

  constructor(private deps: ReferenceIndexDeps) {}

  planItems = $derived.by((): MenuItem[] => {
    const workingDirectory = this.deps.workingDirectory()
    return filterPlanAutocompleteDescriptors(
      [...this.deps.planStore.cachedDescriptors],
      '',
      workingDirectory ? [workingDirectory] : this.deps.session.openProjectScopeRoots,
    ).map((descriptor) => ({
      id: `plan:${planKey(descriptor.sessionId, descriptor.planToolUseId)}`,
      title: descriptor.title,
      meta: descriptor.status,
      when: freshness(descriptor.timestamp),
      icon: GLYPH.plan,
      mono: false,
      monoMeta: false,
      refKind: 'plan' as const,
      kindNoun: KIND_NOUN.plan,
      token: {
        kind: 'plan',
        planId: planKey(descriptor.sessionId, descriptor.planToolUseId),
        sessionId: descriptor.sessionId,
        planToolUseId: descriptor.planToolUseId,
        title: descriptor.title,
        status: descriptor.status,
      },
    }))
  })

  docItems = $derived.by((): MenuItem[] =>
    Object.values(this.deps.session.worksStore.works)
      .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))
      .slice(0, PER_KIND_LIMIT)
      .map((work) => ({
        id: `doc:${work.id}`,
        title: work.title,
        meta: work.type,
        when: freshness(work.updatedAt),
        icon: GLYPH.file,
        mono: false,
        monoMeta: false,
        refKind: 'doc' as const,
        kindNoun: KIND_NOUN.doc,
        token: { kind: 'work', workId: work.id, title: work.title, type: work.type },
      })),
  )

  prItems = $derived.by((): MenuItem[] =>
    this.#prCandidates.slice(0, PER_KIND_LIMIT).map((pr) => ({
      id: `pr:${pr.number}`,
      title: `#${pr.number} ${pr.title}`,
      meta: pr.draft ? `draft · ${pr.author}` : `${pr.state} · ${pr.author}`,
      when: freshness(pr.updatedAt),
      icon: GLYPH.pr,
      mono: false,
      monoMeta: false,
      refKind: 'pr' as const,
      kindNoun: KIND_NOUN.pr,
      token: { kind: 'pr', number: pr.number, title: pr.title },
    })),
  )

  sessionItems = $derived.by((): MenuItem[] => {
    // You can't reference your own conversation (matches prompt_session).
    const tabId = this.deps.tabId?.()
    const currentSessionId = tabId
      ? this.deps.session.sessionFor(tabId)?.agentSessionId
      : undefined
    return this.#sessionCandidates
      // An incomplete provider record cannot be targeted and would render as a
      // blank row because its short-id fallback is blank too.
      .filter(
        (session) =>
          session.sessionId.trim().length > 0 &&
          session.sessionId !== currentSessionId,
      )
      .slice(0, PER_KIND_LIMIT)
      .map((session) => ({
        id: `session:${session.sessionId}`,
        title: sessionRefTitle(session),
        meta: session.cwd.slice(session.cwd.lastIndexOf('/') + 1),
        when: freshness(session.lastTimestamp),
        icon: GLYPH.session,
        mono: false,
        monoMeta: false,
        refKind: 'session' as const,
        kindNoun: KIND_NOUN.session,
        token: {
          kind: 'session',
          sessionId: session.sessionId,
          provider: session.provider,
          title: sessionRefTitle(session),
          cwd: session.cwd,
        },
      }))
  })

  taskItems = $derived.by((): MenuItem[] =>
    this.deps.session.tasksStore.tasks.slice(0, PER_KIND_LIMIT).map((task: Task) => ({
      id: `task:${task.id}`,
      title: task.title,
      meta: task.status,
      when: freshness(task.updatedAt),
      icon: GLYPH.task,
      mono: false,
      monoMeta: false,
      refKind: 'task' as const,
      kindNoun: KIND_NOUN.task,
      token: { kind: 'task', taskId: task.id, title: task.title },
    })),
  )

  automationItems = $derived.by((): MenuItem[] =>
    this.deps.session.automationsStore.items
      .slice(0, PER_KIND_LIMIT)
      .map((automation: Automation) => ({
        id: `automation:${automation.id}`,
        title: automation.name,
        meta: automation.enabled
          ? triggerSummary(automation.trigger)
          : `${triggerSummary(automation.trigger)} · paused`,
        when: freshness(automation.lastRunAt),
        icon: GLYPH.automation,
        mono: false,
        monoMeta: false,
        refKind: 'automation' as const,
        kindNoun: KIND_NOUN.automation,
        token: { kind: 'automation', automationId: automation.id, title: automation.name },
      })),
  )

  byKind: Record<RefKind, MenuItem[]> = $derived.by(() => ({
    plan: this.planItems,
    doc: this.docItems,
    pr: this.prItems,
    session: this.sessionItems,
    task: this.taskItems,
    automation: this.automationItems,
  }))

  /** One call, all six categories concurrently, because any of them is
   *  reachable by typing three letters without drilling first. Each store
   *  dedupes its own in-flight load and caches the result, so warming again
   *  costs nothing until the data actually changes. */
  warm(): void {
    const { session, planStore } = this.deps
    const workingDirectory = this.deps.workingDirectory()

    const descriptorKey = planStore.descriptorCacheKey(undefined, true)
    if (
      (planStore.cachedDescriptorKey !== descriptorKey || planStore.cachedDescriptors.length === 0)
      && !planStore.isDescriptorLoading(descriptorKey)
    ) {
      void planStore.getDescriptors(undefined, true, session.ctx).catch(() => {})
    }

    if (Object.keys(session.worksStore.works).length === 0) {
      void session.worksStore.loadAll(workingDirectory).catch(() => {})
    }

    if (!session.automationsStore.loaded) void session.automationsStore.loadAll().catch(() => {})

    if (workingDirectory) {
      void session.tasksStore.ensureLoaded().catch(() => {})
      void this.#loadSessions()
    }
    void this.#loadPullRequests()
  }

  async #loadPullRequests(): Promise<void> {
    const requestId = ++this.#prLoadId
    const workingDirectory = this.deps.workingDirectory()
    const context = workingDirectory
      ? this.deps.session.ctxForDirectory(workingDirectory)
      : this.deps.session.ctx
    const api = this.deps.session.apiForContext(context)
    try {
      const result = await this.deps.session.prsStore.loadFor(
        api,
        serverConnections.serverIdForApi(api),
        context,
        { state: 'open' },
      )
      if (requestId !== this.#prLoadId) return
      this.#prCandidates = [...result.items].sort(
        (a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt),
      )
    } catch {
      // A repo with no host connection simply has no pull requests to offer.
    }
  }

  async #loadSessions(): Promise<void> {
    const requestId = ++this.#sessionLoadId
    const workingDirectory = this.deps.workingDirectory()
    const tabId = this.deps.tabId?.()
    if (!workingDirectory || !tabId) return
    try {
      const sessions = await this.deps.session
        .apiFor(tabId)
        .listSessions(workingDirectory, this.deps.session.ctxFor(tabId))
      if (requestId !== this.#sessionLoadId) return
      const sourceServerId = this.deps.session.runFor(tabId)?.serverId
      if (!sourceServerId) return
      const serverId = serverConnections.resolveId(sourceServerId)
      this.#sessionCandidates = [...stampSessionMetas(sessions, serverId)].sort(
        (a, b) => timestamp(b.lastTimestamp) - timestamp(a.lastTimestamp),
      )
    } catch {
      // Same: no transcripts on disk is an empty category, not an error.
    }
  }
}
