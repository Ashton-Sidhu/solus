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
  import * as Popover from "./ui/popover";
  import * as Command from "./ui/command";
  import Kbd from "./ui/Kbd.svelte";
  import { requestInputFocus } from "../lib/inputFocus";
  import { worktreeProjectRoot, type IpcContext } from "../../shared/types";
  import { getWindowContext } from "../contexts/window.context.svelte";
  import { connectionsStore } from "../contexts/connections.store.svelte";
  import { LOCAL_SERVER_ID } from "@client-core/server-registry";
  import { serversStore } from "./servers/servers.store.svelte";
  import { tooltip } from "../lib/tooltip";

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
  const sess = $derived(session.sessionFor(tabId));
  const remoteHost = $derived(
    sess?.serverId && sess.serverId !== LOCAL_SERVER_ID
      ? (serversStore.servers.find((server) => server.id === sess.serverId) ?? { label: "remote host" })
      : null,
  );
  const terminalTooltip = $derived(
    remoteHost ? `Runs on ${remoteHost.label} — not available for remote sessions` : null,
  );

  let copied = $state(false);
  let view = $state<View>("menu");
  let query = $state("");

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
      query = "";
    } else {
      view = "menu";
    }
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
    if (!ctx || !desktopHandlersAvailable || remoteHost) return;
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
    query = "";
  }

  function openBranchView() {
    if (!repoCtx) return;
    if (projectRoot) void gitStatus.refreshRefs(projectRoot, repoCtx, { force: true });
    view = "branches";
    query = "";
  }

  function goBack() {
    view = "menu";
    query = "";
  }

  const menuItemClass =
    "w-full flex items-center justify-between gap-2 px-3 py-1.5 text-[0.6875rem] text-(--solus-text-secondary) transition-[background-color,color] hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary)";
</script>

{#if displayBranch}
  <Popover.Root bind:open onOpenChange={(next) => { if (!next) requestInputFocus() }}>
    <Popover.Content
      data-solus-ui
      customAnchor={triggerEl}
      side={dropDown ? "top" : "bottom"}
      align="start"
      sideOffset={6}
      collisionPadding={8}
      onInteractOutside={(event) => { if (triggerEl?.contains(event.target as Node)) event.preventDefault() }}
      class="z-[10002] w-[232px] gap-0 overflow-hidden rounded-xl border-(--solus-popover-border) bg-(--solus-popover-bg) p-0 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl"
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
            disabled={!!remoteHost}
            class={menuItemClass}
            use:tooltip={terminalTooltip}
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

        <Command.Root>
          <div class="mx-2 mb-1.5 flex items-center rounded-lg border border-(--solus-popover-border) bg-(--solus-surface-hover) px-2">
            <Command.Input bind:value={query} placeholder="Filter worktrees..." class="h-7 text-[0.6875rem]" />
          </div>
          <Command.List class="max-h-[196px]">
            <Command.Empty class="px-3 py-2 text-center text-[0.6875rem] text-(--solus-text-tertiary)">No worktrees found</Command.Empty>
            {#each worktrees as worktree (worktree.branch)}
              <Command.Item value={worktree.branch} onSelect={() => selectWorktree(worktree.branch)} class="rounded-none px-3 py-1.5 text-[0.6875rem] text-(--solus-text-secondary) data-[selected]:bg-(--solus-accent-light) data-[selected]:text-(--solus-text-primary)">
                <span class="truncate">{worktree.branch}</span>
              </Command.Item>
            {/each}
          </Command.List>
        </Command.Root>
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

        <Command.Root>
          <div class="mx-2 mb-1.5 flex items-center rounded-lg border border-(--solus-popover-border) bg-(--solus-surface-hover) px-2">
            <Command.Input bind:value={query} placeholder="Filter branches..." class="h-7 text-[0.6875rem]" />
          </div>
          <Command.List class="max-h-[196px]">
            <Command.Empty class="px-3 py-2 text-center text-[0.6875rem] text-(--solus-text-tertiary)">No branches found</Command.Empty>
            {#each branches as branch (branch)}
              <Command.Item value={branch} onSelect={() => selectBranch(branch)} class="rounded-none px-3 py-1.5 text-[0.6875rem] text-(--solus-text-secondary) data-[selected]:bg-(--solus-accent-light) data-[selected]:text-(--solus-text-primary)">
                <span class="truncate">{branch}</span>
                {#if branch === worktreeBaseBranch}<CheckIcon size={12} class="ml-auto text-(--solus-accent)" />{/if}
              </Command.Item>
            {/each}
          </Command.List>
        </Command.Root>
      {/if}
    </div>
    </Popover.Content>
  </Popover.Root>
{/if}
