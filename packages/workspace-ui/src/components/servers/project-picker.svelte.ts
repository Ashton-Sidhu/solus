import { onMount } from 'svelte'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import { serverConnections } from '@solus/client-core/server-connections'
import type { RunConfig } from '@solus/contracts/types'
import type { WorkspaceContext } from '../../contexts/workspace/workspace.context.svelte'
import { withCheckout, withHost, withProjectHost } from '../../contexts/workspace/run-config'
import { projectsStore, serversStore } from '../../contexts'
import type { ProjectRef } from '../../contexts/projects/project-catalog'
import { requestInputFocus } from '../../lib/inputFocus'
import { toasts } from '../../lib/toasts'
import { hostOnboardingStore } from './host-onboarding.store.svelte'
import type { HostOption, ProjectSource } from './lib/open-project-flow'
import { openProjectStore } from './open-project.store.svelte'
import { isRunOnHostLocked, moveTabToHost } from './run-on'

type PickerIntent = 'dispatch' | 'open-project'

/** What `solus:open-directory-picker` carries. */
interface DirectoryPickerRequest {
  tabId?: string
  draftId?: string
  /** A tab id or a draft id — the surface that asked, when the emitter
   *  (RunOnPicker) does not know which kind it is scoped to. */
  requesterId?: string
  serverId?: string
  intent?: PickerIntent | 'add-project'
  onProjectAdded?: (project: ProjectRef) => void
}

/**
 * The folder browser and the Open project flow, as desktop and web both use
 * them: who asked, which host is browsed, and where the chosen folder lands —
 * a tab, a draft, a page's project list, or back into the Open project flow.
 * Call it while a component initializes; it listens for the
 * `solus:open-directory-picker` and `solus:open-project` events until unmount.
 */
export function createProjectPicker(session: WorkspaceContext) {
  let directoryPickerOpen = $state(false)
  let directoryPickerNewTab = $state(false)
  let directoryPickerTargetTabId = $state<string | undefined>(undefined)
  /** Set when the browser was opened from a session draft, which has no tab to
   *  retarget — the chosen directory lands on its run config instead. */
  let directoryPickerDraftId = $state<string | undefined>(undefined)
  /** Set when a caller names the host to browse — the "Run on" picker and the
   *  Open project flow both browse a host no tab points at yet. */
  let directoryPickerServerIdOverride = $state<string | undefined>(undefined)
  /** Only the Run on picker turns a cross-host folder choice into a mandatory
   *  session worktree. Opening a remote project uses the normal preference. */
  let directoryPickerIntent = $state<PickerIntent>('open-project')
  /** The Open project flow borrows the browser; its selection is handed back
   *  to that flow instead of retargeting a tab. */
  let directoryPickerForOpenProject = $state(false)
  /** "Open project…" in a page's project switcher borrows it too: the folder is
   *  recorded as a project so pages can scope to it, and no tab is retargeted. */
  let directoryPickerForAddProject = $state(false)
  let directoryPickerOnProjectAdded = $state<((project: ProjectRef) => void) | undefined>(undefined)

  const directoryPickerCreatesTab = $derived(
    directoryPickerNewTab || (!directoryPickerTargetTabId && !!session.activeSession?.agentSessionId),
  )
  const directoryPickerTitle = $derived.by(() => {
    if (directoryPickerForOpenProject) return openProjectStore.browseTitle
    if (directoryPickerForAddProject) return 'Open a project'
    return directoryPickerCreatesTab ? 'Open project in a new tab' : 'Change project folder'
  })
  const directoryPickerAction = $derived.by(() => {
    if (directoryPickerForOpenProject) return openProjectStore.browseAction
    if (directoryPickerForAddProject) return 'Open'
    return directoryPickerCreatesTab ? 'Open in new tab' : 'Choose'
  })
  // Browse the host the tab actually runs on — a new tab inherits the active
  // session's host, so both flows resolve to the same place the commit lands.
  // An explicit override wins: it names a host before any tab points at it.
  const directoryPickerServerId = $derived(
    directoryPickerServerIdOverride ??
      (directoryPickerTargetTabId
        ? session.sessionFor(directoryPickerTargetTabId)?.run.serverId
        : session.activeSession?.run.serverId) ??
      serverConnections.defaultMachineId() ??
      LOCAL_SERVER_ID,
  )
  // apiFor() opens the connection as a side effect, so only reach for the
  // chosen host's api while the picker is actually on screen.
  const directoryPickerApi = $derived.by(() => {
    if (directoryPickerOpen) return serverConnections.apiFor(directoryPickerServerId)
    const idleServerId = serverConnections.defaultMachineId()
    return idleServerId ? serverConnections.apiFor(idleServerId) : undefined
  })
  // The chip names a host only when it is not the one already being worked on.
  const directoryPickerHostLabel = $derived(
    directoryPickerServerId === serversStore.activeServer?.id
      ? undefined
      : serversStore.hostFor(directoryPickerServerId)?.label,
  )
  // Changing an existing tab's folder starts where that tab already is. Every
  // other entry point lets the picker resolve the selected host's projects root.
  const directoryPickerInitialPath = $derived.by(() => {
    const targetSession = directoryPickerTargetTabId ? session.sessionFor(directoryPickerTargetTabId) : null
    // `~` is a folder not chosen yet, so it starts in the projects root too.
    if (targetSession?.run.serverId === directoryPickerServerId && targetSession.run.workingDirectory !== '~') {
      return targetSession.run.workingDirectory
    }
    return undefined
  })

  onMount(() => {
    const directoryPickerHandler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail: DirectoryPickerRequest | undefined = event.detail
      const requesterId = detail?.requesterId
      const requesterDraftId =
        requesterId && session.drafts.sessionDrafts.has(requesterId) ? requesterId : undefined
      directoryPickerDraftId = detail?.draftId ?? requesterDraftId
      const targetTabId = detail?.tabId ?? (requesterDraftId ? undefined : requesterId)
      const tab = targetTabId ? session.tabs[targetTabId] : null
      const opensInNewTab = tab?.sessionId != null
      directoryPickerNewTab = opensInNewTab
      directoryPickerTargetTabId = opensInNewTab ? undefined : targetTabId
      directoryPickerServerIdOverride = detail?.serverId
      // Adding a project retargets nothing, so it keeps the plain open-project
      // run intent and states itself with its own flag.
      const requestedIntent = detail?.intent ?? 'open-project'
      directoryPickerForAddProject = requestedIntent === 'add-project'
      directoryPickerOnProjectAdded = detail?.onProjectAdded
      directoryPickerIntent = requestedIntent === 'add-project' ? 'open-project' : requestedIntent
      directoryPickerForOpenProject = false
      directoryPickerOpen = true
    }
    const openProjectHandler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail: { tabId?: string; source?: ProjectSource; serverId?: string } | undefined = event.detail
      startOpenProject({ sourceId: detail?.tabId, source: detail?.source, serverId: detail?.serverId })
    }
    window.addEventListener('solus:open-directory-picker', directoryPickerHandler)
    window.addEventListener('solus:open-project', openProjectHandler)
    return () => {
      window.removeEventListener('solus:open-directory-picker', directoryPickerHandler)
      window.removeEventListener('solus:open-project', openProjectHandler)
    }
  })

  async function handleDirectorySelected(dir: string) {
    directoryPickerOpen = false
    projectsStore.invalidateRecentProjects()
    if (directoryPickerForOpenProject) {
      await finishBrowsedOpenProject(dir)
      return
    }
    if (directoryPickerForAddProject) {
      // Read the browsed host before the override is cleared — the project is
      // recorded against the machine the folder is actually on.
      const addServerId = directoryPickerServerId
      directoryPickerForAddProject = false
      directoryPickerServerIdOverride = undefined
      directoryPickerDraftId = undefined
      const project = projectsStore.addProject(addServerId, serverConnections.apiFor(addServerId), dir)
      const onProjectAdded = directoryPickerOnProjectAdded
      directoryPickerOnProjectAdded = undefined
      if (project) onProjectAdded?.(project)
      return
    }
    projectsStore.addProject(directoryPickerServerId, serverConnections.apiFor(directoryPickerServerId), dir)
    const draftId = directoryPickerDraftId
    directoryPickerDraftId = undefined
    if (draftId) {
      const draft = session.drafts.sessionDrafts.get(draftId)
      const draftHostOverride = directoryPickerServerIdOverride
      const draftIntent = directoryPickerIntent
      directoryPickerServerIdOverride = undefined
      directoryPickerIntent = 'open-project'
      if (draft) {
        // A browse that started from a host row carries that host with it —
        // the picked folder is a path on that machine, not this one.
        draft.run =
          draftHostOverride && draft.run.serverId !== draftHostOverride
            ? applyHostIntent(draft.run, draftHostOverride, dir, draftIntent)
            : withCheckout(draft.run, dir, null)
        if (draftIntent === 'open-project') draft.task = { kind: 'none' }
        void session.environment.refresh(draft.run.serverId, dir)
      }
      requestInputFocus()
      return
    }
    const targetTabId = directoryPickerTargetTabId
    const overrideServerId = directoryPickerServerIdOverride
    const intent = directoryPickerIntent
    directoryPickerServerIdOverride = undefined
    directoryPickerIntent = 'open-project'
    if (directoryPickerNewTab) {
      directoryPickerNewTab = false
      // A started conversation keeps its folder; the project opens as a new
      // draft beside it. Choosing a host is part of that draft's run config —
      // there is no tab to move, because nothing has started.
      const draft = session.drafts.openSessionDraft({ freshTask: intent === 'open-project' }, dir)
      if (overrideServerId) draft.run = applyHostIntent(draft.run, overrideServerId, dir, intent)
    } else if (
      targetTabId &&
      overrideServerId &&
      session.sessionFor(targetTabId)?.run.serverId !== overrideServerId
    ) {
      // The folder lives on another host, so the tab has to move there too —
      // setBaseDirectory alone would point the current host at a missing path.
      placeTabOnHost(targetTabId, overrideServerId, dir, intent)
    } else {
      await session.config.setBaseDirectory(dir, targetTabId)
    }
    directoryPickerTargetTabId = undefined
    requestInputFocus(targetTabId ? { tabId: targetTabId } : undefined)
  }

  function handleDirectoryPickerClose() {
    directoryPickerOpen = false
    directoryPickerNewTab = false
    directoryPickerTargetTabId = undefined
    directoryPickerDraftId = undefined
    directoryPickerServerIdOverride = undefined
    directoryPickerIntent = 'open-project'
    directoryPickerForAddProject = false
    directoryPickerOnProjectAdded = undefined
    // Cancelling a browse that the Open project flow started returns to that
    // flow, on the step it left — not to an empty screen.
    if (directoryPickerForOpenProject) {
      directoryPickerForOpenProject = false
      openProjectStore.back()
      return
    }
    requestInputFocus()
  }

  /** The tab moves; no session does — nothing has started on it yet. */
  function placeTabOnHost(tabId: string, serverId: string, path: string, intent: PickerIntent = 'open-project') {
    moveTabToHost({
      workspace: session,
      tabId,
      serverId,
      // A browser is not a machine that can host, so this is never true on web.
      isLocalHost: serverId === serverConnections.localServerId(),
      path,
      intent,
    })
  }

  /** The draft equivalent of `placeTabOnHost`: a folder chosen on a host is
   *  that host's project, while a dispatch leaves the project where it is. */
  function applyHostIntent(run: RunConfig, serverId: string, path: string, intent: PickerIntent): RunConfig {
    return intent === 'dispatch' ? withHost(run, serverId, { path }) : withProjectHost(run, serverId, { path })
  }

  /**
   * Every machine the Open project flow can land a project on, active one
   * first — the flow binds the head of this list, so the chip defaults to the
   * machine you are already working on.
   */
  function openProjectHosts(): HostOption[] {
    const activeId = serversStore.activeServer?.id
    return [...serversStore.executionServers].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId))
  }

  function startOpenProject(options: { sourceId?: string; source?: ProjectSource; serverId?: string } = {}) {
    const hosts = openProjectHosts()
    const targetServerId =
      options.serverId ??
      (session.projectPageScope.kind === 'project'
        ? session.projectPageScope.checkout?.serverId
        : options.sourceId
          ? session.runFor(options.sourceId)?.serverId
          : undefined)
    openProjectStore.open(hosts, {
      tabId: options.sourceId,
      source: options.source,
      host: hosts.find((host) => host.id === targetServerId),
      onProjectOpened: session.hasProjectPageOpen
        ? (project) => {
            session.scopeOpenProjectPage(project)
          }
        : undefined,
    })
  }

  /** Lands the chosen project in a session on the host that holds it. */
  async function openProjectAtPath(path: string, source: ProjectSource | null) {
    const cloned = source === 'clone' || source === 'github'
    const serverId = openProjectStore.serverId
    const hostLabel = openProjectStore.hostLabel
    const hostIsLocal = openProjectStore.hostIsLocal
    const tabId = openProjectStore.tabId
    const onProjectOpened = openProjectStore.onProjectOpened
    const pushNote = openProjectStore.pushCapabilityNote
    openProjectStore.close()
    if (!serverId) return

    const project = projectsStore.addProject(serverId, serverConnections.apiFor(serverId), path)
    const name = path.split(/[\\/]/).pop() || path

    // The flow may have been started from a draft (RunOnPicker passes its
    // requester id through `tabId`); re-aim that draft instead of opening a
    // second one and orphaning the prompt already typed into it.
    const requesterDraft = tabId ? session.drafts.sessionDrafts.get(tabId) : undefined
    // A started session keeps its folder — the project opens beside it instead.
    const reusableTabId =
      !requesterDraft && tabId && session.tabs[tabId] && !isRunOnHostLocked(session.sessionFor(tabId))
        ? tabId
        : null
    // A reusable tab is moved across; with none, the project opens as a draft
    // that simply names the host it will run on.
    if (onProjectOpened && project) {
      onProjectOpened(project)
    } else if (requesterDraft) {
      requesterDraft.run = withProjectHost(withCheckout(requesterDraft.run, path, null), serverId, { path })
      requesterDraft.task = { kind: 'none' }
      void session.environment.refresh(serverId, path)
      requestInputFocus()
    } else if (reusableTabId) {
      placeTabOnHost(reusableTabId, serverId, path)
      requestInputFocus({ tabId: reusableTabId })
    } else {
      const draft = session.drafts.openSessionDraft({ freshTask: true }, path)
      draft.run = withProjectHost(draft.run, serverId, { path })
      requestInputFocus()
    }

    // A clone that authenticated as nobody works right up until the push, which
    // is 25 minutes away at PR time. Say so now, without blocking the session.
    if (pushNote) {
      const onboardingHost = { id: serverId, label: hostLabel || serverId }
      toasts.info('Git push is not set up', {
        description: pushNote,
        actions: [{ label: 'Set up', onAction: () => hostOnboardingStore.open(onboardingHost) }],
      })
      return
    }

    if (source === 'local' && hostIsLocal) return
    const verb = cloned ? 'Cloned' : source === 'new' ? 'Created' : 'Opened'
    toasts.success(`${verb} ${name} on ${hostLabel || 'host'}`, {
      actions: [{ label: 'Copy path', onAction: () => void navigator.clipboard?.writeText(path) }],
    })
  }

  /** "Open an existing folder" and "Change" — the same folder browser, handed back to the flow. */
  function browseForOpenProject() {
    if (!openProjectStore.serverId) return
    directoryPickerForOpenProject = true
    directoryPickerForAddProject = false
    directoryPickerOnProjectAdded = undefined
    directoryPickerNewTab = false
    directoryPickerTargetTabId = undefined
    directoryPickerServerIdOverride = openProjectStore.serverId
    directoryPickerIntent = 'open-project'
    directoryPickerOpen = true
  }

  /** A folder chosen for the flow: opened as-is, or used as the clone's parent. */
  async function finishBrowsedOpenProject(dir: string) {
    directoryPickerForOpenProject = false
    directoryPickerServerIdOverride = undefined
    directoryPickerIntent = 'open-project'
    openProjectStore.back()
    if (openProjectStore.source === 'local') {
      await openProjectAtPath(dir, 'local')
      return
    }
    // A new project only takes the folder as its location; "Create" still commits.
    if (openProjectStore.source === 'new') {
      openProjectStore.newProjectParent = dir
      return
    }
    const clonedPath = await openProjectStore.cloneInto(dir)
    if (clonedPath) await openProjectAtPath(clonedPath, openProjectStore.source)
  }

  return {
    get directoryPickerOpen() { return directoryPickerOpen },
    set directoryPickerOpen(value: boolean) { directoryPickerOpen = value },
    get directoryPickerTitle() { return directoryPickerTitle },
    get directoryPickerAction() { return directoryPickerAction },
    get directoryPickerApi() { return directoryPickerApi },
    get directoryPickerHostLabel() { return directoryPickerHostLabel },
    get directoryPickerServerId() { return directoryPickerServerId },
    get directoryPickerInitialPath() { return directoryPickerInitialPath },
    startOpenProject,
    handleDirectorySelected,
    handleDirectoryPickerClose,
    openProjectAtPath,
    browseForOpenProject,
  }
}
