import type { Component } from 'svelte'
import type { DiffScope } from '../../../../shared/types'
import type { PrReviewTarget } from '../../../../shared/providers'
import type { HostApi } from '@client-core/host-api'
import { serverConnections } from '@client-core/server-connections'

/**
 * Every destination Solus can navigate to, declared once.
 *
 * A descriptor is the single place a destination states what it needs: how its
 * params survive a round-trip through a URL (`parse`/`serialize`), where it is
 * allowed to sit (`placement`), what it may not coexist with (`exclusiveGroup`),
 * how wide it opens (`defaultWeight`), and which module renders it
 * (`component`). Adding a destination is one entry here — no store method, no
 * boolean flag, no branch in the outlet.
 *
 * Params are plain, serializable data: the identity of a destination, never a
 * live payload. Anything heavy or fetched (a PR's worktree) is produced by
 * `resolve` and held in the router's capped cache, which is what makes a
 * location persistable and deep-linkable.
 */

export type SettingsTab =
  | 'general'
  | 'instructions'
  | 'source-control'
  | 'review'
  | 'providers'
  | 'api-access'
  | 'tools'
  | 'skills'
  | 'voice'
  | 'experimental'
  | 'projects'
  | 'keybindings'

const SETTINGS_TABS: ReadonlySet<string> = new Set<SettingsTab>([
  'general',
  'instructions',
  'source-control',
  'review',
  'providers',
  'api-access',
  'tools',
  'skills',
  'voice',
  'experimental',
  'projects',
  'keybindings',
])

function isSettingsTab(value: string): value is SettingsTab {
  return SETTINGS_TABS.has(value)
}

/** The params each destination carries. Serializable by construction. */
export interface RouteParams {
  /** The conversation, named by the session it shows. No `sessionId` means the
   *  active-tab pool; naming one pins that conversation into the pane. A tab is
   *  where a session is currently rendered, which is the workspace's business
   *  to resolve — routing never carries one. */
  chat: { sessionId?: string; serverId?: string }
  /** A prompt being written that has no session and no tab yet. The id is
   *  identity only — the draft it names lives in `workspace.sessionDrafts`,
   *  because a location must stay serializable. */
  draft: { draftId: string }
  tasks: Record<string, never>
  task: { taskId: string; serverId?: string }
  prs: { projectPath?: string }
  reviewMode: Record<string, never>
  settings: { tab?: SettingsTab; projectCwd?: string }
  folio: Record<string, never>
  automations: { automationId?: string }
  plan: { planId: string | null; serverId?: string }
  work: { workId: string }
  automation: { automationId: string | null; serverId?: string }
  /** A goal belongs to a thread, so the pane names the session — not whichever
   *  tab happened to open it, which may since have closed. */
  goal: { sessionId: string; serverId?: string }
  review: { key: string; scope: 'branch' | 'session'; sourceTabId?: string }
  prReview: {
    number: number
    title?: string
    cwd?: string
    serverId?: string
    /** Present for a host URL so a number can never open in the wrong repo. */
    expectedRepo?: { host: string; owner: string; repo: string }
  }
  prDiff: { number: number; cwd?: string; serverId?: string }
  // The working directory and checkout a viewer runs against are derived from
  // its source tab's environment, not carried: they are live Git state, and a
  // route that pinned them would go stale the moment the branch moved.
  diff: { sourceTabId: string; scope?: DiffScope; filePath?: string }
  // A file tree names a run source — a tab or a draft — not a conversation:
  // which machine the files are on and which directory they sit in both come
  // off the run, and a draft has one before it has a session.
  files: { sourceId: string }
  fileEditor: { sourceId: string; path: string; line?: number }
  /** A sub-agent's nested transcript hangs off a message, and messages belong
   *  to the conversation. */
  subagent: { sessionId: string; messageId: string; serverId?: string }
}

export type RouteName = keyof RouteParams

/** A destination plus the params that identify it — the unit of navigation. */
export type RouteRef<K extends RouteName = RouteName> = K extends RouteName
  ? { name: K; params: RouteParams[K] }
  : never

/**
 * Where a route may sit, stated relatively so it survives adding panes.
 * - `any` — any pane, including the leading one.
 * - `aside` — never the leading pane. What "secondary-only" used to mean.
 * - `overlay` — covers a pane's base content instead of replacing it.
 */
export type Placement = 'any' | 'aside' | 'overlay'

/** At most one route of a group exists across all panes; opening another
 *  replaces it wherever it already lives. */
export type ExclusiveGroup = 'page' | 'artifact'

/** Everything the router and the outlet need from a destination. */
export interface RouteDescriptor<K extends RouteName> {
  /** Total: returns null on unparseable input rather than throwing, so an
   *  untrusted URL drops one pane instead of failing the whole location. */
  parse: (segment: string) => RouteParams[K] | null
  serialize: (params: RouteParams[K]) => string
  placement: Placement
  exclusiveGroup?: ExclusiveGroup
  /** The surface draws a shared-height header that consumes the window-control
   *  lead inset itself. Page outlets must not add a second titlebar-height pad. */
  ownsTitlebarChrome?: boolean
  /** Mounted once and hidden, never unmounted by navigation. The outlet skips
   *  route-driven mounting for these; their pool owns the lifecycle. */
  keepAlive?: boolean
  /** Fraction of the split area this route claims when it opens a pane. */
  defaultWeight?: number
  /** Lazy module for the surface. Absent when the shell renders the route
   *  itself (`chat`, whose pool is hoisted out of the pane loop). */
  component?: () => Promise<{ default: Component<any> }>
  /** Params → live payload, fetched on entry and held in the router's LRU. */
  resolve?: (params: RouteParams[K], ctx: RouteResolveContext) => Promise<PrReviewTarget>
}

/** What a descriptor's `resolve` is handed: the IPC surface plus the caller's
 *  project scope, with no reference back to the pane it is filling. */
export interface RouteResolveContext {
  api: HostApi
  ipc: (cwd?: string) => import('../../../../shared/types').IpcContext
}

type RouteTable = { [K in RouteName]: RouteDescriptor<K> }

function defineRoutes(routes: RouteTable): RouteTable {
  return routes
}

const optional = (value: string): string | undefined => value || undefined

/**
 * The one grammar for a host-scoped id: `<id>~<serverId>` inside the id's own
 * segment, so multi-segment routes stay `/`-splittable. `~` never appears in
 * the ids Solus mints, and the last `~` wins on parse.
 */
function serializeScopedId(id: string, serverId?: string): string {
  return serverId ? `${id}~${serverId}` : id
}

function parseScopedId(segment: string): { id: string; serverId?: string } {
  const separator = segment.lastIndexOf('~')
  if (separator === -1) return { id: segment }
  const serverId = segment.slice(separator + 1)
  const id = segment.slice(0, separator)
  return serverId ? { id, serverId } : { id }
}

/**
 * A diff scope inside one path segment. `~` separates a scope's own fields, so
 * the segment never collides with the `/` the codec splits on or with the file
 * path that follows it.
 */
function serializeDiffScope(scope: DiffScope | undefined): string {
  if (!scope || scope.kind === 'session') return 'session'
  if (scope.kind === 'working-tree') return 'working-tree'
  if (scope.kind === 'turn') return `turn~${scope.index}`
  return ['pr', scope.baseSha, scope.ownDeltaBaseSha ?? '', scope.parentPr ?? ''].join('~')
}

function parseDiffScope(segment: string | undefined): DiffScope {
  const [kind, ...fields] = (segment ?? '').split('~')
  if (kind === 'working-tree') return { kind: 'working-tree' }
  if (kind === 'turn' && /^\d+$/.test(fields[0] ?? '')) return { kind: 'turn', index: Number(fields[0]) }
  if (kind === 'pr' && fields[0]) {
    const scope: DiffScope = {
      kind: 'pr',
      baseSha: fields[0],
    }
    if (fields[1]) scope.ownDeltaBaseSha = fields[1]
    if (/^\d+$/.test(fields[2] ?? '')) scope.parentPr = Number(fields[2])
    return scope
  }
  return { kind: 'session' }
}

export const ROUTES = defineRoutes({
  chat: {
    parse: (s) => {
      const { id, serverId } = parseScopedId(s)
      return serverId && id
        ? { sessionId: id, serverId }
        : { sessionId: optional(s) }
    },
    serialize: (p) => p.sessionId ? serializeScopedId(p.sessionId, p.serverId) : '',
    placement: 'any',
    // The pool owns a chat's lifecycle: the leading pane renders it hidden
    // rather than unmounted, so navigation never tears a conversation down.
    // A chat pinned into a companion pane still mounts through the outlet.
    keepAlive: true,
    component: () => import('../../../components/conversation/ConversationPane.svelte'),
  },
  draft: {
    parse: (s) => (s ? { draftId: s } : null),
    serialize: (p) => p.draftId,
    placement: 'any',
    // Not `keepAlive`: that flag means the outlet skips mounting because a pool
    // owns the surface, and drafts have no pool. Unmounting on navigation costs
    // only an editor rebuild — the prompt itself lives in `sessionDrafts`.
    component: () => import('../../../components/session-draft/SessionDraftPane.svelte'),
  },
  tasks: {
    parse: () => ({}),
    serialize: () => '',
    placement: 'any',
    exclusiveGroup: 'page',
    // Workspace list pages keep one fixed header position when the session
    // sidebar changes; their own top measure clears the page controls.
    ownsTitlebarChrome: true,
    component: () => import('../../../components/tasks/TasksPage.svelte'),
  },
  // One task, deep-linkable. It replaces the list in place rather than sitting
  // beside it: the page is the full-width two-column detail, and its own
  // breadcrumb is the way back.
  task: {
    parse: (s) => {
      const { id, serverId } = parseScopedId(s)
      if (!id) return null
      return serverId ? { taskId: id, serverId } : { taskId: id }
    },
    serialize: (p) => serializeScopedId(p.taskId, p.serverId),
    placement: 'any',
    exclusiveGroup: 'page',
    ownsTitlebarChrome: true,
    component: () => import('../../../components/tasks/task-page/TaskPage.svelte'),
  },
  prs: {
    parse: (s) => ({ projectPath: optional(s) }),
    serialize: (p) => p.projectPath ?? '',
    placement: 'any',
    exclusiveGroup: 'page',
    // The review panel beside the list paints its chrome band to the window's
    // top edge, so an outlet-level pad would read as an empty strip above it.
    // The list keeps the same fixed top measure in either sidebar state.
    ownsTitlebarChrome: true,
    component: () => import('../../../components/prs/PrsPage.svelte'),
  },
  reviewMode: {
    parse: () => ({}),
    serialize: () => '',
    placement: 'any',
    exclusiveGroup: 'page',
    ownsTitlebarChrome: true,
    component: () => import('../../../components/review-mode/ReviewModeHost.svelte'),
  },
  settings: {
    parse: (s) => {
      const [tab, ...cwd] = s.split('/')
      let settingsTab: SettingsTab | undefined
      if (tab) {
        if (!isSettingsTab(tab)) return null
        settingsTab = tab
      }
      return {
        tab: settingsTab,
        projectCwd: optional(cwd.join('/')),
      }
    },
    serialize: (p) => (p.projectCwd ? `${p.tab ?? 'projects'}/${p.projectCwd}` : p.tab ?? ''),
    placement: 'any',
    exclusiveGroup: 'page',
    // The nav column paints to the window's top edge, so the page clears the
    // window controls inside its own header band rather than being padded down.
    ownsTitlebarChrome: true,
    component: () => import('../../../components/settings/SettingsPage.svelte'),
  },
  folio: {
    parse: () => ({}),
    serialize: () => '',
    placement: 'any',
    exclusiveGroup: 'page',
    // The workspace paints to the window's top edge and keeps one fixed header
    // position when the session sidebar changes.
    ownsTitlebarChrome: true,
    component: () => import('../../../components/workspace/WorkspacePage.svelte'),
  },
  automations: {
    parse: (s) => ({ automationId: optional(s) }),
    serialize: (p) => p.automationId ?? '',
    placement: 'any',
    exclusiveGroup: 'page',
    // Keep the list aligned with Tasks, Pull Requests, and Workspace instead of
    // applying a second top inset when the session sidebar collapses.
    ownsTitlebarChrome: true,
    component: () => import('../../../components/automations/AutomationsPage.svelte'),
  },
  plan: {
    // A streamed plan has no id yet — the gallery preview fills the pane — so
    // an empty segment is a valid location, not a parse failure.
    parse: (s) => {
      const { id, serverId } = parseScopedId(s)
      return serverId ? { planId: id || null, serverId } : { planId: s || null }
    },
    serialize: (p) => serializeScopedId(p.planId ?? '', p.serverId),
    placement: 'any',
    exclusiveGroup: 'artifact',
    component: () => import('../../../components/plan/PlanPane.svelte'),
  },
  work: {
    parse: (s) => (s ? { workId: s } : null),
    serialize: (p) => p.workId,
    placement: 'any',
    exclusiveGroup: 'artifact',
    component: () => import('../../../components/work/WorkPane.svelte'),
  },
  automation: {
    parse: (s) => {
      const { id, serverId } = parseScopedId(s)
      return serverId ? { automationId: id || null, serverId } : { automationId: s || null }
    },
    serialize: (p) => serializeScopedId(p.automationId ?? '', p.serverId),
    placement: 'any',
    exclusiveGroup: 'artifact',
    component: () => import('../../../components/automations/AutomationPane.svelte'),
  },
  goal: {
    parse: (s) => {
      const { id, serverId } = parseScopedId(s)
      if (!id) return null
      return serverId ? { sessionId: id, serverId } : { sessionId: id }
    },
    serialize: (p) => serializeScopedId(p.sessionId, p.serverId),
    placement: 'aside',
    defaultWeight: 0.34,
    // No component: the goal surface only exists in the shells that have no
    // project rail to put it in (pill, mobile web), and each renders its own.
  },
  review: {
    parse: (s) => {
      const slash = s.indexOf('/')
      if (slash === -1) return s ? { key: s, scope: 'branch' } : null
      const key = s.slice(0, slash)
      const [scope, sourceTabId] = s.slice(slash + 1).split('/')
      if (!key || (scope !== 'branch' && scope !== 'session')) return null
      return { key, scope, sourceTabId: optional(sourceTabId) }
    },
    serialize: (p) => [p.key, p.scope, p.sourceTabId ?? ''].join('/').replace(/\/+$/, ''),
    placement: 'any',
    component: () => import('../../../components/review/ReviewPane.svelte'),
  },
  prReview: {
    parse: (s) => {
      const [head, ...rest] = s.split('/')
      const { id: number, serverId } = parseScopedId(head)
      if (!/^\d+$/.test(number)) return null
      const cwd = optional(rest.join('/'))
      const params: RouteParams['prReview'] = {
        number: Number(number),
      }
      if (serverId) params.serverId = serverId
      if (cwd) params.cwd = cwd
      return params
    },
    // The title is display-only: it is superseded by the resolved review, so it
    // stays out of the URL rather than becoming a stale thing to keep in sync.
    serialize: (p) => [serializeScopedId(String(p.number), p.serverId), p.cwd]
      .filter((segment) => segment != null)
      .join('/'),
    // A pull request is a place inside the list, not a panel beside it: opening
    // one replaces the list in the leading pane, and the chrome band's crumb —
    // not a second copy of the list in a sidebar — is the way back and sideways.
    placement: 'any',
    exclusiveGroup: 'page',
    ownsTitlebarChrome: true,
    component: () => import('../../../components/pr-review/PrReviewRoutePane.svelte'),
    resolve: (params, ctx) => {
      const api = params.serverId ? serverConnections.apiFor(params.serverId) : ctx.api
      return api.prOpenReview(ctx.ipc(params.cwd), params.number).then((target) => {
        const expected = params.expectedRepo
        if (
          expected &&
          (target.host.toLowerCase() !== expected.host.toLowerCase() ||
            target.owner.toLowerCase() !== expected.owner.toLowerCase() ||
            target.repo.toLowerCase() !== expected.repo.toLowerCase())
        ) {
          throw new Error(`This link belongs to ${expected.owner}/${expected.repo}, not ${target.owner}/${target.repo}`)
        }
        return target
      })
    },
  },
  prDiff: {
    parse: (s) => {
      const [head, ...rest] = s.split('/')
      const { id: number, serverId } = parseScopedId(head)
      if (!/^\d+$/.test(number)) return null
      const params: RouteParams['prDiff'] = { number: Number(number) }
      if (serverId) params.serverId = serverId
      const cwd = optional(rest.join('/'))
      if (cwd) params.cwd = cwd
      return params
    },
    serialize: (p) => [serializeScopedId(String(p.number), p.serverId), p.cwd ?? '']
      .join('/')
      .replace(/\/+$/, ''),
    // The review leads; its diff pops out beside it, so the activity feed and
    // the change are readable together. Shares the aside with the review's chat.
    placement: 'aside',
    defaultWeight: 0.5,
    component: () => import('../../../components/pr-review/PrDiffPane.svelte'),
  },
  diff: {
    parse: (s) => {
      const [sourceTabId, scope, ...rest] = s.split('/')
      if (!sourceTabId) return null
      return {
        sourceTabId,
        scope: parseDiffScope(scope),
        filePath: optional(rest.join('/')),
      }
    },
    serialize: (p) =>
      [p.sourceTabId, serializeDiffScope(p.scope), p.filePath ?? ''].join('/').replace(/\/+$/, ''),
    placement: 'overlay',
    defaultWeight: 0.6,
    component: () => import('../../../components/diff/DiffPane.svelte'),
  },
  files: {
    parse: (s) => (s ? { sourceId: s } : null),
    serialize: (p) => p.sourceId,
    placement: 'overlay',
    defaultWeight: 0.6,
    component: () => import('../../../components/files/FilesTreePane.svelte'),
  },
  fileEditor: {
    // `<source>/<line|->/<path>`. The line sits in a fixed slot because a path
    // may contain anything a filesystem allows, including a `:12` suffix. A
    // second segment that is neither `-` nor digits is a path segment from a
    // location serialized before the slot existed, so it parses line-less.
    parse: (s) => {
      const [sourceId, marker, ...rest] = s.split('/')
      const hasLineSlot = marker === '-' || /^\d+$/.test(marker ?? '')
      const path = hasLineSlot ? rest.join('/') : [marker, ...rest].join('/')
      if (!sourceId || !path) return null
      const line = hasLineSlot && marker !== '-' ? Number(marker) : undefined
      return line === undefined ? { sourceId, path } : { sourceId, path, line }
    },
    serialize: (p) => `${p.sourceId}/${p.line ?? '-'}/${p.path}`,
    placement: 'overlay',
    defaultWeight: 0.6,
    component: () => import('../../../components/files/FileEditorHostPane.svelte'),
  },
  subagent: {
    parse: (s) => {
      const [sessionSegment, messageId] = s.split('/')
      if (!sessionSegment || !messageId) return null
      const { id, serverId } = parseScopedId(sessionSegment)
      if (!id) return null
      return serverId ? { sessionId: id, messageId, serverId } : { sessionId: id, messageId }
    },
    serialize: (p) => `${serializeScopedId(p.sessionId, p.serverId)}/${p.messageId}`,
    placement: 'overlay',
    defaultWeight: 0.6,
    component: () => import('../../../components/conversation/SubagentHostPane.svelte'),
  },
})

function isRouteName(value: string): value is RouteName {
  return Object.prototype.hasOwnProperty.call(ROUTES, value)
}

export const ROUTE_NAMES = Object.keys(ROUTES).filter(isRouteName)

export function descriptorFor<K extends RouteName>(name: K): RouteDescriptor<K> {
  return ROUTES[name]
}

/** Same destination, same params — used to make navigation idempotent. */
export function sameRoute(a: RouteRef | null, b: RouteRef | null): boolean {
  if (a === b) return true
  if (!a || !b || a.name !== b.name) return false
  return serializeRef(a) === serializeRef(b)
}

export function serializeRef(ref: RouteRef): string {
  // SAFETY: A RouteRef couples each route name to the matching parameter type.
  const segment = (ROUTES[ref.name].serialize as (params: RouteParams[RouteName]) => string)(ref.params)
  return segment ? `${ref.name}/${segment}` : ref.name
}

/** Total: unparseable input yields null so the caller can drop one pane. */
export function parseRef(text: string): RouteRef | null {
  const slash = text.indexOf('/')
  const name = slash === -1 ? text : text.slice(0, slash)
  if (!isRouteName(name)) return null
  const params = ROUTES[name].parse(slash === -1 ? '' : text.slice(slash + 1))
  // SAFETY: The selected descriptor parses the parameter type paired with name.
  return params ? ({ name, params } as RouteRef) : null
}

export function isPageRoute(ref: RouteRef | null | undefined): boolean {
  return !!ref && ROUTES[ref.name].exclusiveGroup === 'page'
}

/** Content the open-in-split action may move between panes. A chat moves by
 *  splitting its tab, and `aside`/`overlay` routes have nowhere else to go. */
export function isMovableRoute(ref: RouteRef | null | undefined): boolean {
  return !!ref && ref.name !== 'chat' && ROUTES[ref.name].placement === 'any'
}

export function isArtifactRoute(ref: RouteRef | null | undefined): boolean {
  return !!ref && ROUTES[ref.name].exclusiveGroup === 'artifact'
}

/** The chat pool's own route: the leading pane's resting state. */
export const CHAT_ROUTE: RouteRef<'chat'> = { name: 'chat', params: {} }

export function chatRoute(sessionId?: string, serverId?: string): RouteRef<'chat'> {
  const params: RouteParams['chat'] = {}
  if (sessionId) params.sessionId = sessionId
  if (serverId) params.serverId = serverId
  return { name: 'chat', params }
}
