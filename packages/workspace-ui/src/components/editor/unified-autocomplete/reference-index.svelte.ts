// The candidate index behind `#`: plans, docs, pull requests, sessions, tasks
// and automations, normalized to one row shape.
//
// It lives apart from the autocomplete controller because it has nothing to do
// with editors or trigger text — the task page's link picker queries exactly the
// same six categories with no caret and no composer anywhere in sight. The
// controller owns the state machine; this owns what there is to reach.
import { planKey } from '@solus/contracts/types'
import type {
  Automation,
  PlanDescriptor,
  PlanReference,
  SessionMeta,
} from '@solus/contracts/types'
import type { PullRequest } from '@solus/contracts/providers'
import type { Task, TaskLink } from '@solus/contracts/task-types'
import type { PlanStore, WorkspaceContext } from '../../../contexts'
import type { PrsStore } from '../../../contexts/prs/prs.store.svelte'
import { matchesOpenProjects } from '../../../lib/sessionUtils'
import { threadTime } from '../../../lib/relative-time'
import { triggerSummary } from '../../automations/lib/automation-format'
import { taskRef } from '../../tasks/task-page/lib/task-page'
import { GLYPH, KIND_NOUN, type RefKind } from './kinds'
import type { MenuItem } from './rows'
import { serverConnections } from '@solus/client-core/server-connections'
import { stampSessionMetas } from '@solus/client-core/session-meta'
import { stripInjectedContext } from '@solus/contracts/injected-context'

export function timestamp(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0
  const parsed = Number.isFinite(value) ? Number(value) : Date.parse(String(value))
  return Number.isNaN(parsed) ? 0 : parsed
}

function freshness(value: string | number | undefined | null): string {
  const at = timestamp(value)
  return at ? threadTime(at, Date.now()) : ''
}

/** A task link stores its target's live status as free text. Only the three
 *  plan states mean anything to a plan chip; anything else reads as pending. */
function planRefStatus(status: string | undefined): PlanReference['status'] {
  return status === 'accepted' || status === 'rejected' ? status : 'pending'
}

/** A referenced session's chip label: its slug, else the first line of its
 *  first message, else a short id. */
export function sessionRefTitle(session: SessionMeta): string {
  const customTitle = session.customTitle?.trim()
  if (customTitle) return customTitle
  const slug = session.slug?.trim()
  if (slug) return slug
  const firstLine = sessionRefPreview(session).split('\n')[0]?.trim()
  if (firstLine) return firstLine
  return session.sessionId.slice(0, 8)
}

export function sessionRefPreview(session: SessionMeta): string {
  return session.firstMessage
    ? stripInjectedContext(session.firstMessage).replace(/\s+/g, ' ').trim()
    : ''
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
  return matching.sort((a, b) => b.timestamp - a.timestamp)
}

export interface ReferenceIndexDeps {
  session: WorkspaceContext
  pullRequests: PrsStore
  planStore: PlanStore
  workingDirectory: () => string | undefined
  /** Tab whose server owns the session listing. Omit where there is no tab —
   *  the sessions category is then simply empty. */
  tabId?: () => string | undefined
}

export class ReferenceIndex {
  #prCandidates = $state<PullRequest[]>([])
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
    this.#prCandidates.map((pr) => ({
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
        preview: sessionRefPreview(session),
        token: {
          kind: 'session',
          sessionId: session.sessionId,
          provider: session.provider,
          serverId: session.serverId,
          title: sessionRefTitle(session),
          cwd: session.cwd,
        },
      }))
  })

  taskItems = $derived.by((): MenuItem[] =>
    this.deps.session.tasksStore.tasks.map((task: Task) => ({
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

  /** The task this conversation is working on. A link records the durable Solus
   *  session id, so the provider-native id only answers for links written
   *  before that identity existed. */
  linkedTask = $derived.by((): Task | null => {
    const tabId = this.deps.tabId?.()
    if (!tabId) return null
    const session = this.deps.session.sessionFor(tabId)
    if (!session) return null
    const { tasksStore } = this.deps.session
    return (
      tasksStore.taskForSession(session.handoffId ?? session.id)
      ?? tasksStore.taskForSession(session.agentSessionId)
    )
  })

  /** The task's short name, so the band says whose context it is showing. */
  linkedTaskRef = $derived(this.linkedTask ? taskRef(this.linkedTask) : '')

  /** What the current task is linked to, in one band ahead of the categories.
   *  The work you are in has the shortest path to its own PR, docs and plans. */
  linkedItems = $derived.by((): MenuItem[] => {
    const task = this.linkedTask
    if (!task) return []
    const details = this.deps.session.tasksStore.get(task.id).details
    if (!details) return []
    return [...details.links]
      .sort((a, b) => b.linkedAt - a.linkedAt)
      .map((link) => this.#linkedItem(link))
      .filter((item): item is MenuItem => item !== null)
  })

  /** A link carries a link-time snapshot, so a row renders even when its target
   *  is remote (`pr`) or has since been deleted. */
  #linkedItem(link: TaskLink): MenuItem | null {
    const title = link.liveTitle || link.title
    const shared = {
      title,
      meta: link.liveStatus ?? '',
      when: freshness(link.linkedAt),
      mono: false,
      monoMeta: false,
    }
    switch (link.kind) {
      case 'work': {
        const work = this.deps.session.worksStore.works[link.targetKey]
        return {
          ...shared,
          id: `doc:${link.targetKey}`,
          icon: GLYPH.file,
          refKind: 'doc',
          kindNoun: KIND_NOUN.doc,
          meta: work?.type ?? shared.meta,
          token: {
            kind: 'work',
            workId: link.targetKey,
            title,
            type: work?.type ?? 'doc',
          },
        }
      }
      case 'plan': {
        const planId = planKey(link.targetScope, link.targetKey)
        return {
          ...shared,
          id: `plan:${planId}`,
          icon: GLYPH.plan,
          refKind: 'plan',
          kindNoun: KIND_NOUN.plan,
          token: {
            kind: 'plan',
            planId,
            sessionId: link.targetScope,
            planToolUseId: link.targetKey,
            title,
            status: planRefStatus(link.liveStatus),
          },
        }
      }
      case 'pr': {
        const number = Number(link.targetKey)
        // A PR number that will not parse cannot be resolved by any surface the
        // chip opens, so it is not offered at all.
        if (!Number.isSafeInteger(number)) return null
        return {
          ...shared,
          id: `pr:${number}`,
          icon: GLYPH.pr,
          refKind: 'pr',
          kindNoun: KIND_NOUN.pr,
          title: `#${number} ${title}`,
          token: { kind: 'pr', number, title },
        }
      }
      case 'automation':
        return {
          ...shared,
          id: `automation:${link.targetKey}`,
          icon: GLYPH.automation,
          refKind: 'automation',
          kindNoun: KIND_NOUN.automation,
          token: { kind: 'automation', automationId: link.targetKey, title },
        }
    }
  }

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
      // The session→task binding only exists once the list has loaded, so the
      // links of this conversation's task are fetched behind that load rather
      // than on a second `#`.
      void session.tasksStore
        .ensureLoaded()
        .then(() => this.#loadTaskLinks())
        .catch(() => {})
      void this.#loadSessions()
    }
    void this.#loadPullRequests()
  }

  /** Links ride the task's detail read. Linking anywhere in the app writes back
   *  to the same cache, so this only has to fill it the first time. */
  async #loadTaskLinks(): Promise<void> {
    const task = this.linkedTask
    const { tasksStore } = this.deps.session
    if (!task || tasksStore.get(task.id).details) return
    try {
      await tasksStore.get(task.id).loadDetails()
    } catch {
      // A task whose host is unreachable simply contributes no linked band.
    }
  }

  async #loadPullRequests(): Promise<void> {
    const requestId = ++this.#prLoadId
    const workingDirectory = this.deps.workingDirectory()
    const context = workingDirectory
      ? this.deps.session.ctxForDirectory(workingDirectory)
      : this.deps.session.ctx
    const api = this.deps.session.apiForContext(context)
    try {
      const result = await this.deps.pullRequests
        .get(api, serverConnections.serverIdForApi(api), context)
        .query({ state: 'open' })
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
