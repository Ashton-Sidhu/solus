import type { Component } from 'svelte'
import type { DiffScope } from '../../../../shared/types'

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
  /** The conversation. No `tabId` means the active-tab pool; a `tabId` pins one
   *  chat. `sessionId` is the agent's own id — what a notification knows about
   *  a conversation, resolved to whichever tab is holding it. */
  chat: { tabId?: string; sessionId?: string }
  tasks: Record<string, never>
  task: { taskId: string }
  prs: { projectPath?: string }
  reviewMode: Record<string, never>
  settings: { tab?: SettingsTab; projectCwd?: string }
  folio: Record<string, never>
  automations: { automationId?: string }
  plan: { planId: string | null }
  work: { workId: string }
  automation: { automationId: string | null }
  goal: { tabId: string }
  review: { key: string; scope: 'branch' | 'session'; sourceTabId?: string }
  prReview: { number: number; title?: string; cwd?: string }
  prDiff: { number: number; cwd?: string }
  // The working directory and checkout a viewer runs against are derived from
  // its source tab's environment, not carried: they are live Git state, and a
  // route that pinned them would go stale the moment the branch moved.
  diff: { sourceTabId: string; scope?: DiffScope; filePath?: string }
  files: { sourceTabId: string }
  fileEditor: { sourceTabId: string; path: string; line?: number }
  subagent: { tabId: string; messageId: string }
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
  resolve?: (params: RouteParams[K], ctx: RouteResolveContext) => Promise<unknown>
}

/** What a descriptor's `resolve` is handed: the IPC surface plus the caller's
 *  project scope, with no reference back to the pane it is filling. */
export interface RouteResolveContext {
  api: typeof window.solus
  ipc: (cwd?: string) => import('../../../../shared/types').IpcContext
}

type RouteTable = { [K in RouteName]: RouteDescriptor<K> }

function defineRoutes(routes: RouteTable): RouteTable {
  return routes
}

const optional = (value: string): string | undefined => value || undefined

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
    return {
      kind: 'pr',
      baseSha: fields[0],
      ...(fields[1] ? { ownDeltaBaseSha: fields[1] } : {}),
      ...(/^\d+$/.test(fields[2] ?? '') ? { parentPr: Number(fields[2]) } : {}),
    }
  }
  return { kind: 'session' }
}

export const ROUTES = defineRoutes({
  chat: {
    parse: (s) => (s.startsWith('@') ? { sessionId: s.slice(1) } : { tabId: optional(s) }),
    serialize: (p) => (p.tabId ? p.tabId : p.sessionId ? `@${p.sessionId}` : ''),
    placement: 'any',
    // The pool owns a chat's lifecycle: the leading pane renders it hidden
    // rather than unmounted, so navigation never tears a conversation down.
    // A chat pinned into a companion pane still mounts through the outlet.
    keepAlive: true,
    component: () => import('../../../components/conversation/ConversationPane.svelte'),
  },
  tasks: {
    parse: () => ({}),
    serialize: () => '',
    placement: 'any',
    exclusiveGroup: 'page',
    component: () => import('../../../components/tasks/TasksPage.svelte'),
  },
  // One task, deep-linkable. It replaces the list in place rather than sitting
  // beside it: the page is the full-width two-column detail, and its own
  // breadcrumb is the way back.
  task: {
    parse: (s) => (s ? { taskId: s } : null),
    serialize: (p) => p.taskId,
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
    component: () => import('../../../components/prs/PrsPage.svelte'),
  },
  reviewMode: {
    parse: () => ({}) as Record<string, never>,
    serialize: () => '',
    placement: 'any',
    exclusiveGroup: 'page',
    ownsTitlebarChrome: true,
    component: () => import('../../../components/review-mode/ReviewModeHost.svelte'),
  },
  settings: {
    parse: (s) => {
      const [tab, ...cwd] = s.split('/')
      if (tab && !isSettingsTab(tab)) return null
      return {
        tab: optional(tab),
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
    parse: () => ({}) as Record<string, never>,
    serialize: () => '',
    placement: 'any',
    exclusiveGroup: 'page',
    // The facet rail is its own surface colour and paints to the window's top
    // edge, so an outlet-level pad would read as the rail failing to reach it.
    // The rail and the head clear the window controls inside themselves.
    ownsTitlebarChrome: true,
    component: () => import('../../../components/workspace/WorkspacePage.svelte'),
  },
  automations: {
    parse: (s) => ({ automationId: optional(s) }),
    serialize: (p) => p.automationId ?? '',
    placement: 'any',
    exclusiveGroup: 'page',
    component: () => import('../../../components/automations/AutomationsPage.svelte'),
  },
  plan: {
    // A streamed plan has no id yet — the gallery preview fills the pane — so
    // an empty segment is a valid location, not a parse failure.
    parse: (s) => ({ planId: s || null }),
    serialize: (p) => p.planId ?? '',
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
    parse: (s) => ({ automationId: s || null }),
    serialize: (p) => p.automationId ?? '',
    placement: 'any',
    exclusiveGroup: 'artifact',
    component: () => import('../../../components/automations/AutomationPane.svelte'),
  },
  goal: {
    parse: (s) => (s ? { tabId: s } : null),
    serialize: (p) => p.tabId,
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
      const [number, ...rest] = s.split('/')
      if (!/^\d+$/.test(number)) return null
      return { number: Number(number), cwd: optional(rest.join('/')) }
    },
    // The title is display-only: it is superseded by the resolved review, so it
    // stays out of the URL rather than becoming a stale thing to keep in sync.
    serialize: (p) => (p.cwd ? `${p.number}/${p.cwd}` : String(p.number)),
    // A pull request is a place inside the list, not a panel beside it: opening
    // one replaces the list in the leading pane, and the chrome band's crumb —
    // not a second copy of the list in a sidebar — is the way back and sideways.
    placement: 'any',
    exclusiveGroup: 'page',
    ownsTitlebarChrome: true,
    component: () => import('../../../components/pr-review/PrReviewRoutePane.svelte'),
    resolve: (params, ctx) => ctx.api.prOpenReview(ctx.ipc(params.cwd), params.number),
  },
  prDiff: {
    parse: (s) => {
      const [number, ...rest] = s.split('/')
      if (!/^\d+$/.test(number)) return null
      return { number: Number(number), cwd: optional(rest.join('/')) }
    },
    serialize: (p) => (p.cwd ? `${p.number}/${p.cwd}` : String(p.number)),
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
    parse: (s) => (s ? { sourceTabId: s } : null),
    serialize: (p) => p.sourceTabId,
    placement: 'overlay',
    defaultWeight: 0.6,
    component: () => import('../../../components/files/FilesTreePane.svelte'),
  },
  fileEditor: {
    // `<tab>/<line|->/<path>`. The line sits in a fixed slot because a path may
    // contain anything a filesystem allows, including a `:12` suffix. A second
    // segment that is neither `-` nor digits is a path segment from a location
    // serialized before the slot existed, so it parses as a line-less open.
    parse: (s) => {
      const [sourceTabId, marker, ...rest] = s.split('/')
      const hasLineSlot = marker === '-' || /^\d+$/.test(marker ?? '')
      const path = hasLineSlot ? rest.join('/') : [marker, ...rest].join('/')
      if (!sourceTabId || !path) return null
      const line = hasLineSlot && marker !== '-' ? Number(marker) : undefined
      return line === undefined ? { sourceTabId, path } : { sourceTabId, path, line }
    },
    serialize: (p) => `${p.sourceTabId}/${p.line ?? '-'}/${p.path}`,
    placement: 'overlay',
    defaultWeight: 0.6,
    component: () => import('../../../components/files/FileEditorHostPane.svelte'),
  },
  subagent: {
    parse: (s) => {
      const [tabId, messageId] = s.split('/')
      return tabId && messageId ? { tabId, messageId } : null
    },
    serialize: (p) => `${p.tabId}/${p.messageId}`,
    placement: 'overlay',
    defaultWeight: 0.6,
    component: () => import('../../../components/conversation/SubagentHostPane.svelte'),
  },
})

export const ROUTE_NAMES = Object.keys(ROUTES) as RouteName[]

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
  const segment = (ROUTES[ref.name].serialize as (p: unknown) => string)(ref.params)
  return segment ? `${ref.name}/${segment}` : ref.name
}

/** Total: unparseable input yields null so the caller can drop one pane. */
export function parseRef(text: string): RouteRef | null {
  const slash = text.indexOf('/')
  const name = (slash === -1 ? text : text.slice(0, slash)) as RouteName
  if (!Object.prototype.hasOwnProperty.call(ROUTES, name)) return null
  const params = ROUTES[name].parse(slash === -1 ? '' : text.slice(slash + 1))
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

export function chatRoute(tabId?: string): RouteRef<'chat'> {
  return { name: 'chat', params: tabId ? { tabId } : {} }
}

/** The tab a chat route shows, given which tab the pool is currently on. */
export function chatTabOf(ref: RouteRef | null | undefined, activeTabId: string): string | null {
  if (ref?.name !== 'chat') return null
  return ref.params.tabId ?? activeTabId ?? null
}
