<script lang="ts">
  import {
    FolderOpenIcon,
    GitBranchIcon,
    GitForkIcon,
  } from "phosphor-svelte";
  import type { Snippet } from "svelte";
  import {
    getWorkspaceContext,
    getWindowContext,
    getStatusBarContext,
    getSessionEnvironmentStore,
  } from "../../contexts";
  import { displayDirName } from "../../lib/paths";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { WorktreeEntry } from "../../../shared/types";
  import ContextMeter from "../ContextMeter.svelte";
  import GitDropdown from "../GitDropdown.svelte";
  import RunOnPicker from "../servers/RunOnPicker.svelte";
  import { isRunOnHostLocked } from "../servers/run-on";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { comboHint } from "../../lib/keybindings/manifest";

  interface Props {
    mode?: "pill" | "editor";
    showDirIcon?: boolean;
    tabId?: string;
    /** These are the workspace's own controls, not a pane's. */
    isPrimary?: boolean;
    trailingActions?: Snippet;
  }
  let { mode = "pill", showDirIcon = true, tabId, isPrimary = false, trailingActions }: Props = $props();

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const statusBar = getStatusBarContext();
  const environmentStore = getSessionEnvironmentStore();
  // "Pinned" means these controls belong to a pane of their own rather than to
  // the workspace's composer — the workspace one is the only place that opens a
  // project or answers the git-dropdown shortcut. A draft's composer is neither
  // and names no tab, so nothing here falls back to whichever tab is active.
  const isPinned = $derived(!isPrimary);
  const targetTabId = $derived(tabId ?? "");
  const ctx = $derived(statusBar.ctxFor(targetTabId));
  const tab = $derived(session.tabs[targetTabId]);
  const sess = $derived(session.sessionFor(targetTabId));
  const isBusy = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const displayDir = $derived(
    displayDirName(ctx.workingDirectory, session.staticInfo?.workspacePath),
  );
  const dirTooltip = $derived(ctx.workingDirectory);
  const projectDir = $derived(sess?.run.workingDirectory ?? session.globalDefaults.workingDirectory ?? "~");
  const defaultGitContext = $derived(session.tabCtx.gitContext);
  const worktreePath = $derived(sess?.run.gitContext?.worktreePath ?? defaultGitContext?.worktreePath ?? null);
  const gitStatusCwd = $derived(worktreePath ?? projectDir);
  const git = $derived(environmentStore.statusFor(gitStatusCwd));
  $effect(() => {
    if (mode !== "pill") return;
    const cwd = gitStatusCwd;
    if (!cwd || cwd === "~") return;
    void environmentStore.refresh(cwd);
  });

  const worktreeBaseBranch = $derived(
    sess?.run.worktree?.baseBranch ??
      (!sess && session.settings.worktreeEnabled
        ? (git?.targetBranch ?? null)
        : null),
  );
  // One environment model drives the pill echo. displayBranch stays the raw
  // branch (the GitDropdown switches by exact name); pending comes from env.
  const env = $derived(environmentStore.environmentFor(session.sessionFor(targetTabId)?.run));
  const worktrees = $derived(
    environmentStore.refsFor(env.repoRoot ?? git?.repoRoot).worktrees,
  );
  const worktreeModePending = $derived(env.pending);
  const creatingWorktree = $derived(session.isContinuingInWorktree(targetTabId));
  // While the worktree is being created, hold the pending label instead of the
  // live base branch so the pill doesn't read "main" and then teleport.
  const pendingDispatch = $derived(
    sess?.run.pendingHostDispatch?.intent === "dispatch"
      ? sess.run.pendingHostDispatch
      : null,
  );
  const selectedDispatchWorktree = $derived(pendingDispatch?.worktree ?? null);
  const selectedDispatchBaseBranch = $derived(pendingDispatch?.baseBranch ?? null);
  const displayBranch = $derived(
    selectedDispatchWorktree?.branch ?? selectedDispatchBaseBranch ?? (pendingDispatch
      ? "New worktree"
      : creatingWorktree
      ? "Creating worktree"
      : worktreeModePending
        ? env.name
        : git === undefined
          ? env.branch
          : (git?.branch ?? null)),
  );

  let gitOpen = $state(false);
  let gitInitialView: "worktrees" | "branches" = $state("branches");
  let gitTriggerEl: HTMLButtonElement | null = $state(null);
  // This cluster now lives on the full-width input toolbar row, so the old
  // width-based collapse no longer applies: dir + usage always show, and branch
  // shows in pill mode as before. Text truncates to degrade gracefully.
  const showBranch = $derived(mode === "pill");
  const showDirLabel = true;
  const showUsage = $derived(mode !== "pill");

  $effect(() => {
    if (isPinned) return;
    const handler = (event: Event) => {
      if (mode !== windowCtx.viewMode || !displayBranch) return;
      if (gitOpen) {
        gitOpen = false;
      } else {
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

  function handleChooseDirectory() {
    // The Open project flow targets the active tab; a pinned strip shows the
    // directory as a plain label instead.
    if (isBusy || isPinned) return;
    window.dispatchEvent(new CustomEvent("solus:open-project"));
  }

  // The pill names a branch, so it always opens the branch list.
  function toggleGitMenu() {
    if (!displayBranch) return;
    gitInitialView = pendingDispatch ? "worktrees" : "branches";
    gitOpen = !gitOpen;
  }

  async function selectBranch(branch: string) {
    if (!tab?.id) return;
    if (pendingDispatch) return;
    const entry = worktrees.find((worktree) => worktree.branch === branch);
    if (entry) {
      await selectWorktree(entry);
      return;
    }
    const ok = await session.switchToBranch(branch, tab.id);
    if (!ok) {
      requestInputFocus({ tabId: tab.id });
      return;
    }
    settleOnDestination(tab.id);
  }

  async function selectWorktree(worktree: WorktreeEntry) {
    if (pendingDispatch && tab?.id) {
      session.setDispatchWorktree(worktree, tab.id);
      requestInputFocus({ tabId: tab.id });
      return;
    }
    await session.switchToWorktree(worktree.path, tab?.id);
    settleOnDestination(tab?.id);
  }

  function selectNewDispatchWorktree(baseBranch?: string) {
    if (!tab?.id) return;
    if (baseBranch) session.setDispatchBaseBranch(baseBranch, tab.id);
    else session.setDispatchWorktree(null, tab.id);
    requestInputFocus({ tabId: tab.id });
  }

  function settleOnDestination(destinationTabId?: string) {
    const targetSession = destinationTabId
      ? session.sessionFor(destinationTabId)
      : undefined;
    const nextCwd =
      targetSession?.run.gitContext?.worktreePath ??
      targetSession?.run.workingDirectory ??
      session.globalDefaults.gitContext?.worktreePath ??
      session.globalDefaults.workingDirectory;
    if (nextCwd) void environmentStore.refresh(nextCwd, { force: true });
    requestInputFocus(destinationTabId ? { tabId: destinationTabId } : undefined);
  }

</script>

<!--
  The dir/branch + destination cluster. Rendered inline on the input toolbar
  row (right of the mode/model pills), so it stays compact rather than spanning
  a full-width status bar. Editor mode keeps context usage here; Pill mode puts
  it in the tab-strip action cluster.
-->
<div class="relative flex min-w-0 items-center gap-2 text-[0.8125rem]">
  <!-- Project info (dir + branch). Editor mode says this in the input bar's
       header strip instead, where it can also be changed. -->
  {#if mode === "pill"}
    {@render projectInfo()}
  {/if}

  {#if showUsage}
    <ContextMeter tabId={targetTabId} />
  {/if}
  <!-- Transient status, not destination config, so it stays in both modes. -->
  {#if !isPinned && session.runtimeSyncing}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <span {...tooltipProps}
      class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-(--solus-surface-hover) px-2 text-xs tabular-nums text-(--solus-text-tertiary)"
    >
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-(--solus-status-complete)"></span>
      <span>Syncing...</span>
    </span>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={"Syncing runtime state"} />
    </TooltipUI.Root>
  {/if}
  {#if mode === "pill" && !isPinned}
    <RunOnPicker
      run={sess?.run ?? session.defaultRunConfig}
      requesterId={targetTabId}
      locked={isRunOnHostLocked(sess)}
      onRun={(next) => {
        if (sess) sess.run = next;
      }}
    />
  {/if}
  {@render trailingActions?.()}
</div>

{#if mode === "pill" && displayBranch}
  <GitDropdown
    bind:open={gitOpen}
    initialView={gitInitialView}
    triggerEl={gitTriggerEl}
    {displayBranch}
    selectedBranch={selectedDispatchWorktree?.branch ?? selectedDispatchBaseBranch ?? worktreeBaseBranch ?? displayBranch}
    workingDirectory={ctx.workingDirectory}
    run={sess?.run}
    onSelectBranch={selectBranch}
    onSelectWorktree={selectWorktree}
    onSelectNewWorktree={selectNewDispatchWorktree}
  />
{/if}

{#snippet projectInfo()}
  <div
    class="flex items-center gap-2.5 min-w-0 overflow-hidden text-(--solus-text-tertiary)"
  >
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button {...tooltipProps}
      onclick={handleChooseDirectory}
      disabled={isBusy || isPinned}
      class="flex items-center gap-1 shrink-0 transition-[color,opacity] text-(--solus-text-tertiary) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:text-(--solus-text-primary)"
      style="max-width:240px;cursor:{isPinned ? 'default' : isBusy ? 'not-allowed' : 'pointer'};opacity:{isBusy ? 0.5 : 1}"
    >
      {#if showDirIcon}
        <FolderOpenIcon size={13} class="flex-shrink-0 opacity-50" />
      {/if}
      {#if showDirLabel}
        <span class="truncate">{displayDir}</span>
      {/if}
    </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={isPinned
        ? dirTooltip
        : {
            label: "Change the project for this chat",
            shortcut: comboHint("global.select-project"),
          }} />
    </TooltipUI.Root>

    {#if showBranch && displayBranch}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <button {...tooltipProps}
        bind:this={gitTriggerEl}
        type="button"
        onclick={toggleGitMenu}
        aria-haspopup="menu"
        aria-expanded={gitOpen}
        class="flex items-center gap-1 min-w-0 text-(--solus-text-tertiary) cursor-pointer transition-[color] hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:text-(--solus-text-primary)"
        style="max-width:16rem"
      >
        {#if pendingDispatch}
          <GitForkIcon size={12} class="flex-shrink-0 opacity-50" />
        {:else}
          <GitBranchIcon size={12} class="flex-shrink-0 opacity-50" />
        {/if}
        <span class="truncate">{displayBranch}</span>
        {#if creatingWorktree || worktreeModePending}
          <GitForkIcon
            size={9}
            class={`flex-shrink-0 text-(--solus-accent) ${creatingWorktree ? "animate-spin" : ""}`}
          />
          <span class="flex-shrink-0 text-xs text-(--solus-accent)">Creating…</span>
        {/if}
      </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={displayBranch} />
      </TooltipUI.Root>
    {/if}

  </div>
{/snippet}
