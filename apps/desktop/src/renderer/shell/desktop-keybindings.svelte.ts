import { checkAllUpdates } from "@solus/workspace-ui/contexts/updates/check-all-updates";
import type { ProjectRef } from "@solus/workspace-ui/contexts/projects/project-catalog";

import { connectionsStore, serversStore, updatesStore } from "@solus/workspace-ui/contexts";

import { toasts } from "@solus/workspace-ui/lib/toasts";

import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";

import { localApi } from "@solus/client-core/local-api";

import { useKeybinding } from "@solus/workspace-ui/lib/keybindings/use-keybinding.svelte";

import { requestInputFocus } from "@solus/workspace-ui/lib/inputFocus";

import {
  branchKeyFor,
  buildTabSections,
} from "@solus/workspace-ui/lib/sessionUtils";

import type { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
type DesktopAppCore = ReturnType<typeof createAppCore>;
import type { DesktopDialogs } from "./desktop-dialogs.svelte";
import type { DesktopWindow } from "./desktop-window.svelte";
interface DesktopKeyboardActions {
  startOpenProject(options?: { sourceId?: string }): void;
  handleScreenshot(tabId?: string): Promise<void>;
  handleAttachFile(tabId?: string): Promise<void>;
  handleDesignMode(tabId?: string): Promise<void>;
}

export function installDesktopKeybindings(
  core: DesktopAppCore,
  windowCtx: DesktopWindow,
  ui: DesktopDialogs,
  actions: DesktopKeyboardActions,
) {
  const { settings, planStore, sessionEnvironmentStore, session, keybindings } =
    core;
  const {
    startOpenProject,
    handleScreenshot,
    handleAttachFile,
    handleDesignMode,
  } = actions;
  const viewMode = $derived(windowCtx.viewMode);
  const isEditorMode = $derived(viewMode === "editor");
  const activeTabId = $derived(session.activeTabId);
  const keyboardTabId = $derived(session.focusedChatTabId ?? activeTabId);
  const desktopHandlersAvailable = $derived(
    connectionsStore.desktopHandlersAvailable,
  );
  const visibleTabOrder = $derived(
    session.tabOrder.filter((id) => session.tabs[id]),
  );
  // Tabs of the active branch, in the same visual (grouped) order the tab strip
  // shows — so next/prev-session cycles what the user sees. Filtering the raw
  // backend tabOrder here would diverge from the strip whenever tabs are grouped
  // by status/unread. Computed lazily on keypress (like navigateTab) rather than
  // as a $derived that recomputes on every backend status tick.
  function scopedSessionTabOrder(): string[] {
    const activeKey = branchKeyFor(session.sessionFor(activeTabId));
    return visualTabOrder(visibleTabOrder).filter(
      (id) => branchKeyFor(session.sessionFor(id)) === activeKey,
    );
  }
  useKeybinding("global.open-host-project", () => {
    const pageServerId =
      session.projectPageScope.kind === "project"
        ? session.projectPageScope.project.serverId
        : serversStore.activeServerId;
    if (session.hasProjectPageOpen) {
      window.dispatchEvent(
        new CustomEvent("solus:open-directory-picker", {
          detail: {
            intent: "add-project",
            serverId: pageServerId,
            onProjectAdded: (project: ProjectRef) => {
              session.scopeOpenProjectPage(project);
            },
          },
        }),
      );
      return;
    }
    window.dispatchEvent(
      new CustomEvent("solus:open-directory-picker", {
        detail: {
          requesterId: session.focusedSourceId ?? undefined,
          serverId:
            session.runFor(session.focusedSourceId ?? "")?.serverId ??
            serversStore.activeServerId,
        },
      }),
    );
  });
  useKeybinding("global.select-project", () => {
    startOpenProject({ sourceId: session.focusedSourceId ?? undefined });
  });
  useKeybinding("global.new-task", () => {
    session.openSessionDraft({ freshTask: true, via: "keybinding" });
  });
  useKeybinding("global.new-session-without-task", () => {
    session.openSessionDraft({ withoutTask: true, via: "keybinding" });
  });
  useKeybinding("global.new-session", () => {
    session.openSessionDraft({ via: "keybinding" });
  });
  // Files a task in the active session's project. The tasks page binds this id
  // too — it knows which project its header is pinned to — so this handler
  // stands down while that page is up.
  useKeybinding(
    "global.create-task",
    () => {
      const taskCwd = session.tasksProjectCwd;
      if (taskCwd) session.openTaskComposer(taskCwd, true);
    },
    {
      enabled: () => !!session.tasksProjectCwd && !session.router.at("tasks"),
    },
  );

  function visualTabOrder(tabIds: string[]): string[] {
    return buildTabSections(
      tabIds,
      session.tabGroupMode,
      (id) => session.resolveTab(id),
      planStore.plans,
    ).flatMap((s) => s.tabIds);
  }

  function visualBranchTabOrder(): string[] {
    const visualOrder = visualTabOrder(visibleTabOrder);
    const fallbackByBranch = new Map<string, string>();
    const targetByBranch = new Map<string, string>();
    for (const tabId of visualOrder) {
      const key = branchKeyFor(session.sessionFor(tabId));
      if (!fallbackByBranch.has(key)) fallbackByBranch.set(key, tabId);
      const target = session.lastActiveTabForBranch(key);
      if (target && visualOrder.includes(target)) {
        targetByBranch.set(key, target);
      }
    }
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const tabId of visualOrder) {
      const key = branchKeyFor(session.sessionFor(tabId));
      const target = targetByBranch.get(key) ?? fallbackByBranch.get(key);
      if (!target || tabId !== target || seen.has(key)) continue;
      seen.add(key);
      ordered.push(tabId);
    }
    return ordered;
  }

  function navigateTab(delta: 1 | -1) {
    // The tab strip reorders tabs into grouping sections (status / unread), so
    // next/prev-tab must follow that visual order — not the raw backend tabOrder —
    // or the shortcut jumps to a tab that isn't visually adjacent. Computed lazily
    // here (only on keypress) rather than as a $derived that recomputes on every
    // backend tick.
    const order = isEditorMode
      ? visualBranchTabOrder()
      : visualTabOrder(visibleTabOrder);
    const activeKey = branchKeyFor(session.sessionFor(activeTabId));
    const idx = isEditorMode
      ? order.findIndex(
          (id) => branchKeyFor(session.sessionFor(id)) === activeKey,
        )
      : order.indexOf(activeTabId);
    if (idx === -1) return;
    const nextId = order[(idx + delta + order.length) % order.length];
    const target = isEditorMode
      ? (session.lastActiveTabForBranch(
          branchKeyFor(session.sessionFor(nextId)),
        ) ?? nextId)
      : nextId;
    session.selectTab(target, "keybinding");
    requestInputFocus();
  }

  useKeybinding("global.next-tab", () => navigateTab(1));
  useKeybinding("global.prev-tab", () => navigateTab(-1));
  useKeybinding("global.next-session", () => {
    // Pill mode has no branch/session split — fall back to cycling tabs.
    if (!isEditorMode) return navigateTab(1);
    const order = scopedSessionTabOrder();
    const idx = order.indexOf(activeTabId);
    if (idx !== -1) {
      session.selectTab(order[(idx + 1) % order.length], "keybinding");
      requestInputFocus();
    }
  });
  useKeybinding("global.prev-session", () => {
    if (!isEditorMode) return navigateTab(-1);
    const order = scopedSessionTabOrder();
    const idx = order.indexOf(activeTabId);
    if (idx !== -1) {
      session.selectTab(
        order[(idx - 1 + order.length) % order.length],
        "keybinding",
      );
      requestInputFocus();
    }
  });
  useKeybinding("global.screenshot", () => handleScreenshot(keyboardTabId), {
    enabled: () => desktopHandlersAvailable,
  });
  useKeybinding("global.continue-in-mode", () => session.continueInOtherMode());
  useKeybinding(
    "global.session-picker",
    () =>
      void window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
  );
  useKeybinding(
    "global.session-picker-j",
    () =>
      void window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")),
  );
  // Tasks and sessions are one list now, so the task shortcut and the session
  // shortcut open the same surface. Both are kept: the muscle memory for either
  // one lands somewhere correct.
  useKeybinding("global.task-picker", () => {
    session.unifiedPickerOpen = !session.unifiedPickerOpen;
  });
  useKeybinding("global.toggle-expanded", () => session.toggleExpanded(), {
    enabled: () => viewMode === "pill",
  });
  useKeybinding("global.close-tab", () => {
    if (activeTabId) session.closeTab(activeTabId, "keybinding");
  });
  useKeybinding("global.group-tabs", () => {
    session.toggleTabGroupMode("keybinding");
  });
  useKeybinding("global.attach-file", () => handleAttachFile(keyboardTabId));
  useKeybinding(
    "global.design-mode",
    () => {
      const targetStatus = session.sessionFor(keyboardTabId)?.status;
      if (
        targetStatus !== "running" &&
        targetStatus !== "connecting" &&
        desktopHandlersAvailable
      )
        handleDesignMode(keyboardTabId);
    },
    {
      enabled: () => desktopHandlersAvailable,
    },
  );
  useKeybinding("global.toggle-reasoning", () => {
    const isComposingDraft = session.router.leadingPane.base?.name === "draft";
    const targetTabId = isComposingDraft ? undefined : keyboardTabId;
    const targetStatus = targetTabId
      ? session.sessionFor(targetTabId)?.status
      : undefined;
    if (targetStatus === "running" || targetStatus === "connecting") return;
    window.dispatchEvent(
      new CustomEvent("solus:toggle-session-settings-picker", {
        detail: { tabId: targetTabId },
      }),
    );
  });
  useKeybinding(
    "global.toggle-diff-panel",
    () =>
      void window.dispatchEvent(
        new CustomEvent("solus:toggle-diff-panel", {
          detail: { tabId: keyboardTabId },
        }),
      ),
    {
      enabled: () => viewMode === "editor",
    },
  );
  useKeybinding("global.toggle-workspace", () =>
    session.toggleFolio("keybinding"),
  );
  useKeybinding("global.toggle-automations", () =>
    session.toggleAutomations("keybinding"),
  );
  useKeybinding("global.toggle-tasks", () => session.toggleTasks("keybinding"));
  useKeybinding("global.toggle-insights", () =>
    session.toggleInsights("keybinding"),
  );
  useKeybinding("global.settings", () =>
    session.showSettings("general", "keybinding"),
  );
  useKeybinding("global.focus-input", () => requestInputFocus());
  useKeybinding("global.history-back", () => void session.router.back());
  useKeybinding("global.history-forward", () => void session.router.forward());
  useKeybinding("global.toggle-worktree", () =>
    session.toggleWorktreeMode(
      session.focusedSourceId ?? undefined,
      "keybinding",
    ),
  );
  useKeybinding("global.switch-worktree", () => {
    const hasAgent = !!session.sessionFor(activeTabId)?.agentSessionId;
    if (hasAgent) return;
    window.dispatchEvent(new CustomEvent("solus:toggle-git-dropdown"));
  });
  useKeybinding(
    "global.git-open-terminal",
    () => {
      void session.apiForContext(session.ctx).openWorktreeTerminal(session.ctx);
    },
    {
      enabled: () =>
        desktopHandlersAvailable &&
        session.activeSession?.run.serverId === LOCAL_SERVER_ID,
    },
  );
  useKeybinding("global.show-shortcuts", () => {
    ui.shortcutsActiveScopes = keybindings.activeScopes();
    ui.shortcutsModalOpen = true;
  });
  // Desktop-only: on web the browser owns these combos (and its own zoom), so
  // the disabled registration lets the events fall through untouched.
  const zoomAvailable = localApi.setZoomFactor !== undefined;
  const showZoomToast = () => {
    toasts.info(`Zoom ${Math.round(settings.zoomFactor * 100)}%`, {
      id: "ui-zoom",
    });
  };
  useKeybinding(
    "global.zoom-in",
    () => {
      settings.zoomIn();
      showZoomToast();
    },
    { enabled: () => zoomAvailable },
  );
  useKeybinding(
    "global.zoom-out",
    () => {
      settings.zoomOut();
      showZoomToast();
    },
    { enabled: () => zoomAvailable },
  );
  useKeybinding(
    "global.zoom-reset",
    () => {
      settings.resetZoom();
      showZoomToast();
    },
    { enabled: () => zoomAvailable },
  );
  useKeybinding(
    "global.command-palette",
    () => {
      ui.paletteGitTarget = null;
      ui.commandPaletteOpen = true;
    },
    {
      enabled: () => viewMode === "editor",
    },
  );
  // Both need a project to search, and the pill has nowhere to show results.
  const canSearchProject = $derived(
    viewMode === "editor" &&
      !!sessionEnvironmentStore.environmentFor(
        session.sessionFor(keyboardTabId)?.run,
      ).cwd,
  );
  useKeybinding(
    "global.project-search",
    () => {
      ui.projectSearchOpen = true;
    },
    {
      enabled: () => canSearchProject,
    },
  );
  useKeybinding(
    "global.go-to-file",
    () => {
      ui.goToFileOpen = true;
    },
    {
      enabled: () => canSearchProject,
    },
  );

  // ── Actions that ship without a shortcut ───────────────────────────────────
  // Each is otherwise pointer- or palette-only. They register the same way as
  // everything above; the manifest simply gives them no default combo, so the
  // handler waits until a user assigns one in Settings → Keybindings.

  /** Open the palette drilled straight into one parent command's sub-page. */
  function openPalettePage(id: string, title: string) {
    ui.paletteGitTarget = null;
    ui.paletteInitialPage = { id, title };
    ui.commandPaletteOpen = true;
  }

  const paletteAvailable = $derived(viewMode === "editor");
  // The git sub-pages only exist while a session sits in a repository, matching
  // the condition that builds those commands.
  const hasGitContext = $derived(
    !!(
      session.activeSession?.run.gitContext ?? session.globalDefaults.gitContext
    ),
  );

  useKeybinding(
    "global.switch-branch",
    () => {
      window.dispatchEvent(
        new CustomEvent("solus:toggle-git-dropdown", {
          detail: { view: "branches" },
        }),
      );
    },
    { enabled: () => hasGitContext },
  );
  useKeybinding(
    "global.new-session-worktree",
    () => void session.createWorktreeTab(),
    {
      enabled: () => hasGitContext,
    },
  );
  useKeybinding(
    "global.new-session-in",
    () => openPalettePage("new-session-in", "New session in"),
    { enabled: () => paletteAvailable && hasGitContext },
  );
  useKeybinding(
    "global.working-tree-diff",
    () => {
      window.dispatchEvent(
        new CustomEvent("solus:toggle-diff-panel", {
          detail: { scope: { kind: "working-tree" }, switchScope: true },
        }),
      );
    },
    // Same gate as the diff-panel toggle: the pill has nowhere to show a diff.
    { enabled: () => viewMode === "editor" },
  );
  useKeybinding("global.open-prs", () => session.openPrs(null, "keybinding"));
  useKeybinding(
    "global.review-pr",
    () => {
      window.dispatchEvent(
        new CustomEvent("solus:review-pr", {
          detail: { tabId: keyboardTabId },
        }),
      );
    },
    { enabled: () => paletteAvailable && hasGitContext },
  );
  useKeybinding(
    "global.open-plan",
    () => openPalettePage("open-plan", "Open plan"),
    {
      enabled: () => paletteAvailable,
    },
  );
  useKeybinding(
    "global.open-document",
    () => openPalettePage("open-work", "Open document"),
    {
      enabled: () => paletteAvailable,
    },
  );
  useKeybinding(
    "global.open-automation",
    () => openPalettePage("open-automation", "Open automation"),
    { enabled: () => paletteAvailable },
  );
  useKeybinding(
    "global.open-task",
    () => openPalettePage("go-to-task", "Open task"),
    {
      // The sub-page is only built for the project the tasks store is scoped to.
      enabled: () => paletteAvailable && !!session.tasksProjectCwd,
    },
  );
  useKeybinding(
    "global.create-task-in",
    () => openPalettePage("create-task-in", "Create task in"),
    { enabled: () => paletteAvailable },
  );
  useKeybinding("global.permission-menu", () => {
    window.dispatchEvent(
      new CustomEvent("solus:toggle-permission-menu", {
        detail: { tabId: keyboardTabId },
      }),
    );
  });
  useKeybinding("global.add-server", () => serversStore.openAddServer());
  useKeybinding(
    "global.switch-server",
    () => openPalettePage("switch-server", "Switch server"),
    {
      enabled: () => paletteAvailable,
    },
  );
  useKeybinding("global.find-hosts", () => {
    session.showSettings("api-access", "keybinding");
    void serversStore.scanForServers();
  });
  useKeybinding("global.check-for-updates", () => void checkAllUpdates(), {
    enabled: () => updatesStore.isAvailable,
  });
  useKeybinding("global.restart-to-update", () => updatesStore.restart(), {
    enabled: () => updatesStore.isReady,
  });
}
