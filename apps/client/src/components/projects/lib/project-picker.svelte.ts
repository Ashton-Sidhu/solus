import { onMount, untrack } from 'svelte'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import { serverConnections } from '@solus/client-core/server-connections'
import type { RunConfig } from '@solus/contracts/types'
import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'
import { withCheckout, withHost, withProjectHost } from '@solus/workspace-ui/contexts/workspace/run-config'
import { projectsStore, serversStore } from '@solus/workspace-ui/contexts'
import type { ProjectRef } from '@solus/workspace-ui/contexts/projects/project-catalog'
import { openProjectStore } from '@solus/workspace-ui/components/servers/open-project.store.svelte'
import { hostOnboardingStore } from '@solus/workspace-ui/components/servers/host-onboarding.store.svelte'
import { hostSetupStore } from '@solus/workspace-ui/components/servers/host-setup.store.svelte'
import { moveTabToHost, isRunOnHostLocked } from '@solus/workspace-ui/components/servers/run-on'
import { requestInputFocus } from '@solus/workspace-ui/lib/inputFocus'
import { toasts } from '@solus/workspace-ui/lib/toasts'

export function createWebProjectPicker(session: WorkspaceContext) {
  let directoryPickerOpen = $state(false);
  let directoryPickerNewTab = $state(false);
  let directoryPickerTargetTabId = $state<string | undefined>(undefined);
  let directoryPickerDraftId = $state<string | undefined>(undefined);
  let directoryPickerServerIdOverride = $state<string | undefined>(undefined);
  let directoryPickerIntent = $state<"dispatch" | "open-project">("open-project");
  let directoryPickerForOpenProject = $state(false);
  let directoryPickerForAddProject = $state(false);
  let directoryPickerOnProjectAdded = $state<
    ((project: ProjectRef) => void) | undefined
  >(undefined);
  const directoryPickerCreatesTab = $derived(
    directoryPickerNewTab ||
      (!directoryPickerTargetTabId && !!session.activeSession?.agentSessionId),
  );
  const directoryPickerTitle = $derived.by(() => {
    if (directoryPickerForOpenProject) {
      return openProjectStore.source === "local"
        ? "Open a folder"
        : "Choose where to clone";
    }
    if (directoryPickerForAddProject) return "Add a project";
    return directoryPickerCreatesTab
      ? "Open project in a new tab"
      : "Change project folder";
  });
  const directoryPickerAction = $derived.by(() => {
    if (directoryPickerForOpenProject) {
      return openProjectStore.source === "local" ? "Open" : "Clone here";
    }
    if (directoryPickerForAddProject) return "Add project";
    return directoryPickerCreatesTab ? "Open in new tab" : "Choose";
  });
  const directoryPickerServerId = $derived(
    directoryPickerServerIdOverride ??
      (directoryPickerTargetTabId
        ? session.sessionFor(directoryPickerTargetTabId)?.run.serverId
        : session.activeSession?.run.serverId) ??
      serverConnections.defaultServerId() ??
      LOCAL_SERVER_ID,
  );
  const directoryPickerApi = $derived.by(() => {
    if (directoryPickerOpen) {
      return serverConnections.apiFor(directoryPickerServerId);
    }
    const bootServerId = serverConnections.defaultServerId();
    return bootServerId ? serverConnections.apiFor(bootServerId) : undefined;
  });
  const directoryPickerHostLabel = $derived.by(() => {
    const host = serversStore.hostFor(directoryPickerServerId);
    return host && !host.local ? host.label : undefined;
  });
  const directoryPickerInitialPath = $derived.by(() => {
    const targetSession = directoryPickerTargetTabId
      ? session.sessionFor(directoryPickerTargetTabId)
      : null;
    if (targetSession?.run.serverId === directoryPickerServerId) {
      return targetSession.run.workingDirectory;
    }
    return undefined;
  });

  onMount(() => {
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: {
          tabId?: string;
          draftId?: string;
                  requesterId?: string;
          serverId?: string;
          intent?: "dispatch" | "open-project" | "add-project";
          onProjectAdded?: (project: ProjectRef) => void;
        } | undefined = event.detail;
      const requesterId = detail?.requesterId;
      const requesterDraftId =
        requesterId && session.sessionDrafts.has(requesterId)
          ? requesterId
          : undefined;
      directoryPickerDraftId = detail?.draftId ?? requesterDraftId;
      const targetTabId =
        detail?.tabId ?? (requesterDraftId ? undefined : requesterId);
      const tab = targetTabId ? session.tabs[targetTabId] : null;
      const opensInNewTab = tab?.sessionId != null;
      directoryPickerNewTab = opensInNewTab;
      directoryPickerTargetTabId = opensInNewTab ? undefined : targetTabId;
      directoryPickerServerIdOverride = detail?.serverId;
      // Adding a project retargets nothing, so it keeps the plain open-project
      // run intent and states itself with its own flag.
      const requestedIntent = detail?.intent ?? "open-project";
      directoryPickerForAddProject = requestedIntent === "add-project";
      directoryPickerOnProjectAdded = detail?.onProjectAdded;
      directoryPickerIntent =
        requestedIntent === "add-project" ? "open-project" : requestedIntent;
      directoryPickerForOpenProject = false;
      directoryPickerOpen = true;
    };
    const openProjectHandler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: { tabId?: string } | undefined = event.detail;
      startOpenProject({ sourceId: detail?.tabId });
    };
    // The nearby-host discovery toast fires from a store, which has no way to
    // reach the settings pane on its own.
    const showConnectionsHandler = () => session.showSettings("api-access");
    window.addEventListener("solus:open-directory-picker", handler);
    window.addEventListener("solus:open-project", openProjectHandler);
    window.addEventListener("solus:show-connections", showConnectionsHandler);
    return () => {
      window.removeEventListener("solus:open-directory-picker", handler);
      window.removeEventListener("solus:open-project", openProjectHandler);
      window.removeEventListener(
        "solus:show-connections",
        showConnectionsHandler,
      );
    };
  });

  async function handleDirectorySelected(dir: string) {
    directoryPickerOpen = false;
    projectsStore.invalidateRecentProjects();
    if (directoryPickerForOpenProject) {
      await finishBrowsedOpenProject(dir);
      return;
    }
    if (directoryPickerForAddProject) {
      // Read the browsed host before the override is cleared — the project is
      // recorded against the machine the folder is actually on.
      const addServerId = directoryPickerServerId;
      directoryPickerForAddProject = false;
      directoryPickerServerIdOverride = undefined;
      directoryPickerDraftId = undefined;
      const project = await projectsStore.addProject(
        addServerId,
        serverConnections.apiFor(addServerId),
        dir,
      );
      const onProjectAdded = directoryPickerOnProjectAdded;
      directoryPickerOnProjectAdded = undefined;
      if (project) onProjectAdded?.(project);
      return;
    }
    projectsStore.recordProject(directoryPickerServerId, dir);
    const draftId = directoryPickerDraftId;
    directoryPickerDraftId = undefined;
    if (draftId) {
      const draft = session.sessionDrafts.get(draftId);
      const draftHostOverride = directoryPickerServerIdOverride;
      const draftIntent = directoryPickerIntent;
      directoryPickerServerIdOverride = undefined;
      directoryPickerIntent = "open-project";
      if (draft) {
        // A browse that started from a host row carries that host with it —
        // the picked folder is a path on that machine, not this one.
        draft.run =
          draftHostOverride && draft.run.serverId !== draftHostOverride
            ? applyHostIntent(draft.run, draftHostOverride, dir, draftIntent)
            : withCheckout(draft.run, dir, null);
        if (draftIntent === "open-project") draft.task = { kind: "new" };
        void session.environment.refresh(dir);
      }
      requestInputFocus();
      return;
    }
    const targetTabId = directoryPickerTargetTabId;
    const overrideServerId = directoryPickerServerIdOverride;
    const intent = directoryPickerIntent;
    directoryPickerServerIdOverride = undefined;
    directoryPickerIntent = "open-project";
    if (directoryPickerNewTab) {
      directoryPickerNewTab = false;
      // A started conversation keeps its folder; the project opens as a new
      // draft beside it. Choosing a host is part of that draft's run config —
      // there is no tab to move, because nothing has started.
      const draft = session.openSessionDraft(
        { freshTask: intent === "open-project" },
        dir,
      );
      if (overrideServerId) {
        draft.run = applyHostIntent(draft.run, overrideServerId, dir, intent);
      }
    } else if (
      targetTabId &&
      overrideServerId &&
      session.sessionFor(targetTabId)?.run.serverId !== overrideServerId
    ) {
      // The folder lives on another host, so the tab has to move there too —
      // setBaseDirectory alone would point the current host at a missing path.
      placeTabOnHost(targetTabId, overrideServerId, dir, { intent });
    } else {
      await session.setBaseDirectory(dir, targetTabId);
    }
    directoryPickerTargetTabId = undefined;
    requestInputFocus(targetTabId ? { tabId: targetTabId } : undefined);
  }

  function handleDirectoryPickerClose() {
    directoryPickerOpen = false;
    directoryPickerNewTab = false;
    directoryPickerTargetTabId = undefined;
    directoryPickerDraftId = undefined;
    directoryPickerServerIdOverride = undefined;
    directoryPickerIntent = "open-project";
    directoryPickerForAddProject = false;
    directoryPickerOnProjectAdded = undefined;
    // Cancelling a browse that the Open project flow started returns to that
    // flow, on the step it left — not to an empty screen.
    if (directoryPickerForOpenProject) {
      directoryPickerForOpenProject = false;
      openProjectStore.back();
      return;
    }
    requestInputFocus();
  }

  function placeTabOnHost(
    tabId: string,
    serverId: string,
    path: string,
    options: { intent?: "dispatch" | "open-project" } = {},
  ) {
    moveTabToHost({
      workspace: session,
      tabId,
      serverId,
      // A browser is not a machine that can host, so this is never true on web.
      isLocalHost: serverId === serverConnections.localServerId(),
      path,
      intent: options.intent ?? "open-project",
    });
  }

  function applyHostIntent(
    run: RunConfig,
    serverId: string,
    path: string,
    intent: "dispatch" | "open-project",
  ): RunConfig {
    return intent === "dispatch"
      ? withHost(run, serverId, { path })
      : withProjectHost(run, serverId, { path });
  }

  function openProjectHosts() {
    const activeId = serversStore.activeServer?.id;
    return [...serversStore.servers].sort(
      (a, b) => Number(b.id === activeId) - Number(a.id === activeId),
    );
  }

  function startOpenProject(options: { sourceId?: string } = {}) {
    const hosts = openProjectHosts();
    const targetServerId =
      session.projectPageScope.kind === "project"
        ? session.projectPageScope.project.serverId
        : options.sourceId
          ? session.runFor(options.sourceId)?.serverId
          : undefined;
    openProjectStore.open(hosts, {
      tabId: options.sourceId,
      host: hosts.find((host) => host.id === targetServerId),
      onProjectOpened: session.hasProjectPageOpen
        ? (project) => {
            session.scopeOpenProjectPage(project);
          }
        : undefined,
    });
  }

  async function openProjectAtPath(path: string, cloned: boolean) {
    const serverId = openProjectStore.serverId;
    const hostLabel = openProjectStore.hostLabel;
    const hostIsLocal = openProjectStore.hostIsLocal;
    const tabId = openProjectStore.tabId;
    const onProjectOpened = openProjectStore.onProjectOpened;
    const pushNote = openProjectStore.pushCapabilityNote;
    openProjectStore.close();
    if (!serverId) return;

    const project = projectsStore.recordProject(serverId, path);

    // The flow may have been started from a draft (RunOnPicker passes its
    // requester id through `tabId`); re-aim that draft instead of opening a
    // second one and orphaning the prompt already typed into it.
    const requesterDraft = tabId ? session.sessionDrafts.get(tabId) : undefined;
    // A started session keeps its folder — the project opens beside it instead.
    const reusableTabId =
      !requesterDraft &&
      tabId &&
      session.tabs[tabId] &&
      !isRunOnHostLocked(session.sessionFor(tabId))
        ? tabId
        : null;
    // A reusable tab is moved across; with none, the project opens as a draft
    // that simply names the host it will run on.
    if (onProjectOpened && project) {
      onProjectOpened(project);
    } else if (requesterDraft) {
      requesterDraft.run = withProjectHost(
        withCheckout(requesterDraft.run, path, null),
        serverId,
        { path },
      );
      requesterDraft.task = { kind: "new" };
      void session.environment.refresh(path);
      requestInputFocus();
    } else if (reusableTabId) {
      placeTabOnHost(reusableTabId, serverId, path);
      requestInputFocus({ tabId: reusableTabId });
    } else {
      const draft = session.openSessionDraft({ freshTask: true }, path);
      draft.run = withProjectHost(draft.run, serverId, { path });
      requestInputFocus();
    }

    // A clone that authenticated as nobody works right up until the push, which
    // is 25 minutes away at PR time. Say so now, without blocking the session.
    if (pushNote) {
      const onboardingHost = { id: serverId, label: hostLabel || serverId };
      toasts.info(pushNote, {
        actions: [
          {
            label: "Set up",
            onAction: () => hostOnboardingStore.open(onboardingHost),
          },
        ],
      });
      return;
    }

    if (!cloned && hostIsLocal) return;
    const name = path.split(/[\\/]/).pop();
    toasts.success(
      cloned
        ? `Cloned ${name} on ${hostLabel || "host"}`
        : `Opened ${name} on ${hostLabel || "host"}`,
      {
        actions: [
          {
            label: "Copy path",
            onAction: () => void navigator.clipboard?.writeText(path),
          },
        ],
      },
    );
  }

  function browseForOpenProject() {
    if (!openProjectStore.serverId) return;
    directoryPickerForOpenProject = true;
    directoryPickerForAddProject = false;
    directoryPickerOnProjectAdded = undefined;
    directoryPickerNewTab = false;
    directoryPickerTargetTabId = undefined;
    directoryPickerServerIdOverride = openProjectStore.serverId;
    directoryPickerIntent = "open-project";
    directoryPickerOpen = true;
  }

  async function finishBrowsedOpenProject(dir: string) {
    directoryPickerForOpenProject = false;
    directoryPickerServerIdOverride = undefined;
    directoryPickerIntent = "open-project";
    openProjectStore.back();
    if (openProjectStore.source === "local") {
      await openProjectAtPath(dir, false);
      return;
    }
    const clonedPath = await openProjectStore.cloneInto(dir);
    if (clonedPath) await openProjectAtPath(clonedPath, true);
  }

  const identityServerId = $derived(
    openProjectStore.isOpen ? serverConnections.defaultServerId() : null,
  );
  const localGitIdentity = $derived(
    identityServerId ? hostSetupStore.readinessByHost[identityServerId]?.git.identity ?? null : null,
  );
  $effect(() => {
    const serverId = identityServerId;
    if (!serverId) return;
    untrack(() => {
      if (!hostSetupStore.hasProbed(serverId)) void hostSetupStore.probeHost(serverId);
    });
  });

  return {
    get directoryPickerOpen() { return directoryPickerOpen; },
    get directoryPickerTitle() { return directoryPickerTitle; },
    get directoryPickerAction() { return directoryPickerAction; },
    get directoryPickerApi() { return directoryPickerApi; },
    get directoryPickerHostLabel() { return directoryPickerHostLabel; },
    get directoryPickerServerId() { return directoryPickerServerId; },
    get directoryPickerInitialPath() { return directoryPickerInitialPath; },
    get localGitIdentity() { return localGitIdentity; },
    set directoryPickerOpen(value: boolean) { directoryPickerOpen = value; },
    startOpenProject,
    handleDirectorySelected,
    handleDirectoryPickerClose,
    openProjectAtPath,
    browseForOpenProject,
  };
}
