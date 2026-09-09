import { checkAllUpdates } from "@solus/workspace-ui/contexts/updates/check-all-updates";
import { untrack } from "svelte";
import {
  Plus as PlusIcon,
  GitCompareArrows as GitDiffIcon,
  GitFork as GitForkIcon,
  GitPullRequest as GitPullRequestIcon,
  List as ListBulletsIcon,
  Folders as FoldersIcon,
  History as ClockCounterClockwiseIcon,
  Settings2 as GearSixIcon,
  Keyboard as KeyboardIcon,
  GitBranch as GitBranchIcon,
  GitFork as TreeStructureIcon,
  SquareCheck as CheckSquareIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  Bookmark as BookmarkSimpleIcon,
  BookMarked as BookmarksIcon,
  ListChecks as ListChecksIcon,
  Unplug as PlugsIcon,
  Search as MagnifyingGlassIcon,
  FileText as FileTextIcon,
  ScrollText as ScrollTextIcon,
  GlobeIcon,
  RefreshCw as RefreshIcon,
  Download as DownloadIcon,
} from "@lucide/svelte";

import { hostOnboardingStore } from "@solus/workspace-ui/components/servers/host-onboarding.store.svelte";

import type { Command } from "@solus/workspace-ui/components/command-palette/lib/commands";
import {
  projectsStore,
  serversStore,
  hostCapabilitiesStore,
  updatesStore,
} from "@solus/workspace-ui/contexts";

import { toasts } from "@solus/workspace-ui/lib/toasts";

import { worktreeProjectRoot } from "@solus/contracts/types";
import type { PlanDescriptor, ProjectEntry } from "@solus/contracts/types";
import type { PullRequest } from "@solus/contracts/providers";

import { serverConnections } from "@solus/client-core/server-connections";
import { hostPolicy } from "@solus/client-core/host-policy";
import { supportsEditor } from "@solus/client-core/host-capabilities";
import { openInConfiguredEditor } from "@solus/workspace-ui/lib/openExternalEditor";

import { comboHint } from "@solus/workspace-ui/lib/keybindings/manifest";

import { requestInputFocus } from "@solus/workspace-ui/lib/inputFocus";
import { requestSavedPrompts } from "@solus/workspace-ui/lib/savedPromptsRequest";

import type { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
type DesktopAppCore = ReturnType<typeof createAppCore>;
import type { DesktopDialogs } from "./desktop-dialogs.svelte";

export function createDesktopPalette(
  core: DesktopAppCore,
  ui: DesktopDialogs,
  startOpenProject: (options?: { sourceId?: string }) => void,
) {
  const {
    settings,
    sessionEnvironmentStore,
    pullRequests,
    session,
    keybindings,
  } = core;
  const activeTabId = $derived(session.activeTabId);
  const paletteGitProjectRoot = $derived.by(() => {
    if (ui.paletteGitTarget) return ui.paletteGitTarget.projectRoot;
    const dir =
      session.activeSession?.run.gitContext?.repoRoot ??
      session.activeSession?.run.workingDirectory;
    return dir && dir !== "~" ? worktreeProjectRoot(dir) : null;
  });
  const paletteGitRefs = $derived(
    sessionEnvironmentStore.refsFor(paletteGitProjectRoot),
  );
  const worktrees = $derived(paletteGitRefs.worktrees);
  const paletteBranches = $derived(paletteGitRefs.branches);
  // Open PRs for the "Review PR…" sub-page, loaded lazily alongside the git refs.
  let palettePrs = $state<PullRequest[]>([]);
  $effect(() => {
    if (!ui.commandPaletteOpen) return;
    const projectRoot = paletteGitProjectRoot;
    if (!projectRoot) {
      palettePrs = [];
      return;
    }
    void sessionEnvironmentStore.refreshRefs(
      projectRoot,
      untrack(() => session.ctxForDirectory(projectRoot)),
      { force: true },
    );
    const context = untrack(() => ui.paletteGitTarget?.ctx ?? session.ctx);
    const api = session.apiForContext(context);
    pullRequests.projects
      .get(api, serverConnections.serverIdForApi(api), context)
      .query({ state: "open" })
      .then((result) => {
        palettePrs = result.items;
      })
      .catch(() => {
        palettePrs = [];
      });
  });

  // Plans, works, and automations for the "Open …" sub-pages, loaded lazily when
  // the palette opens so they mirror what currently exists. Plans live in local
  // state (the descriptor list isn't otherwise reactive); works and automations
  // are read straight from their reactive stores after triggering a refresh.
  let palettePlans = $state<PlanDescriptor[]>([]);
  // Known projects for the "Create task in…" sub-page, refreshed when the palette
  // opens so the list mirrors what the projects manifest currently holds.
  let paletteProjects = $state<ProjectEntry[]>([]);
  $effect(() => {
    if (!ui.commandPaletteOpen) return;
    const cwd = session.galleryProjectPath;
    const scopedCwd = cwd === "~" ? undefined : cwd;
    const taskCwd = session.tasksProjectCwd;
    const ctx = untrack(() => session.ctx);
    session.planStore
      .getDescriptors(undefined, true, ctx)
      .then((ds) => {
        palettePlans = ds;
      })
      .catch(() => {
        palettePlans = [];
      });
    void session.worksStore.loadAll(scopedCwd);
    void session.automationsStore.loadAll();
    if (taskCwd) void session.tasksStore.ensureLoaded();
    const projectApi = session.apiForContext(ctx);
    projectsStore
      .loadProjectsFor(
        serverConnections.serverIdForApi(projectApi),
        projectApi,
        { force: true },
      )
      .then((ps) => {
        paletteProjects = ps;
      })
      .catch(() => {
        paletteProjects = [];
      });
  });

  // Seed command set for the editor command palette. Intentionally a small,
  // obviously-correct starter list — the UI is the deliverable here; richer,
  // context-aware commands get layered in later.
  const baseCommands: Command[] = [
    {
      id: "open-project",
      label: "Open project…",
      group: "General",
      icon: FolderOpenIcon,
      hint: comboHint("global.select-project"),
      keywords: [
        "new project",
        "clone",
        "repository",
        "git",
        "github",
        "folder",
        "directory",
        "host",
        "machine",
      ],
      run: () =>
        startOpenProject({ sourceId: session.focusedSourceId ?? undefined }),
    },
    {
      id: "go-to-file",
      label: "Go to file",
      group: "General",
      icon: FileTextIcon,
      hint: comboHint("global.go-to-file"),
      keywords: ["file", "open", "quick open", "goto", "find file"],
      run: () => (ui.goToFileOpen = true),
    },
    {
      id: "project-search",
      label: "Search in project",
      group: "General",
      icon: MagnifyingGlassIcon,
      hint: comboHint("global.project-search"),
      keywords: ["find", "grep", "search", "contents", "text", "in files"],
      run: () => (ui.projectSearchOpen = true),
    },
    {
      id: "new-task",
      label: "New task",
      group: "General",
      icon: PlusIcon,
      hint: comboHint("global.new-task"),
      keywords: ["create", "task"],
      run: () => session.openSessionDraft({ freshTask: true, via: "palette" }),
    },
    {
      id: "new-tab",
      label: "New session",
      group: "General",
      icon: PlusIcon,
      hint: comboHint("global.new-session"),
      keywords: ["create", "session", "tab"],
      run: () => session.openSessionDraft({ via: "palette" }),
    },
    {
      id: "new-session-without-task",
      label: "New session without task",
      group: "General",
      icon: PlusIcon,
      hint: comboHint("global.new-session-without-task"),
      keywords: ["create", "session", "tab", "no task"],
      run: () =>
        session.openSessionDraft({ withoutTask: true, via: "palette" }),
    },
    {
      id: "save-prompt",
      label: "Save prompt",
      group: "Compose",
      icon: BookmarkSimpleIcon,
      hint: comboHint("global.save-prompt"),
      keywords: ["stash", "draft", "park", "later", "composer"],
      run: () => requestSavedPrompts({ action: "save" }),
    },
    {
      id: "saved-prompts",
      label: "Saved prompts…",
      group: "Compose",
      icon: BookmarksIcon,
      hint: comboHint("global.saved-prompts"),
      keywords: ["stash", "draft", "park", "restore", "composer"],
      run: () => requestSavedPrompts({ action: "open" }),
    },
    {
      id: "view-working-tree-diff",
      label: "View working tree diff",
      group: "Git",
      icon: GitDiffIcon,
      keywords: ["changes", "uncommitted", "git", "diff"],
      run: () =>
        window.dispatchEvent(
          new CustomEvent("solus:toggle-diff-panel", {
            detail: { scope: { kind: "working-tree" }, switchScope: true },
          }),
        ),
    },
    {
      id: "settings",
      label: "Settings",
      group: "General",
      icon: GearSixIcon,
      hint: comboHint("global.settings"),
      keywords: ["preferences", "config"],
      run: () => session.showSettings("general", "palette"),
    },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      group: "General",
      icon: KeyboardIcon,
      hint: comboHint("global.show-shortcuts"),
      keywords: ["keybindings", "keys"],
      run: () => {
        ui.shortcutsActiveScopes = keybindings.activeScopes();
        ui.shortcutsModalOpen = true;
      },
    },
    {
      id: "add-server",
      label: "Add server",
      group: "Servers",
      icon: PlugsIcon,
      keywords: ["remote", "pair", "connect"],
      run: () => serversStore.openAddServer(),
    },
    {
      id: "find-hosts",
      label: "Find hosts nearby",
      group: "Servers",
      icon: PlugsIcon,
      keywords: ["discover", "scan", "lan", "tailscale", "nearby"],
      // Settings → Connections owns the fuller version of this: a scan button,
      // last-seen times and connect. The switcher chip it used to open is not
      // rendered in editor mode at all.
      run: () => {
        session.showSettings("api-access", "palette");
        void serversStore.scanForServers();
      },
    },
  ];

  async function switchPaletteBranch(branch: string): Promise<boolean> {
    const projectRoot = paletteGitProjectRoot;
    if (projectRoot) {
      const ctx = session.ctxForDirectory(projectRoot);
      const refsReady = await sessionEnvironmentStore.refreshRefs(
        projectRoot,
        ctx,
        { force: true },
      );
      if (!refsReady) toasts.error("Couldn't refresh branches");
      const worktree = sessionEnvironmentStore
        .refsFor(projectRoot)
        .worktrees.find((wt) => wt.branch === branch);
      if (worktree) {
        await session.switchToWorktree(worktree.path, undefined, "palette");
        const nextCwd =
          session.activeSession?.run.gitContext?.worktreePath ??
          session.activeSession?.run.workingDirectory;
        if (nextCwd)
          void sessionEnvironmentStore.refresh(nextCwd, { force: true });
        requestInputFocus();
        return true;
      }
    }

    const ok = await session.switchToBranch(branch, undefined, "palette");
    const nextCwd =
      session.activeSession?.run.gitContext?.worktreePath ??
      session.activeSession?.run.workingDirectory;
    if (ok && nextCwd)
      void sessionEnvironmentStore.refresh(nextCwd, { force: true });
    requestInputFocus();
    return ok;
  }

  // "Open plan/document/automation…" mirror the "Open worktree…" flow: a parent
  // command that drills into a sub-page listing the existing items, each of which
  // opens that one artifact. Only shown when there's something to open, so they
  // don't clutter the root list. Worktree actions only make sense inside a git
  // project; "Open worktree…" drills the same way.
  // "Open Solus logs" hands the active host's own log file to the configured
  // editor. Only this device's host qualifies: a remote host writes its log on
  // another machine, where a local editor cannot reach it.
  const logsServerId = $derived(
    serverConnections.serverIdForApi(session.apiFor(session.activeTabId)),
  );
  const canOpenHostLogs = $derived(
    !!settings.defaultEditor &&
      hostPolicy.isClientMachine(logsServerId) &&
      supportsEditor(
        hostCapabilitiesStore.for(logsServerId),
        settings.defaultEditor,
      ),
  );

  async function openHostLogs(): Promise<void> {
    const tabId = session.activeTabId;
    const api = session.apiFor(tabId);
    try {
      const path = await api.logFilePath();
      openInConfiguredEditor(session.ctxFor(tabId), {
        api,
        serverId: serverConnections.serverIdForApi(api),
        filePaths: [path],
        editorId: settings.defaultEditor,
        fallbackTerminalId: settings.fallbackTerminal,
      });
    } catch {
      toasts.error("Could not read this host's log file path");
    }
  }

  const paletteCommands = $derived.by(() => {
    const commands: Command[] = [...baseCommands];

    if (updatesStore.isAvailable) {
      commands.push({
        id: "check-for-updates",
        label: "Check for updates",
        group: "General",
        icon: RefreshIcon,
        hint: comboHint("global.check-for-updates"),
        keywords: ["update", "upgrade", "version", "release", "new version"],
        run: () => void checkAllUpdates(),
      });
    }
    if (updatesStore.isReady) {
      commands.push({
        id: "restart-to-update",
        label: `Restart to update Solus ${updatesStore.release?.version ?? ""}`.trim(),
        group: "General",
        icon: DownloadIcon,
        hint: comboHint("global.restart-to-update"),
        keywords: ["update", "upgrade", "restart", "install", "version"],
        run: () => updatesStore.restart(),
      });
    }

    if (canOpenHostLogs) {
      commands.push({
        id: "open-solus-logs",
        label: "Open Solus logs",
        group: "General",
        icon: ScrollTextIcon,
        keywords: [
          "log",
          "logs",
          "debug",
          "diagnostics",
          "dev.log",
          "solus.log",
        ],
        run: () => void openHostLogs(),
      });
    }

    const switchServerChildren: Command[] = serversStore.servers.map(
      (server) => ({
        id: `switch-server:${server.id}`,
        label: server.label,
        group: "Servers",
        icon: PlugsIcon,
        hint: server.id === serversStore.activeServerId ? "Active" : undefined,
        keywords: [
          "server",
          "remote",
          "connect",
          server.url,
          server.installationId ?? "",
        ],
        run: () => serversStore.switchTo(server.id),
      }),
    );
    commands.push({
      id: "switch-server",
      label: "Switch server…",
      group: "Servers",
      icon: PlugsIcon,
      keywords: ["server", "remote", "connect", "host", "machine"],
      children: switchServerChildren,
    });

    for (const host of serversStore.nearbyHosts) {
      commands.push({
        id: `connect-host:${host.server.installationId}`,
        label: `Connect to ${host.server.name}`,
        group: "Servers",
        icon: PlugsIcon,
        keywords: [
          "server",
          "connect",
          `${host.server.host}:${host.server.port}`,
          host.server.source,
        ],
        run: () => hostOnboardingStore.openForDiscovered(host.server),
      });
    }

    // Always surface the parent commands so they appear the instant the palette
    // opens; their children stream in as the background loads resolve, and the
    // sub-page reflects them live (CommandPalette re-derives children by id).
    const planChildren: Command[] = palettePlans.map((d) => ({
      id: `plan:${d.sessionId}:${d.planToolUseId}`,
      label: d.title || "Untitled plan",
      group: "Plans",
      icon: ListBulletsIcon,
      keywords: [d.title ?? ""],
      run: () => void session.openPlanFromDescriptor(d, "palette"),
    }));
    commands.push({
      id: "open-browser",
      label: "Open Browser",
      group: "View",
      icon: GlobeIcon,
      keywords: [
        "browser",
        "browser",
        "viewport",
        "device",
        "mobile",
        "responsive",
        "dev server",
      ],
      run: () => session.openBrowser(),
    });

    commands.push({
      id: "open-plan",
      label: "Open plan…",
      group: "View",
      icon: ListBulletsIcon,
      keywords: ["plan", "open"],
      children: planChildren,
    });

    const workChildren: Command[] = Object.values(session.worksStore.works)
      .filter(
        (w) =>
          w.title &&
          !session.worksStore.streaming[w.id] &&
          session.worksStore.pendingWorkDelete?.id !== w.id,
      )
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .map((w) => ({
        id: `work:${w.id}`,
        label: w.title,
        group: "Documents",
        icon: FoldersIcon,
        keywords: [w.title],
        run: () =>
          void session.openWorkModal(w.id, w.title, { via: "palette" }),
      }));
    commands.push({
      id: "open-work",
      label: "Open document…",
      group: "View",
      icon: FoldersIcon,
      keywords: ["work", "document", "folio", "open"],
      children: workChildren,
    });
    commands.push({
      id: "import-doc",
      label: "Import document from URL…",
      group: "View",
      icon: FoldersIcon,
      keywords: [
        "import",
        "confluence",
        "google",
        "docs",
        "url",
        "link",
        "document",
      ],
      run: () => (ui.importDocOpen = true),
    });

    const automationChildren: Command[] = session.automationsStore.items.map(
      (a) => ({
        id: `automation:${a.id}`,
        label: a.name,
        group: "Automations",
        icon: ClockCounterClockwiseIcon,
        keywords: [a.name],
        run: () => session.openAutomations(a.id, "palette"),
      }),
    );
    commands.push({
      id: "open-automation",
      label: "Open automation…",
      group: "View",
      icon: ClockCounterClockwiseIcon,
      keywords: ["automation", "schedule", "cron", "open"],
      children: automationChildren,
    });
    // Create a task — one entry scoped to the status-bar project, plus a sub-page
    // to pick any other known project. Both pop the standalone create-task modal.
    const taskCwd = session.tasksProjectCwd;
    if (taskCwd) {
      const taskProjectName =
        taskCwd.split("/").filter(Boolean).pop() ?? taskCwd;
      commands.push({
        id: "create-task",
        label: `Create task in ${taskProjectName}`,
        group: "Tasks",
        icon: CheckSquareIcon,
        hint: comboHint("global.create-task"),
        keywords: ["task", "create", "new", "todo", "issue", taskProjectName],
        run: () => session.openTaskComposer(taskCwd, true),
      });
    }
    const createTaskInChildren: Command[] = paletteProjects.map((p) => ({
      id: `create-task-in:${p.path}`,
      label:
        p.folderName || (p.path.split("/").filter(Boolean).pop() ?? p.path),
      group: "Projects",
      icon: FolderIcon,
      keywords: [p.folderName, p.path],
      run: () => session.openTaskComposer(p.path),
    }));
    commands.push({
      id: "create-task-in",
      label: "Create task in…",
      group: "Tasks",
      icon: CheckSquareIcon,
      keywords: ["task", "create", "new", "todo", "issue", "project"],
      children: createTaskInChildren,
    });

    // Open any existing task (opens its detail). Like the other parent
    // commands, surface this the instant the palette opens so it never waits on
    // the tasks provider; children stream in once the store loads for this
    // project. Only the active project's tasks count (the store is scoped to one
    // cwd, so anything else is stale).
    const tasksLoadedForProject = !!taskCwd && session.tasksStore.loaded;
    const goToTaskChildren: Command[] = tasksLoadedForProject
      ? session.tasksStore.tasksForProject(taskCwd).map((t) => ({
          id: `go-to-task:${t.id}`,
          label: t.title,
          group: "Tasks",
          icon: ListChecksIcon,
          hint: t.kind === "epic" ? "Epic" : undefined,
          keywords: ["task", t.id, t.assignee ?? "", ...t.labels],
          run: () => session.goToTask(t.id),
        }))
      : [];
    if (taskCwd) {
      commands.push({
        id: "go-to-task",
        label: "Open task…",
        group: "View",
        icon: ListChecksIcon,
        keywords: ["task", "go", "open", "find", "jump", "issue", "ticket"],
        children: goToTaskChildren,
      });
    }

    commands.push({
      id: "open-prs",
      label: "Open pull requests",
      group: "View",
      icon: GitPullRequestIcon,
      keywords: ["pr", "pull request", "github", "review", "prs"],
      run: () => session.openPrs(null, "palette"),
    });

    const gitCtx =
      session.activeSession?.run.gitContext ??
      session.globalDefaults.gitContext;
    if (gitCtx) {
      const worktreeBranchNames = worktrees.map((wt) => wt.branch);
      const branchCommands: Command[] = [
        ...paletteBranches
          .filter((branch) => !worktreeBranchNames.includes(branch))
          .map((branch) => ({
            id: `branch:${branch}`,
            label: branch,
            group: "Git",
            icon: GitBranchIcon,
            keywords: ["git", "branch", "checkout", "switch", branch],
            run: () => void switchPaletteBranch(branch),
          })),
        ...worktrees
          .filter((wt) => wt.path !== gitCtx.worktreePath)
          .map((wt) => ({
            id: `worktree:${wt.path}`,
            label: wt.branch,
            group: "Git",
            icon: GitForkIcon,
            keywords: ["git", "worktree", "branch", "checkout", wt.branch],
            run: () =>
              void session.switchToWorktree(wt.path, undefined, "palette"),
          })),
      ];
      const existingWorktreeChildren: Command[] = worktrees
        .filter((wt) => wt.path !== gitCtx.worktreePath)
        .map((wt) => ({
          id: `new-session-existing-worktree:${wt.path}`,
          label: wt.branch,
          group: "Worktrees",
          icon: GitForkIcon,
          keywords: ["session", "worktree", "existing", wt.branch, wt.path],
          run: () => {
            // The draft starts in the worktree; its environment refresh resolves
            // the checkout from that directory, same as picking a project does.
            session.openSessionDraft({ via: "palette" }, wt.path);
          },
        }));
      const newSessionBranchChildren: Command[] = paletteBranches
        .filter((branch) => !worktreeBranchNames.includes(branch))
        .map((branch) => ({
          id: `new-session-branch:${branch}`,
          label: branch,
          group: "Branches",
          icon: GitBranchIcon,
          keywords: ["session", "branch", "checkout", "switch", branch],
          // The checkout is a real change on disk, so it happens either way;
          // `switchToBranch` then opens a draft there rather than moving a
          // conversation already under way.
          run: () => void switchPaletteBranch(branch),
        }));
      const newSessionInChildren: Command[] = [
        ...newSessionBranchChildren,
        ...existingWorktreeChildren,
      ];
      const activeSess = session.activeSession;
      const canContinueWorktree =
        !!activeSess?.agentSessionId &&
        !activeSess.run.gitContext?.worktreePath;
      const worktreeCommands: Command[] = [
        {
          id: "new-session-new-worktree",
          label: "New session in new worktree",
          group: "General",
          icon: GitForkIcon,
          keywords: ["worktree", "branch", "isolated", "create", "new"],
          run: () => void session.createWorktreeTab(),
        },
        {
          id: "new-session-in",
          label: "New session in…",
          group: "General",
          icon: GitForkIcon,
          keywords: [
            "session",
            "branch",
            "worktree",
            "checkout",
            "switch",
            "remote",
            "existing",
            "open",
            "pick",
          ],
          children: newSessionInChildren,
        },
        {
          id: "switch-branch-or-worktree",
          label: "Switch branch or worktree…",
          group: "Git",
          icon: GitBranchIcon,
          keywords: ["git", "branch", "checkout", "switch", "worktree"],
          children: branchCommands,
        },
        {
          id: "review-pr",
          label: "Review PR…",
          group: "Git",
          icon: GitPullRequestIcon,
          keywords: ["git", "pull request", "pr", "github", "review"],
          // Children stream in once palettePrs resolves; the sub-page re-derives
          // its list by id, so they appear without re-entering the page.
          children: palettePrs.map((pr) => ({
            id: `pr:${pr.number}`,
            label: pr.title,
            group: "Pull requests",
            icon: GitPullRequestIcon,
            hint: `#${pr.number}`,
            keywords: [
              "pr",
              "pull request",
              "review",
              String(pr.number),
              pr.author,
            ],
            run: () =>
              void session.openPullRequest(pr, {
                ctx: ui.paletteGitTarget?.ctx,
                via: "palette",
              }),
          })),
        },
      ];
      if (canContinueWorktree) {
        worktreeCommands.unshift({
          id: "continue-in-worktree",
          label: "Continue in worktree",
          group: "General",
          icon: TreeStructureIcon,
          keywords: [
            "worktree",
            "continue",
            "move",
            "branch",
            "isolated",
            "fork",
          ],
          hint: comboHint("global.continue-worktree"),
          run: () => void session.continueInWorktree(activeTabId, "palette"),
        });
      }
      // Slot the git actions directly beneath "New session" so they stay near
      // session creation instead of drifting to the tail.
      const newTabIdx = commands.findIndex((c) => c.id === "new-tab");
      commands.splice(newTabIdx + 1, 0, ...worktreeCommands);
    }

    return commands;
  });

  return {
    get commands() {
      return paletteCommands;
    },
  };
}
