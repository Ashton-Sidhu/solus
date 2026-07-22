<script lang="ts">
  import {
    FolderOpenIcon,
    GitBranchIcon,
    GitForkIcon,
  } from "phosphor-svelte";
  import type { Snippet } from "svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import { getStatusBarContext } from "../../contexts/status-bar.context.svelte";
  import { getSessionEnvironmentStore } from "../../contexts/session-environment.store.svelte";
  import { runtime } from "../../contexts/runtime.svelte";
  import { displayDirName } from "../../lib/paths";
  import ContextMeter from "../ContextMeter.svelte";
  import SettingsPopover from "../SettingsPopover.svelte";
  import GitDropdown from "../GitDropdown.svelte";
  import ServerSwitcher from "../servers/ServerSwitcher.svelte";
  import { tooltip } from "../../lib/tooltip";
  import { comboHint } from "../../lib/keybindings/manifest";

  interface Props {
    dirMaxWidth?: number;
    mode?: "pill" | "editor";
    showDirIcon?: boolean;
    tabId?: string;
    trailingActions?: Snippet;
  }
  let { dirMaxWidth = 160, mode = "pill", showDirIcon = true, tabId, trailingActions }: Props = $props();

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const statusBar = getStatusBarContext();
  const environmentStore = getSessionEnvironmentStore();
  const isPinned = $derived(tabId !== undefined);
  const targetTabId = $derived(tabId ?? session.activeTabId);
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

  const projectDir = $derived(sess?.workingDirectory ?? session.globalDefaults.workingDirectory ?? "~");
  const defaultGitContext = $derived(session.tabCtx.gitContext);
  const worktreePath = $derived(sess?.gitContext?.worktreePath ?? defaultGitContext?.worktreePath ?? null);
  const gitStatusCwd = $derived(worktreePath ?? projectDir);
  const git = $derived(environmentStore.statusFor(gitStatusCwd));
  $effect(() => {
    if (mode !== "pill") return;
    const cwd = gitStatusCwd;
    if (!cwd || cwd === "~") return;
    void environmentStore.refresh(cwd);
  });

  const worktreeBaseBranch = $derived(
    sess?.worktreeBaseBranch ??
      (!sess && session.settings.worktreeEnabled
        ? (git?.targetBranch ?? null)
        : null),
  );
  // One environment model drives the pill echo. displayBranch stays the raw
  // branch (the GitDropdown switches by exact name); pending comes from env.
  const env = $derived(environmentStore.environmentFor(targetTabId));
  const worktreeModePending = $derived(env.pending);
  const creatingWorktree = $derived(session.isContinuingInWorktree(targetTabId));
  // While the worktree is being created, hold the pending label instead of the
  // live base branch so the pill doesn't read "main" and then teleport.
  const displayBranch = $derived(
    creatingWorktree
      ? "Creating worktree"
      : worktreeModePending
        ? env.name
        : git === undefined
          ? env.branch
          : (git?.branch ?? null),
  );

  let gitOpen = $state(false);
  let gitInitialView: "menu" | "worktrees" | "branches" = $state("menu");
  let gitTriggerEl: HTMLButtonElement | null = $state(null);
  // This cluster now lives on the full-width input toolbar row, so the old
  // width-based collapse no longer applies: dir + usage always show, and branch
  // shows in pill mode as before. Text truncates to degrade gracefully.
  const showBranch = $derived(mode === "pill");
  const showDirLabel = true;
  const showUsage = true;

  $effect(() => {
    if (isPinned) return;
    const handler = () => {
      if (mode !== windowCtx.viewMode || !displayBranch) return;
      if (gitOpen) {
        gitOpen = false;
      } else {
        gitInitialView = "worktrees";
        gitOpen = true;
      }
    };
    window.addEventListener("solus:toggle-git-dropdown", handler);
    return () =>
      window.removeEventListener("solus:toggle-git-dropdown", handler);
  });

  function handleChooseDirectory() {
    // The directory picker targets the active tab; a pinned strip shows the
    // directory as a plain label instead.
    if (isBusy || isPinned) return;
    window.dispatchEvent(new CustomEvent("solus:open-directory-picker"));
  }

  function toggleGitMenu() {
    if (!displayBranch) return;
    gitInitialView = "menu";
    gitOpen = !gitOpen;
  }

</script>

<!--
  The dir/branch + usage + server/settings cluster. Rendered inline on the
  input toolbar row (right of the mode/model pills), so it stays compact rather
  than spanning a full-width status bar.
-->
<div class="relative flex min-w-0 items-center gap-2 text-[0.8125rem]">
  <!-- Project info (dir + branch). -->
  {@render projectInfo()}

  {#if showUsage}
    <ContextMeter tabId={targetTabId} />
  {/if}
  {#if !isPinned}
    {#if session.runtimeSyncing}
      <span
        class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-(--solus-surface-hover) px-2 text-[0.75rem] tabular-nums text-(--solus-text-tertiary)"
        use:tooltip={"Syncing runtime state"}
      >
        <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-(--solus-status-complete)"></span>
        <span>Syncing...</span>
      </span>
    {/if}
    <ServerSwitcher />
  {/if}
  {#if !runtime.isMobileViewport && mode !== "editor"}
    <SettingsPopover />
  {/if}
  {@render trailingActions?.()}
</div>

{#if mode === "pill" && displayBranch}
  <GitDropdown
    bind:open={gitOpen}
    initialView={gitInitialView}
    triggerEl={gitTriggerEl}
    {displayBranch}
    {worktreePath}
    {worktreeBaseBranch}
    tabId={tab?.id ?? null}
    workingDirectory={ctx.workingDirectory}
  />
{/if}

{#snippet projectInfo()}
  <div
    class="flex items-center gap-2.5 min-w-0 overflow-hidden text-(--solus-text-tertiary)"
  >
    <button
      onclick={handleChooseDirectory}
      disabled={isBusy || isPinned}
      class="flex items-center gap-1 shrink-0 transition-[color,opacity] text-(--solus-text-tertiary) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:text-(--solus-text-primary)"
      style="max-width:{dirMaxWidth}px;cursor:{isPinned ? 'default' : isBusy ? 'not-allowed' : 'pointer'};opacity:{isBusy ? 0.5 : 1}"
      use:tooltip={isPinned
        ? dirTooltip
        : `${dirTooltip} — click or press ${comboHint("global.select-project")} to change`}
    >
      {#if showDirIcon}
        <FolderOpenIcon size={13} class="flex-shrink-0 opacity-50" />
      {/if}
      {#if showDirLabel}
        <span class="truncate">{displayDir}</span>
      {/if}
    </button>

    {#if showBranch && displayBranch}
      <button
        bind:this={gitTriggerEl}
        type="button"
        onclick={toggleGitMenu}
        aria-haspopup="menu"
        aria-expanded={gitOpen}
        class="flex items-center gap-1 min-w-0 text-(--solus-text-tertiary) cursor-pointer transition-[color] hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:text-(--solus-text-primary)"
        style="max-width:16rem"
        use:tooltip={displayBranch}
      >
        <GitBranchIcon size={12} class="flex-shrink-0 opacity-50" />
        <span class="truncate">{displayBranch}</span>
        {#if creatingWorktree || worktreeModePending}
          <GitForkIcon
            size={9}
            class={`flex-shrink-0 text-(--solus-accent) ${creatingWorktree ? "animate-spin" : ""}`}
          />
          <span class="flex-shrink-0 text-[0.625rem] text-(--solus-accent)">Creating…</span>
        {/if}
      </button>
    {/if}

  </div>
{/snippet}
