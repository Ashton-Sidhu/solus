<script lang="ts">
  import { GitBranchIcon } from "phosphor-svelte";
  import { mergeProps } from "bits-ui";
  import {
    getWorkspaceContext,
    getWindowContext,
    getSessionEnvironmentStore,
  } from "../../contexts";
  import { projectDirLabel } from "../../lib/paths";
  import { homeGitDetails } from "../../lib/git-context";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { TaskTarget, WorktreeEntry } from "../../../shared/types";
  import { taskTargetOf } from "../../contexts/workspace/session.utils";
  import { taskTargetFields } from "../../contexts/workspace/session-draft.svelte";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { isDispatchedRun } from "../servers/run-on";
  import GitDropdown from "../GitDropdown.svelte";
  import RunOnPicker from "../servers/RunOnPicker.svelte";
  import { Button } from "../ui/button";
  import ProjectChip from "./ProjectChip.svelte";
  import TaskPicker from "./TaskPicker.svelte";

  interface Props {
    tabId?: string;
  }
  let { tabId }: Props = $props();

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const environmentStore = getSessionEnvironmentStore();
  const isPinned = $derived(tabId !== undefined);
  const targetTabId = $derived(tabId ?? session.activeTabId);
  const sess = $derived(session.sessionFor(targetTabId));

  const projectDir = $derived(
    sess?.run.workingDirectory ?? session.globalDefaults.workingDirectory ?? "~",
  );
  const defaultGitContext = $derived(session.globalDefaults.gitContext);
  const gitHome = $derived(
    homeGitDetails(projectDir, sess?.run.gitContext, defaultGitContext),
  );
  // The project keeps its own name even when the session runs in a worktree of
  // it, so the label reads off the repo root rather than the checkout.
  const projectLabel = $derived(
    projectDirLabel(
      gitHome.projectRoot ?? projectDir,
      session.staticInfo?.workspacePath,
    ),
  );

  const env = $derived(environmentStore.environmentFor(session.sessionFor(targetTabId)?.run));
  const hasGitRepository = $derived(!!env.checkout || !!env.repoRoot);
  // A dispatched session always works in its own worktree, so the switch reads
  // on and stays inert rather than offering a choice that won't be honoured.
  const worktreeForced = $derived(isDispatchedRun(sess?.run));
  const canToggleWorktree = $derived(
    gitHome.canToggleWorktree || worktreeForced,
  );
  // Only a *pending* worktree changes where the next session starts. Choosing a
  // new worktree from an existing one retargets the draft to the project root;
  // creation still follows the normal origin/default-branch path.
  const startsNewWorktree = $derived(env.pending || worktreeForced);
  const displayBranch = $derived(env.branch ?? env.name);
  const branchLabel = $derived(env.pending ? env.name : displayBranch);
  const branchTooltip = $derived(
    startsNewWorktree
      ? `Branches into its own worktree from ${gitHome.baseBranch}`
      : `Working in ${displayBranch} directly`,
  );

  const worktreePath = $derived(
    sess?.run.gitContext?.worktreePath ?? defaultGitContext?.worktreePath ?? null,
  );
  const gitStatusCwd = $derived(worktreePath ?? projectDir);
  const git = $derived(environmentStore.statusFor(gitStatusCwd));
  const worktrees = $derived(
    environmentStore.refsFor(gitHome.projectRoot ?? env.repoRoot).worktrees,
  );
  const worktreeBaseBranch = $derived(
    sess?.run.worktreeBaseBranch ??
      (!sess && session.settings.worktreeEnabled
        ? (git?.targetBranch ?? null)
        : null),
  );
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
    const handler = () => {
      if (windowCtx.viewMode !== "editor" || !hasGitRepository) return;
      if (gitOpen) {
        gitOpen = false;
      } else {
        branchTooltipOpen = false;
        gitInitialView = "worktrees";
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

  function toggleWorktree() {
    if (!canToggleWorktree || worktreeForced) return;
    session.toggleWorktreeMode(targetTabId);
    requestInputFocus(tabId ? { tabId } : undefined);
  }

  // The chip names a branch, so it always opens the branch list.
  function toggleBranchPicker() {
    gitInitialView = "branches";
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
    if (!targetTabId) return;
    // A branch checked out elsewhere names that existing worktree. Navigating
    // there avoids turning the selection into a request for another worktree.
    const entry = worktrees.find((worktree) => worktree.branch === branch);
    if (entry) {
      await selectWorktree(entry);
      return;
    }
    const ok = await session.switchToBranch(branch, targetTabId);
    if (!ok) {
      requestInputFocus({ tabId: targetTabId });
      return;
    }
    settleOnDestination();
  }

  async function selectWorktree(worktree: WorktreeEntry) {
    // Honour this header's own tab: the editor input bar mounts one per pane,
    // so a split pane must not retarget the primary chat.
    await session.switchToWorktree(worktree.path, targetTabId ?? undefined);
    settleOnDestination();
  }

  function selectProject(path: string) {
    void session.setBaseDirectory(path, targetTabId).then(
      () => requestInputFocus({ tabId: targetTabId }),
      () => {},
    );
  }

  function browseProjects() {
    window.dispatchEvent(
      new CustomEvent("solus:open-project", { detail: { tabId: targetTabId } }),
    );
  }

  function selectTask(next: TaskTarget) {
    const target = session.sessionFor(targetTabId);
    if (!target) return;
    Object.assign(target, taskTargetFields(next));
  }

  function settleOnDestination() {
    const targetSession = targetTabId
      ? session.sessionFor(targetTabId)
      : undefined;
    const nextCwd =
      targetSession?.run.gitContext?.worktreePath ??
      targetSession?.run.workingDirectory ??
      session.globalDefaults.gitContext?.worktreePath ??
      session.globalDefaults.workingDirectory;
    if (nextCwd) void environmentStore.refresh(nextCwd, { force: true });
    requestInputFocus(targetTabId ? { tabId: targetTabId } : undefined);
  }
</script>

<!--
  Destination strip: where the next session will run, as three chips that each
  answer one question — which project, what it starts in, which branch. Sits
  above the composer card and only while the session has not started, because
  that is exactly how long any of it is editable.
-->
<div class="flex items-center gap-1.5 px-3.5 pb-2">
  <ProjectChip
    run={sess?.run ?? session.defaultRunConfig}
    projectDir={gitHome.projectRoot ?? projectDir}
    label={projectLabel}
    onSelect={selectProject}
    onBrowse={browseProjects}
    onDismiss={() => requestInputFocus({ tabId: targetTabId })}
  />

  {#if hasGitRepository}
    <RunOnPicker
      tabId={targetTabId}
      variant="header"
      {startsNewWorktree}
      inWorktree={env.isolated}
      {canToggleWorktree}
      {worktreeForced}
      setWorktree={toggleWorktree}
    />

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
            class="group relative h-auto min-w-0 gap-1.5 rounded-lg px-2 py-1 text-[0.8125rem] font-normal tracking-[-0.006em] transition-[background-color,color,scale] duration-[var(--duration-quick)] ease-(--ease-premium) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-0 after:absolute after:left-0 after:top-1/2 after:h-10 after:w-full after:-translate-y-1/2 after:content-[''] {gitOpen
              ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
              : 'text-(--solus-text-tertiary) hover:bg-[color-mix(in_srgb,var(--solus-surface-hover)_60%,transparent)] hover:text-(--solus-text-secondary) focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-secondary)'}"
          >
            <GitBranchIcon
              size={14}
              class="shrink-0 text-(--solus-text-tertiary) transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {gitOpen
                ? 'opacity-100'
                : 'opacity-70'}"
            />
            <span class="truncate">{branchLabel}</span>
          </Button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={branchTooltip} />
    </TooltipUI.Root>
  {/if}
  <TaskPicker
    task={sess ? taskTargetOf(sess) : { kind: "new" }}
    projectKey={gitHome.projectRoot ?? projectDir}
    onSelect={selectTask}
    onDismiss={() => requestInputFocus({ tabId: targetTabId })}
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
    selectedBranch={worktreeBaseBranch ?? displayBranch}
    workingDirectory={gitStatusCwd}
    onSelectBranch={selectBranch}
    onSelectWorktree={selectWorktree}
  />
{/if}
