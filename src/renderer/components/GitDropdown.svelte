<script lang="ts">
  import { CheckIcon, GitBranchIcon, PlusIcon, SpinnerGapIcon, TreeStructureIcon } from "phosphor-svelte";
  import { getSessionEnvironmentStore, getWorkspaceContext } from "../contexts";
  import * as Popover from "./ui/popover";
  import * as Command from "./ui/command";
  import { MenuFooter, MenuSearch } from "./ui/menu";
  import { requestInputFocus } from "../lib/inputFocus";
  import {
    worktreeProjectRoot,
    type IpcContext,
    type RunConfig,
    type WorktreeEntry,
  } from "../../shared/types";

  type View = "worktrees" | "branches";

  interface Props {
    open: boolean;
    triggerEl: HTMLElement | null;
    /** The branch the trigger names — it leads the list as "where you are". */
    displayBranch: string;
    /** Which row carries the check. Picking a branch means different things per
     *  call site (the base a worktree cuts from, the environment you move to),
     *  so the marked row is told rather than inferred. */
    selectedBranch: string | null;
    workingDirectory: string;
    /** A pending dispatch offers target-host worktrees first, then origin
     *  branches that still need a worktree on that host. */
    run?: RunConfig;
    initialView?: View;
    /** The composer's trigger sits at the bottom of the window and the project
     *  panel's at the right edge, so each list opens away from its own edge. */
    side?: "top" | "bottom" | "left";
    onSelectBranch: (branch: string) => void;
    onSelectWorktree: (worktree: WorktreeEntry) => void;
    onSelectNewWorktree?: (baseBranch?: string) => void;
    /** Return focus to the surface that owns this menu once it closes. */
    onDismiss?: () => void;
  }
  let {
    open = $bindable(),
    triggerEl,
    displayBranch,
    selectedBranch,
    workingDirectory,
    run,
    initialView = "branches",
    side = "bottom",
    onSelectBranch,
    onSelectWorktree,
    onSelectNewWorktree,
    onDismiss,
  }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();

  let view = $state<View>("branches");
  let query = $state("");

  const projectRoot = $derived(
    workingDirectory && workingDirectory !== "~"
      ? worktreeProjectRoot(workingDirectory)
      : null,
  );
  const repoCtx = $derived<IpcContext | null>(
    projectRoot ? session.ctxForDirectory(projectRoot) : null,
  );
  const gitRefs = $derived(environmentStore.refsFor(projectRoot));
  const pendingDispatch = $derived(
    run?.pendingHostDispatch?.intent === "dispatch"
      ? run.pendingHostDispatch
      : null,
  );
  const worktrees = $derived(
    pendingDispatch
      ? environmentStore.dispatchWorktreesFor(run)
      : gitRefs.worktrees,
  );
  const dispatchBranches = $derived(
    pendingDispatch ? environmentStore.dispatchBranchesFor(run) : [],
  );
  const dispatchBranchesLoading = $derived(
    pendingDispatch ? environmentStore.dispatchBranchesLoadingFor(run) : false,
  );
  const worktreeBranches = $derived(worktrees.map((w) => w.branch));
  // The branch you are on leads the list in its own right, so it must not also
  // appear under "Checked out".
  const otherWorktreeBranches = $derived(
    worktreeBranches.filter((branch) => branch !== displayBranch),
  );
  const branches = $derived([
    ...worktreeBranches,
    ...gitRefs.branches.filter((branch) => !worktreeBranches.includes(branch)),
  ]);

  $effect(() => {
    if (!open) return;
    if (pendingDispatch) {
      void environmentStore.refreshDispatchWorktrees(
        run,
        (cwd) => session.ctxForDirectory(cwd),
      );
      return;
    }
    if (projectRoot && repoCtx) void environmentStore.refreshRefs(projectRoot, repoCtx, { force: true });
  });

  $effect(() => {
    if (open) {
      view = pendingDispatch ? "worktrees" : initialView;
      query = "";
    }
  });

  function selectBranch(branch: string) {
    open = false;
    onSelectBranch(branch);
  }

  function selectWorktree(worktree: WorktreeEntry) {
    open = false;
    onSelectWorktree(worktree);
  }

  function selectNewWorktree() {
    open = false;
    onSelectNewWorktree?.();
  }

  function selectDispatchBranch(branch: string) {
    open = false;
    onSelectNewWorktree?.(branch);
  }

  function handleCloseAutoFocus(event: Event) {
    event.preventDefault();
    (onDismiss ?? requestInputFocus)();
  }
</script>

{#snippet branchItem(branch: string)}
  <Command.Item
    value={branch}
    onSelect={() => selectBranch(branch)}
    data-menu-current={branch === selectedBranch ? "" : undefined}
    class="menu-item-stagger"
  >
    <GitBranchIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
    <span class="min-w-0 flex-1 truncate">{branch}</span>
    {#if branch === selectedBranch}
      <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
    {/if}
  </Command.Item>
{/snippet}

{#if displayBranch}
  <Popover.Root bind:open>
    <!-- rounded-2xl, the background and the shadow restate `menu-surface` so
         tailwind-merge drops Popover.Content's stock rounded-lg + bg-popover +
         shadow-md, which are emitted after the utility and would otherwise win
         the cascade — bg-popover is what made this panel a different colour from
         the DropdownMenu-based ones. `lg:text-menu` is the same move for the
         primitive's `lg:text-sm`: a different breakpoint is a different
         merge group, so the bare `text-menu` never touches it and the 15px won
         at every window wider than 1024px. -->
    <Popover.Content
      data-solus-ui
      customAnchor={triggerEl}
      {side}
      align="start"
      sideOffset={6}
      collisionPadding={8}
      onCloseAutoFocus={handleCloseAutoFocus}
      onInteractOutside={(event) => { if (triggerEl?.contains(event.target as Node)) event.preventDefault() }}
      class="menu-surface z-[10002] w-[316px] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-menu lg:text-menu shadow-[shadow:var(--solus-menu-shadow)] ring-0"
    >
      {#if view === "worktrees"}
        <Command.Root>
          <MenuSearch bind:value={query} placeholder="Search worktrees" />
          <Command.List class="max-h-[224px] p-1.5">
            <Command.Empty class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)">No worktrees found</Command.Empty>
            <Command.Group heading="Worktrees">
              {#if pendingDispatch}
                <Command.Item
                  value="New worktree"
                  onSelect={selectNewWorktree}
                  data-menu-current={!pendingDispatch.worktree && !pendingDispatch.baseBranch ? "" : undefined}
                  class="menu-item-stagger"
                >
                  <PlusIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
                  <span class="min-w-0 flex-1 truncate">New worktree</span>
                  {#if !pendingDispatch.worktree && !pendingDispatch.baseBranch}
                    <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
                  {/if}
                </Command.Item>
              {/if}
              {#each worktrees as worktree (worktree.path)}
                <Command.Item
                  value={`${worktree.branch} ${worktree.path}`}
                  onSelect={() => selectWorktree(worktree)}
                  data-menu-current={pendingDispatch?.worktree?.path === worktree.path || (!pendingDispatch && worktree.branch === displayBranch) ? "" : undefined}
                  class="menu-item-stagger"
                >
                  <TreeStructureIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
                  <span class="min-w-0 flex-1 truncate">{worktree.branch}</span>
                  {#if pendingDispatch?.worktree?.path === worktree.path}
                    <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
                  {/if}
                </Command.Item>
              {/each}
            </Command.Group>
            {#if pendingDispatch && (dispatchBranchesLoading || dispatchBranches.length > 0)}
              <Command.Group heading="Origin branches">
                {#if dispatchBranchesLoading}
                  <Command.Item
                    value="Loading remote branches"
                    disabled
                    class="pointer-events-none text-(--solus-text-tertiary)"
                  >
                    <SpinnerGapIcon size={13} class="shrink-0 animate-spin motion-reduce:animate-none" />
                    <span class="min-w-0 flex-1 truncate">
                      {dispatchBranches.length > 0 ? "Updating origin branches…" : "Loading origin branches…"}
                    </span>
                  </Command.Item>
                {/if}
                {#each dispatchBranches as branch (branch)}
                  <Command.Item
                    value={`remote ${branch}`}
                    onSelect={() => selectDispatchBranch(branch)}
                    data-menu-current={pendingDispatch.baseBranch === branch ? "" : undefined}
                    class="menu-item-stagger"
                  >
                    <GitBranchIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
                    <span class="min-w-0 flex-1 truncate">{branch}</span>
                    {#if pendingDispatch.baseBranch === branch}
                      <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
                    {/if}
                  </Command.Item>
                {/each}
              </Command.Group>
            {/if}
          </Command.List>
        </Command.Root>
        <MenuFooter
          hints={[["⏎", pendingDispatch ? "select" : "switch"]]}
          summary={pendingDispatch
            ? dispatchBranchesLoading
              ? `${worktrees.length} worktrees · loading origin branches`
              : `${worktrees.length} worktrees · ${dispatchBranches.length} origin branches`
            : `${worktrees.length} worktrees`}
        />
      {:else}
        <Command.Root>
          <MenuSearch bind:value={query} placeholder="Search branches" />
          <Command.List class="max-h-[288px] overflow-y-auto p-1.5">
            <Command.Empty class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)">No branches found</Command.Empty>

            <!--
              Where you already are leads the list: selecting it starts from the
              checkout as it stands, carrying whatever is uncommitted here, which
              no branch below it would.
            -->
            <Command.Group>
              {@render branchItem(displayBranch)}
            </Command.Group>

            <!-- Branches already checked out somewhere are worth telling apart:
                 cutting a worktree from one of them lands on a tree in use. -->
            {#if otherWorktreeBranches.length > 0}
              <Command.Group heading="Checked out">
                {#each otherWorktreeBranches as branch (branch)}
                  {@render branchItem(branch)}
                {/each}
              </Command.Group>
            {/if}
            <Command.Group heading="Branches">
              {#each branches.filter((branch) => branch !== displayBranch && !worktreeBranches.includes(branch)) as branch (branch)}
                {@render branchItem(branch)}
              {/each}
            </Command.Group>
          </Command.List>
        </Command.Root>
        <MenuFooter hints={[["⏎", "check out"]]} summary="{branches.length} branches" />
      {/if}
    </Popover.Content>
  </Popover.Root>
{/if}
