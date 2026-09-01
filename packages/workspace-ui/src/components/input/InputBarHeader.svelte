<script lang="ts">
  import { GitBranch as GitBranchIcon, GitFork as GitForkIcon } from "@lucide/svelte";
  import { mergeProps } from "bits-ui";
  import {
    getWorkspaceContext,
    getWindowContext,
    getSessionEnvironmentStore,
    serversStore,
  } from "../../contexts";
  import { projectDirLabel } from "../../lib/paths";
  import { homeGitDetails, worktreeDisplayName } from "../../lib/git-context";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type {
    RunConfig,
    TaskTarget,
    WorktreeEntry,
  } from "@solus/contracts/types";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import {
    isDispatch,
    withCheckout,
    withPendingHost,
  } from "../../contexts/workspace/run-config";
  import { projectHostId } from "../servers/run-on";
  import { hasSessionStarted } from "../../lib/sessionUtils";
  import GitDropdown from "../GitDropdown.svelte";
  import RunOnPicker from "../servers/RunOnPicker.svelte";
  import { Button } from "../ui/button";
  import ProjectChip from "./ProjectChip.svelte";
  import TaskPicker from "./TaskPicker.svelte";
  import {
    shouldResetTaskForProjectChange,
    type TaskProjectScope,
  } from "./lib/task-project-scope";

  interface Props {
    /** The tab or draft this header describes. A draft has no tab, so the header
     *  resolves its run through `runFor` and never assumes a session exists.
     *  Unset for the workspace dock, which follows the active conversation. */
    sourceId?: string;
    /** The pane this pre-flight header sits in, so its run and task pickers can
     *  answer the open shortcut aimed at that composer. Unset for the dock. */
    paneId?: string;
    /** Bound where a surface above this strip names the project as well — the
     *  draft headline opens the chip's own list instead of a second menu. */
    projectPickerOpen?: boolean;
    /** An external project control that owns the open menu's visual position. */
    projectPickerAnchor?: HTMLElement | null;
  }
  let {
    sourceId,
    paneId,
    projectPickerOpen = $bindable(false),
    projectPickerAnchor = null,
  }: Props = $props();

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const environmentStore = getSessionEnvironmentStore();
  const isPinned = $derived(sourceId !== undefined);
  const source = $derived(sourceId ?? session.activeTabId);
  // A source is a started conversation's tab or a draft that has yet to become
  // one; `sess` answers which. Both own the same `run`, which is all the chips
  // below read, so the header describes either without branching on it.
  const sess = $derived(session.sessionFor(source));
  const draft = $derived(session.sessionDrafts.get(source));
  const run = $derived(session.runFor(source));
  // The task the started session will file under, held by whichever this source
  // is; neither, before a project is chosen, files under a new one.
  const taskTarget = $derived<TaskTarget>(
    sess?.task ?? draft?.task ?? { kind: "new" },
  );
  // Focus routes to a tab by id; a draft's composer claims bare focus as the
  // primary bar, so it takes no target.
  const focusTarget = $derived(sess ? { tabId: source } : undefined);

  const projectDir = $derived(
    run?.workingDirectory ??
      session.globalDefaults.workingDirectory ??
      "~",
  );
  // Tasks belong to a project. The directory picker updates a draft outside
  // this component, so observe the run rather than only the project-chip click.
  // Changing active tabs is not a project change for either composer.
  let previousTaskProjectScope: TaskProjectScope | null = null;
  $effect(() => {
    const nextScope = { sourceId: source, workingDirectory: projectDir };
    const shouldReset = shouldResetTaskForProjectChange(
      previousTaskProjectScope,
      nextScope,
    );
    previousTaskProjectScope = nextScope;
    if (shouldReset) selectTask({ kind: "new" });
  });
  const defaultGitContext = $derived(session.globalDefaults.gitContext);
  const gitHome = $derived(
    homeGitDetails(projectDir, run?.gitContext, defaultGitContext),
  );
  // The project keeps its own name even when the session runs in a worktree of
  // it, so the label reads off the repo root rather than the checkout.
  const projectLabel = $derived(
    projectDirLabel(
      gitHome.projectRoot ?? projectDir,
      session.staticInfo?.workspacePath,
    ),
  );

  const env = $derived(environmentStore.environmentFor(run));
  const hasGitRepository = $derived(!!env.checkout || !!env.repoRoot);
  const worktreeForced = $derived(isDispatch(run) && !!run?.worktree);
  // Only a *pending* worktree changes where the next session starts. Choosing a
  // new worktree from an existing one re-anchors the draft to the project root;
  // creation still follows the normal origin/default-branch path.
  const startsNewWorktree = $derived(env.pending || worktreeForced);
  const pendingDispatch = $derived(
    run?.pendingHostDispatch?.intent === "dispatch"
      ? run.pendingHostDispatch
      : null,
  );
  const selectedDispatchWorktree = $derived(pendingDispatch?.worktree ?? null);
  const selectedDispatchBaseBranch = $derived(pendingDispatch?.baseBranch ?? null);
  const displayBranch = $derived(
    selectedDispatchWorktree?.branch ?? selectedDispatchBaseBranch ?? (pendingDispatch ? "New worktree" : env.branch ?? env.name),
  );
  const branchLabel = $derived(
    pendingDispatch ? displayBranch : (env.pending ? env.name : displayBranch),
  );
  const displayBranchLabel = $derived(
    selectedDispatchWorktree || env.isolated
      ? worktreeDisplayName(branchLabel)
      : branchLabel,
  );
  const branchTooltip = $derived(
    selectedDispatchWorktree
      ? `Works in ${worktreeDisplayName(selectedDispatchWorktree.branch)} on the selected host`
      : selectedDispatchBaseBranch
      ? `Creates a new worktree from ${selectedDispatchBaseBranch} on the selected host`
      : pendingDispatch
      ? "Creates a new worktree on the selected host"
      : startsNewWorktree
      ? `Branches into its own worktree from ${gitHome.baseBranch}`
      : `Working in ${displayBranch} directly`,
  );

  const worktreePath = $derived(
    run?.gitContext?.worktreePath ??
      defaultGitContext?.worktreePath ??
      null,
  );
  const gitStatusCwd = $derived(worktreePath ?? projectDir);
  const git = $derived(environmentStore.statusFor(gitStatusCwd));
  const worktrees = $derived(
    environmentStore.refsFor(gitHome.projectRoot ?? env.repoRoot).worktrees,
  );
  const worktreeBaseBranch = $derived(run?.worktree?.baseBranch ?? null);
  // Editor mode had no live branch data before this: the equivalent refresh on
  // the status row is gated to pill mode.
  $effect(() => {
    const cwd = gitStatusCwd;
    if (!cwd || cwd === "~") return;
    void environmentStore.refresh(cwd);
  });

  let gitOpen = $state(false);
  let branchTooltipOpen = $state(false);
  let gitInitialView: "worktrees" | "branches" = $state("branches");
  let gitTriggerEl: HTMLButtonElement | null = $state(null);

  $effect(() => {
    if (isPinned) return;
    const handler = (event: Event) => {
      if (windowCtx.viewMode !== "editor" || !hasGitRepository) return;
      if (gitOpen) {
        gitOpen = false;
      } else {
        branchTooltipOpen = false;
        // The worktree shortcut opens the worktree list; the branch shortcut
        // asks for the branch list instead.
        const detail: { view?: "worktrees" | "branches" } | undefined =
          event instanceof CustomEvent ? event.detail : undefined;
        gitInitialView = detail?.view === "branches" ? "branches" : "worktrees";
        gitOpen = true;
      }
    };
    window.addEventListener("solus:toggle-git-dropdown", handler);
    return () =>
      window.removeEventListener("solus:toggle-git-dropdown", handler);
  });

  $effect(() => {
    if (!hasGitRepository) gitOpen = false;
  });

  // The chip names a branch, so it always opens the branch list.
  function toggleBranchPicker() {
    gitInitialView = pendingDispatch ? "worktrees" : "branches";
    gitOpen = !gitOpen;
    if (gitOpen) branchTooltipOpen = false;
  }

  function getBranchTooltipOpen() {
    return branchTooltipOpen && !gitOpen;
  }

  function setBranchTooltipOpen(next: boolean) {
    branchTooltipOpen = next && !gitOpen;
  }

  async function selectBranch(branch: string) {
    if (!source) return;
    if (pendingDispatch) return;
    // A branch checked out elsewhere names that existing worktree. Navigating
    // there avoids turning the selection into a request for another worktree.
    const entry = worktrees.find((worktree) => worktree.branch === branch);
    if (entry) {
      await selectWorktree(entry);
      return;
    }
    const ok = await session.switchToBranch(branch, source);
    if (!ok) {
      requestInputFocus(focusTarget);
      return;
    }
    settleOnDestination();
  }

  async function selectWorktree(worktree: WorktreeEntry) {
    if (pendingDispatch) {
      session.setDispatchWorktree(worktree, source);
      requestInputFocus(focusTarget);
      return;
    }
    // Honour this header's own source: the editor input bar mounts one per pane,
    // so a split pane must not move the primary chat.
    await session.switchToWorktree(worktree.path, source);
    settleOnDestination();
  }

  function selectNewDispatchWorktree(baseBranch?: string) {
    if (baseBranch) session.setDispatchBaseBranch(baseBranch, source);
    else session.setDispatchWorktree(null, source);
    requestInputFocus(focusTarget);
  }

  // Which host the chosen project lives on — the run-on picker's answer, read
  // back so a project picked from the chip lands on the host it belongs to.
  const projectHost = $derived(projectHostId(run ?? session.defaultRunConfig));
  const projectHostIsLocal = $derived(
    serversStore.hostFor(projectHost)?.local ?? true,
  );

  function selectProject(path: string) {
    // A project on another host is that host's project — recorded as an open and
    // resolved over there on Send, exactly as the run-on picker used to do it.
    // This is a pre-start move only: a started session moves through
    // `setBaseDirectory`, which resets the live provider thread on its own host.
    if (draft && !projectHostIsLocal) {
      applyRun(
        withCheckout(
          withPendingHost(draft.run, { serverId: projectHost, intent: "open-project" }),
          path,
          null,
        ),
      );
      requestInputFocus(focusTarget);
      return;
    }
    void session.setBaseDirectory(path, source).then(
      () => requestInputFocus(focusTarget),
      () => {},
    );
  }

  function browseProjects() {
    // A folder on another host is that host's project, browsed through the
    // directory picker bound to it. On this machine a draft edits its run in
    // place, while a tab opens a project that may land in a new tab of its own.
    if (!projectHostIsLocal) {
      window.dispatchEvent(
        new CustomEvent("solus:open-directory-picker", {
          detail: {
            ...(draft ? { draftId: source } : { tabId: source }),
            serverId: projectHost,
            intent: "open-project",
          },
        }),
      );
      return;
    }
    if (draft) {
      window.dispatchEvent(
        new CustomEvent("solus:open-directory-picker", {
          detail: { draftId: source },
        }),
      );
      return;
    }
    window.dispatchEvent(
      new CustomEvent("solus:open-project", { detail: { tabId: source } }),
    );
  }

  function selectTask(next: TaskTarget) {
    // A tab's session or a draft — both own the task the started session files
    // under, so the choice lands on whichever this source is.
    const target = sess ?? draft;
    if (target) target.task = next;
  }

  /** Every destination choice this strip offers lands here. Inert until Send —
   *  nothing connects or moves, which is what makes changing your mind free. */
  function applyRun(next: RunConfig) {
    const target = sess ?? draft;
    if (target) target.run = next;
  }

  function settleOnDestination() {
    const nextRun = session.runFor(source);
    const nextCwd =
      nextRun?.gitContext?.worktreePath ??
      nextRun?.workingDirectory ??
      session.globalDefaults.gitContext?.worktreePath ??
      session.globalDefaults.workingDirectory;
    if (nextCwd) void environmentStore.refresh(nextCwd, { force: true });
    requestInputFocus(focusTarget);
  }
</script>

<!--
  Destination strip: where the next session will run, as three chips that each
  answer one question — which project, what it starts in, which branch. Sits
  above the composer card and only while the session has not started, because
  that is exactly how long any of it is editable.
-->
<!--
  The strip wraps rather than shrinks. Four chips sharing 393px leave each one
  about 90px, which cuts every label to two characters and a fade — and a
  destination you cannot read is not a destination you can check. A chip that
  does not fit takes the next line instead, at any width: the same rule saves a
  narrow companion pane on desktop.
-->
<div class="flex flex-wrap items-center gap-1.5 px-3.5 pb-2">
  <!-- The picker decides its own visibility from the connected hosts and the
       checkout, so it renders regardless of git: a folder opened on a remote
       machine still names the machine it runs on. It comes first: it chooses the
       host, and the project chip beside it lists that host's projects. -->
  <RunOnPicker
    run={run ?? session.defaultRunConfig}
    requesterId={source}
    locked={hasSessionStarted(sess)}
    onRun={applyRun}
    onDismiss={() => requestInputFocus(focusTarget)}
    variant="header"
    {paneId}
  />

  <ProjectChip
    run={run ?? session.defaultRunConfig}
    projectDir={gitHome.projectRoot ?? projectDir}
    label={projectLabel}
    onSelect={selectProject}
    onBrowse={browseProjects}
    onDismiss={() => requestInputFocus(focusTarget)}
    anchor={projectPickerAnchor}
    bind:open={projectPickerOpen}
  />

  {#if hasGitRepository}
    <TooltipUI.Root
      bind:open={getBranchTooltipOpen, setBranchTooltipOpen}
      disabled={gitOpen}
    >
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <Button
            {...mergeProps(tooltipProps, { onclick: toggleBranchPicker })}
            bind:ref={gitTriggerEl}
            variant="ghost"
            aria-haspopup="menu"
            aria-expanded={gitOpen}
            class="group relative h-auto min-w-0 shrink gap-1.5 rounded-lg px-2 py-1 text-workspace-chrome font-normal transition-[background-color,color,scale] duration-[var(--duration-quick)] ease-(--ease-premium) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-0 after:absolute after:left-0 after:top-1/2 after:h-10 after:w-full after:-translate-y-1/2 after:content-[''] {gitOpen
 ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
 : 'text-(--solus-text-tertiary) hover:bg-[color-mix(in_srgb,var(--solus-surface-hover)_60%,transparent)] hover:text-(--solus-text-secondary) focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-secondary)'}"
            style="max-width:12rem"
          >
            {#if pendingDispatch}
              <GitForkIcon
                size={14}
                class="shrink-0 text-(--solus-text-tertiary) transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {gitOpen
 ? 'opacity-100'
 : 'opacity-70'}"
              />
            {:else}
              <GitBranchIcon
                size={14}
                class="shrink-0 text-(--solus-text-tertiary) transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {gitOpen
 ? 'opacity-100'
 : 'opacity-70'}"
              />
            {/if}
            <span class="truncate">{displayBranchLabel}</span>
          </Button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={branchTooltip} />
    </TooltipUI.Root>
  {/if}
  <TaskPicker
    task={taskTarget}
    projectKey={gitHome.projectRoot ?? projectDir}
    onSelect={selectTask}
    onDismiss={() => requestInputFocus(focusTarget)}
    {paneId}
  />
</div>

<!-- The composer is bottom-anchored, so the list opens over the transcript. -->
{#if hasGitRepository}
  <GitDropdown
    bind:open={gitOpen}
    side="top"
    initialView={gitInitialView}
    triggerEl={gitTriggerEl}
    {displayBranch}
    selectedBranch={selectedDispatchWorktree?.branch ?? selectedDispatchBaseBranch ?? worktreeBaseBranch ?? displayBranch}
    workingDirectory={gitStatusCwd}
    {run}
    onSelectBranch={selectBranch}
    onSelectWorktree={selectWorktree}
    onSelectNewWorktree={selectNewDispatchWorktree}
    onDismiss={() => requestInputFocus(focusTarget)}
  />
{/if}
