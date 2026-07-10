<script lang="ts">
  import {
    ArrowLeftIcon,
    CaretRightIcon,
    CheckIcon,
    CopyIcon,
    GitForkIcon,
    TerminalWindowIcon,
    TreeStructureIcon,
    XIcon,
  } from "phosphor-svelte";
  import { getGitStatusStore } from "../contexts/git-status.store.svelte";
  import { getWorkspaceContext } from "../contexts/workspace.context.svelte";
  import SearchablePickerList from "./pickers/SearchablePickerList.svelte";
  import Dropdown from "./ui/Dropdown.svelte";
  import Kbd from "./ui/Kbd.svelte";
  import { requestInputFocus } from "../lib/inputFocus";
  import { worktreeProjectRoot, type IpcContext } from "../../shared/types";
  import { getWindowContext } from "../contexts/window.context.svelte";
  import { connectionsStore } from "../contexts/connections.store.svelte";

  type View = "menu" | "worktrees" | "branches";

  interface Props {
    open: boolean;
    triggerEl: HTMLButtonElement | null;
    displayBranch: string;
    worktreePath: string | null;
    worktreeBaseBranch: string | null;
    tabId: string | null;
    workingDirectory: string;
    initialView?: View;
    dropDown?: boolean;
  }
  let {
    open = $bindable(),
    triggerEl,
    displayBranch,
    worktreePath,
    worktreeBaseBranch,
    tabId,
    workingDirectory,
    initialView = "menu",
    dropDown = false,
  }: Props = $props();

  const session = getWorkspaceContext();
  const gitStatus = getGitStatusStore();
  const windowCtx = getWindowContext();
  const desktopHandlersAvailable = $derived(connectionsStore.desktopHandlersAvailable);

  let copied = $state(false);
  let view = $state<View>("menu");
  let pickerRef: SearchablePickerList | null = $state(null);

  const hasActiveSession = $derived(
    !!session.sessionFor(tabId)?.agentSessionId,
  );
  const showBranchPicker = $derived(!!worktreeBaseBranch && !worktreePath);
  const projectRoot = $derived(
    workingDirectory && workingDirectory !== "~"
      ? worktreeProjectRoot(workingDirectory)
      : null,
  );
  const repoCtx = $derived<IpcContext | null>(
    projectRoot ? session.ctxForDirectory(projectRoot) : null,
  );
  const gitRefs = $derived(gitStatus.refsFor(projectRoot));
  const worktrees = $derived(gitRefs.worktrees);
  const worktreeBranches = $derived(worktrees.map((w) => w.branch));
  const branches = $derived([
    ...worktreeBranches,
    ...gitRefs.branches.filter((branch) => !worktreeBranches.includes(branch)),
  ]);
  const tabCtx = $derived<IpcContext | null>(
    tabId ? session.ctxFor(tabId) : null,
  );

  $effect(() => {
    if (open && projectRoot && repoCtx) void gitStatus.refreshRefs(projectRoot, repoCtx, { force: true });
  });

  $effect(() => {
    if (open) {
      view = initialView;
    } else {
      view = "menu";
    }
  });

  $effect(() => {
    if (!open) return;
    const onKeydown = (e: KeyboardEvent) => handleKeydown(e);
    document.addEventListener("keydown", onKeydown, true);
    return () => document.removeEventListener("keydown", onKeydown, true);
  });

  async function copyBranch() {
    if (!displayBranch) return;
    try {
      await navigator.clipboard.writeText(displayBranch);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 1500);
    } catch {}
  }

  async function openTerminal() {
    const ctx = worktreePath ? (tabCtx ?? repoCtx) : repoCtx;
    if (!ctx || !desktopHandlersAvailable) return;
    open = false;
    await window.solus.openWorktreeTerminal(ctx);
  }

  function enableWorktreeMode() {
    if (!tabId || !sess || !tabCtx) return;
    session.setWorktreeBaseBranch(sess.gitContext?.targetBranch ?? null);
    if (projectRoot) void gitStatus.refreshRefs(projectRoot, tabCtx, { force: true });
    view = "branches";
  }

  function disableWorktreeMode() {
    if (!tabId) return;
    session.setWorktreeBaseBranch(null);
    view = "menu";
  }

  function selectBranch(branch: string) {
    if (!tabId) return;
    session.setWorktreeBaseBranch(branch);
  }

  async function selectWorktree(branch: string) {
    const entry = worktrees.find((w) => w.branch === branch);
    if (!entry) return;
    open = false;
    await session.switchToWorktree(entry.path);
    requestInputFocus();
  }

  function openWorktreeView() {
    view = "worktrees";
  }

  function openBranchView() {
    if (!repoCtx) return;
    if (projectRoot) void gitStatus.refreshRefs(projectRoot, repoCtx, { force: true });
    view = "branches";
  }

  function goBack() {
    view = "menu";
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      open = false;
      return;
    }
    if (view !== "menu" && pickerRef?.handleKeydown(e)) return;
  }

  const menuItemClass =
    "w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[0.6875rem] text-(--solus-text-secondary) transition-[background-color,color] hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary)";
</script>

{#if displayBranch}
  <Dropdown
    bind:open
    {triggerEl}
    align={dropDown ? "top" : "bottom"}
    anchor="left"
    width={232}
  >
    <div class="py-1">
      {#if view === "menu"}
        <!-- Copy -->
        <button
          type="button"
          role="menuitem"
          onclick={copyBranch}
          class={menuItemClass}
        >
          <span class="flex min-w-0 items-center gap-2">
            {#if copied}
              <CheckIcon
                size={12}
                class="shrink-0 text-(--solus-status-complete)"
              />
            {:else}
              <CopyIcon size={12} class="shrink-0" />
            {/if}
            <span>Copy</span>
          </span>
          {#if copied}
            <span class="text-[0.625rem] text-(--solus-status-complete)"
              >Copied</span
            >
          {/if}
        </button>

        {#if !windowCtx.isWeb && desktopHandlersAvailable}
          <!-- Terminal -->
          <button
            type="button"
            role="menuitem"
            onclick={openTerminal}
            class={menuItemClass}
          >
            <span class="flex items-center gap-2">
              <TerminalWindowIcon size={12} class="shrink-0" />
              <span
                >{worktreePath
                  ? "Open worktree in terminal"
                  : "Open repo in terminal"}</span
              >
            </span>
            <Kbd variant="inline">⌥⇧Y</Kbd>
          </button>
        {/if}

        {#if worktrees.length > 0 || !hasActiveSession}
          <div class="h-px bg-(--solus-popover-border) my-1"></div>
        {/if}

        <!-- Switch worktree -->
        {#if worktrees.length > 0}
          <button
            type="button"
            role="menuitem"
            onclick={openWorktreeView}
            class={menuItemClass}
          >
            <span class="flex items-center gap-2">
              <TreeStructureIcon size={12} class="shrink-0" />
              <span>Switch worktree</span>
            </span>
            <CaretRightIcon size={10} style="opacity:0.5" />
          </button>
        {/if}

        {#if !hasActiveSession}
          <!-- Worktree mode options — only when not already in a worktree -->
          {#if !worktreePath}
            {#if showBranchPicker}
              <button
                type="button"
                role="menuitem"
                onclick={openBranchView}
                class={menuItemClass}
              >
                <span class="flex items-center gap-2">
                  <GitForkIcon size={12} class="shrink-0" />
                  <span>Worktree from</span>
                </span>
                <CaretRightIcon size={10} style="opacity:0.5" />
              </button>

              <button
                type="button"
                role="menuitem"
                onclick={disableWorktreeMode}
                class={menuItemClass}
              >
                <span class="flex items-center gap-2">
                  <XIcon size={12} class="shrink-0" />
                  <span>Disable worktree</span>
                </span>
              </button>
            {:else}
              <button
                type="button"
                role="menuitem"
                onclick={enableWorktreeMode}
                class={menuItemClass}
              >
                <span class="flex items-center gap-2">
                  <GitForkIcon size={12} class="shrink-0" />
                  <span>Use worktree</span>
                </span>
                <Kbd variant="inline">⌥⇧B</Kbd>
              </button>
            {/if}
          {/if}
        {/if}
      {:else if view === "worktrees"}
        <!-- Back + header -->
        <button
          type="button"
          role="menuitem"
          onclick={goBack}
          class={menuItemClass}
        >
          <span class="flex items-center gap-2">
            <ArrowLeftIcon size={12} class="shrink-0" />
            <span class="font-medium">Switch worktree</span>
          </span>
        </button>
        <div class="h-px bg-(--solus-popover-border) my-1"></div>

        <SearchablePickerList
          bind:this={pickerRef}
          items={worktrees.map((w) => w.branch)}
          selected={null}
          placeholder="Filter worktrees..."
          emptyLabel="No worktrees found"
          onselect={selectWorktree}
        />
      {:else if view === "branches"}
        <!-- Back + header -->
        <button
          type="button"
          role="menuitem"
          onclick={goBack}
          class={menuItemClass}
        >
          <span class="flex items-center gap-2">
            <ArrowLeftIcon size={12} class="shrink-0" />
            <span class="font-medium">Worktree from</span>
          </span>
        </button>
        <div class="h-px bg-(--solus-popover-border) my-1"></div>

        <SearchablePickerList
          bind:this={pickerRef}
          items={branches}
          selected={worktreeBaseBranch}
          placeholder="Filter branches..."
          emptyLabel="No branches found"
          onselect={selectBranch}
        />
      {/if}
    </div>
  </Dropdown>
{/if}
