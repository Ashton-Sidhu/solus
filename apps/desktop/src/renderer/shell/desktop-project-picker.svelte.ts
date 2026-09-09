import { openProjectStore } from "@solus/workspace-ui/components/servers/open-project.store.svelte";

import { hostOnboardingStore } from "@solus/workspace-ui/components/servers/host-onboarding.store.svelte";
import type { HostOption } from "@solus/workspace-ui/components/servers/lib/open-project-flow";
import {
  isRunOnHostLocked,
  moveTabToHost,
} from "@solus/workspace-ui/components/servers/run-on";

import { projectsStore, serversStore } from "@solus/workspace-ui/contexts";

import {
  withCheckout,
  withHost,
  withProjectHost,
} from "@solus/workspace-ui/contexts/workspace/run-config";
import { toasts } from "@solus/workspace-ui/lib/toasts";

import type { RunConfig } from "@solus/contracts/types";

import { serverConnections } from "@solus/client-core/server-connections";

import { requestInputFocus } from "@solus/workspace-ui/lib/inputFocus";

import type { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
type DesktopAppCore = ReturnType<typeof createAppCore>;
import type { DesktopDialogs } from "./desktop-dialogs.svelte";

export function createDesktopProjectPicker(
  core: DesktopAppCore,
  ui: DesktopDialogs,
  directoryPickerServerId: () => string,
) {
  const { session } = core;
  async function handleDirectorySelected(dir: string) {
    ui.directoryPickerOpen = false;
    if (ui.directoryPickerForOpenProject) {
      await finishBrowsedOpenProject(dir);
      return;
    }
    if (ui.directoryPickerForAddProject) {
      // Read the browsed host before the override is cleared — the project is
      // recorded against the machine the folder is actually on.
      const addServerId = directoryPickerServerId();
      ui.directoryPickerForAddProject = false;
      ui.directoryPickerServerIdOverride = undefined;
      ui.directoryPickerDraftId = undefined;
      const project = await projectsStore.addProject(
        addServerId,
        serverConnections.apiFor(addServerId),
        dir,
      );
      const onProjectAdded = ui.directoryPickerOnProjectAdded;
      ui.directoryPickerOnProjectAdded = undefined;
      if (project) onProjectAdded?.(project);
      return;
    }
    projectsStore.recordProject(directoryPickerServerId(), dir);
    const draftId = ui.directoryPickerDraftId;
    ui.directoryPickerDraftId = undefined;
    if (draftId) {
      const draft = session.sessionDrafts.get(draftId);
      const draftHostOverride = ui.directoryPickerServerIdOverride;
      const draftIntent = ui.directoryPickerIntent;
      ui.directoryPickerServerIdOverride = undefined;
      ui.directoryPickerIntent = "open-project";
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
    const targetTabId = ui.directoryPickerTargetTabId;
    const overrideServerId = ui.directoryPickerServerIdOverride;
    const intent = ui.directoryPickerIntent;
    ui.directoryPickerServerIdOverride = undefined;
    ui.directoryPickerIntent = "open-project";
    if (ui.directoryPickerNewTab) {
      ui.directoryPickerNewTab = false;
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
    ui.directoryPickerTargetTabId = undefined;
    requestInputFocus(targetTabId ? { tabId: targetTabId } : undefined);
  }

  function handleDirectoryPickerClose() {
    ui.directoryPickerOpen = false;
    ui.directoryPickerNewTab = false;
    ui.directoryPickerTargetTabId = undefined;
    ui.directoryPickerServerIdOverride = undefined;
    ui.directoryPickerIntent = "open-project";
    ui.directoryPickerForAddProject = false;
    ui.directoryPickerOnProjectAdded = undefined;
    // Cancelling a browse that the Open project flow started returns to that
    // flow, on the step it left — not to an empty screen.
    if (ui.directoryPickerForOpenProject) {
      ui.directoryPickerForOpenProject = false;
      openProjectStore.back();
      return;
    }
    requestInputFocus();
  }

  /** The tab moves; no session does — nothing has started on it yet. */
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
      isLocalHost: serverId === serverConnections.localServerId(),
      path,
      intent: options.intent ?? "open-project",
    });
  }

  /** The draft equivalent of `placeTabOnHost`: a folder chosen on a host is
   *  that host's project, while a dispatch leaves the project where it is. */
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

  /**
   * Every machine the Open project flow can land a project on, active one
   * first — the flow binds the head of this list, so the chip defaults to the
   * machine you are already working on.
   */
  function openProjectHosts(): HostOption[] {
    const activeId = serversStore.activeServerId;
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

  /** Lands the chosen project in a session on the host that holds it. */
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
    const name = path.split(/[\\/]/).pop() || path;

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
      toasts.info("Git push is not set up", {
        description: pushNote,
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

  /** "Choose location…" — the same folder browser, handed back to the flow. */
  function browseForOpenProject() {
    if (!openProjectStore.serverId) return;
    ui.directoryPickerForOpenProject = true;
    ui.directoryPickerForAddProject = false;
    ui.directoryPickerOnProjectAdded = undefined;
    ui.directoryPickerNewTab = false;
    ui.directoryPickerTargetTabId = undefined;
    ui.directoryPickerServerIdOverride = openProjectStore.serverId;
    ui.directoryPickerIntent = "open-project";
    ui.directoryPickerOpen = true;
  }

  /** A folder chosen for the flow: opened as-is, or used as the clone's parent. */
  async function finishBrowsedOpenProject(dir: string) {
    ui.directoryPickerForOpenProject = false;
    ui.directoryPickerServerIdOverride = undefined;
    ui.directoryPickerIntent = "open-project";
    openProjectStore.back();
    if (openProjectStore.source === "local") {
      await openProjectAtPath(dir, false);
      return;
    }
    const clonedPath = await openProjectStore.cloneInto(dir);
    if (clonedPath) await openProjectAtPath(clonedPath, true);
  }

  return {
    handleDirectorySelected,
    handleDirectoryPickerClose,
    startOpenProject,
    openProjectAtPath,
    browseForOpenProject,
  };
}
