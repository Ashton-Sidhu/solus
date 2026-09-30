<script lang="ts">
  import ContentSkeleton from "../../ui/ContentSkeleton.svelte";
  import {
    LoaderCircle as CircleNotchIcon,
    Check as CheckIcon,
    Minus as MinusIcon,
    GitBranch as GitBranchIcon,
    X as XIcon,
    CircleAlert as WarningCircleIcon,
  } from "@lucide/svelte";
  import { Button } from "../../ui/button";
  import { MiddleTruncate } from "../../ui/middle-truncate";
  import { SearchField } from "../../ui/search-field";
  import { Textarea } from "../../ui/textarea";
  import { isMac } from "../../../lib/keybindings/match";
  import type {
    WorkspaceContext,
    SessionEnvironmentStore,
  } from "../../../contexts";
  import type { GitActions } from "../../../lib/git-actions.svelte";
  import type { GitAction } from "@solus/contracts/types";
  import { getPopoverLayer } from "../../popoverLayer.svelte";
  import { portal } from "../../portal";
  import { CommitComposerState } from "./lib/commit-composer.svelte";
  import { STATUS_TONE_CLASS, splitPath } from "./lib/commit-composer";
  import { changedFileTotals } from "../../../lib/diff-stats";
  import { worktreeDisplayName } from "../../../lib/git-context";

  interface Props {
    /** The tab or draft whose environment this composer commits — see `GitSection`. */
    sourceId: string;
    action: Extract<GitAction, "commit" | "commit_push">;
    session: WorkspaceContext;
    environmentStore: SessionEnvironmentStore;
    actions: GitActions;
    onClose: () => void;
  }
  let { sourceId, action, session, environmentStore, actions, onClose }: Props =
    $props();

  const env = $derived(
    environmentStore.environmentFor(session.runFor(sourceId)),
  );
  const api = $derived(session.apiFor(sourceId));

  // Portal to the app-root layer so the dialog stays centred in the app window.
  const layer = getPopoverLayer();

  const composer = new CommitComposerState();
  $effect(() => {
    void composer.load(
      api,
      session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
    );
  });

  const selectedTotals = $derived(changedFileTotals(composer.selectedFiles));

  // A short list is read at a glance; the filter earns its row only when
  // scanning would take longer than typing.
  const FILTER_MIN_FILES = 8;

  let messageEl = $state<HTMLTextAreaElement | null>(null);
  $effect(() => {
    if (composer.loading) return;
    const raf = requestAnimationFrame(() =>
      messageEl?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(raf);
  });

  const branchName = $derived(
    env.branch ? (env.isolated ? worktreeDisplayName(env.branch) : env.branch) : null,
  );
  const submitLabel = $derived(
    action === "commit_push" ? "Commit and push" : "Commit",
  );

  // The dialog owns how far the commit travels: the primary button commits as
  // far as the row does, while "Commit only" stops at the local commit.
  const canCommitOnly = $derived(action === "commit_push");
  // Which button the user pressed, so the spinner sits on that button rather
  // than on whichever one happens to be primary.
  let submittingAction = $state<GitAction | null>(null);

  async function submit(runAction: GitAction = action) {
    if (!composer.canSubmit || actions.running) return;
    submittingAction = runAction;
    await actions.run(runAction, {
      filePaths: composer.selectedPaths,
      commitMessage: composer.message.trim() || undefined,
    });
    submittingAction = null;
    if (!actions.actionError) onClose();
  }

  function onPanelKeydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!actions.running) onClose();
    }
  }
</script>

{#snippet checkbox(state: "all" | "some" | "none")}
  <span
    class="grid size-3.5 shrink-0 place-items-center rounded-[0.25rem] transition-colors duration-100 pointer-coarse:size-[1.125rem] {state ===
    'none'
      ? 'shadow-[inset_0_0_0_0.0625rem_var(--solus-container-border)]'
      : 'bg-(--solus-accent) text-white'}"
    aria-hidden="true"
  >
    {#if state === "all"}
      <CheckIcon size={10} strokeWidth={3} />
    {:else if state === "some"}
      <MinusIcon size={10} strokeWidth={3} />
    {/if}
  </span>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
{#if layer.el}
<div
  use:portal={layer.el}
  data-solus-ui
  class="fixed inset-0 z-[10008] flex items-center justify-center overflow-hidden overscroll-contain pointer-events-auto bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] [animation:commit-composer-backdrop-in_160ms_ease_both]"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && !actions.running) onClose();
  }}
  onkeydown={onPanelKeydown}
>
  <div
    class="flex max-h-[min(40rem,82svh)] w-[clamp(22rem,46vw,32rem)] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-xl max-md:max-h-[88svh] max-md:w-[calc(100vw-1.5rem)] max-md:max-w-none border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-(--solus-popover-shadow) outline-none [animation:commit-composer-enter_180ms_cubic-bezier(0.22,1,0.36,1)_backwards]"
    role="dialog"
    aria-label={submitLabel}
    aria-modal="true"
  >
    <header class="flex shrink-0 items-center gap-2 pl-4 pr-2.5 pt-3 pb-2">
      <h2
        class="shrink-0 text-workspace-chrome font-medium text-(--solus-text-primary)"
      >
        {submitLabel}
      </h2>
      {#if branchName}
        <span
          class="inline-flex min-w-0 items-center gap-1 overflow-hidden rounded-md bg-(--solus-surface-hover) px-1.5 py-0.5 text-xs text-(--solus-text-secondary)"
          title={branchName}
        >
          <GitBranchIcon size={11} class="shrink-0" />
          <MiddleTruncate value={branchName} showTitle={false} class="font-mono" />
        </span>
      {/if}
      <Button
        variant="ghost"
        size="icon-sm"
        class="ml-auto text-(--solus-text-tertiary) hover:text-(--solus-text-primary) max-md:size-10"
        onclick={onClose}
        disabled={actions.running}
        aria-label="Close"
      >
        <XIcon />
      </Button>
    </header>

    <!-- The message comes first: it is the one thing a commit always asks for,
         and the field takes focus when the dialog opens. -->
    <div class="shrink-0 px-4 pb-3">
      <Textarea
        bind:ref={messageEl}
        bind:value={composer.message}
        placeholder="Commit message — leave empty to generate one"
        aria-label="Commit message"
        rows={3}
        disabled={actions.running}
        class="max-h-40 min-h-[4.5rem] rounded-lg border-(--solus-container-border) px-3 py-2.5 text-(--solus-text-primary) shadow-none focus-visible:border-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] focus-visible:ring-0 max-md:text-base"
        onSubmit={() => void submit()}
        submitOn="mod-enter"
        mic
      />
    </div>

    <div class="flex min-h-0 flex-1 flex-col border-t border-(--solus-popover-border)">
      <div class="flex shrink-0 items-center gap-2 px-4 pt-2.5 pb-1.5">
        <button
          type="button"
          role="checkbox"
          aria-checked={composer.visibleSelection === "all"
            ? "true"
            : composer.visibleSelection === "some"
              ? "mixed"
              : "false"}
          aria-label={composer.query ? "Select all matching files" : "Select all files"}
          class="-ml-1 flex min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-md border-0 bg-transparent px-1 py-1 text-xs text-(--solus-text-secondary) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-(--solus-accent) disabled:cursor-default disabled:opacity-50 max-md:min-h-11"
          disabled={composer.loading || composer.visibleFiles.length === 0}
          onclick={() => composer.toggleVisible()}
        >
          {@render checkbox(composer.visibleSelection)}
          <span class="truncate">
            {#if composer.loading}
              Changes
            {:else}
              <span class="tabular-nums">{composer.selected.size}</span> of
              <span class="tabular-nums">{composer.files.length}</span>
              file{composer.files.length === 1 ? "" : "s"}
            {/if}
          </span>
        </button>
        {#if composer.selected.size > 0}
          <span class="shrink-0 text-xs tabular-nums">
            <span class="text-(--solus-status-complete)">+{selectedTotals.additions}</span>
            <span class="text-(--solus-status-error)">−{selectedTotals.deletions}</span>
          </span>
        {/if}
        {#if composer.files.length >= FILTER_MIN_FILES}
          <!-- `pointer-coarse:text-base` is load-bearing, not taste: iOS zooms
               the page on focus for any field under 16px. -->
          <SearchField
            bind:value={composer.query}
            placeholder="Filter"
            class="ml-auto max-w-40 flex-1 basis-24 @max-[44rem]:basis-24 py-1 text-xs pointer-coarse:py-2 pointer-coarse:text-base"
          />
        {/if}
      </div>

      <div class="min-h-24 flex-1 overflow-y-auto px-2 pb-2">
        {#if composer.loading}
          <ContentSkeleton label="Loading changed files" />
        {:else if composer.loadError}
          <div
            class="flex items-center gap-2 px-2 py-4 text-xs text-pretty text-(--solus-status-error)"
          >
            <WarningCircleIcon size={14} class="shrink-0" />
            {composer.loadError}
          </div>
        {:else if composer.files.length === 0}
          <div class="px-2 py-6 text-center text-xs text-(--solus-text-tertiary)">
            The working tree is clean.
          </div>
        {:else if composer.visibleFiles.length === 0}
          <div class="px-2 py-6 text-center text-xs text-pretty text-(--solus-text-tertiary)">
            No file matches “{composer.query}”.
          </div>
        {:else}
          <ul class="flex flex-col">
            {#each composer.visibleFiles as file (file.path)}
              {@const isSelected = composer.selected.has(file.path)}
              {@const parts = splitPath(file.path)}
              <li>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  title={file.path}
                  class="flex h-7 w-full min-w-0 cursor-pointer items-center gap-2.5 overflow-hidden rounded-md border-0 bg-transparent px-2 text-left text-xs hover:bg-(--solus-surface-hover) focus-visible:bg-(--solus-surface-hover) focus-visible:outline-none max-md:h-11 max-md:text-sm"
                  onclick={() => composer.toggle(file.path)}
                >
                  {@render checkbox(isSelected ? "all" : "none")}
                  <span
                    class="flex min-w-0 flex-1 items-baseline {isSelected
                      ? ''
                      : 'opacity-55'}"
                  >
                    <span class="shrink-0 truncate text-(--solus-text-primary)"
                      >{parts.name}</span
                    >
                    {#if parts.folders}
                      <span class="ml-2 min-w-0 truncate text-(--solus-text-tertiary)"
                        >{parts.folders.slice(0, -1)}</span
                      >
                    {/if}
                  </span>
                  <span
                    class="w-3 shrink-0 text-center font-mono text-[0.6875rem] font-medium {STATUS_TONE_CLASS[
                      file.status
                    ]}"
                    title={file.status}>{file.status}</span
                  >
                  <span
                    class="flex w-[5.5rem] shrink-0 justify-end gap-1.5 tabular-nums max-md:w-24"
                  >
                    <span class="text-(--solus-status-complete)"
                      >{file.additions ? `+${file.additions}` : ""}</span
                    >
                    <span class="min-w-8 text-right text-(--solus-status-error)"
                      >{file.deletions ? `−${file.deletions}` : ""}</span
                    >
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>

    {#if actions.actionError}
      <div
        class="flex shrink-0 items-start gap-2 border-t border-(--solus-popover-border) px-4 py-2.5 text-xs text-pretty text-(--solus-status-error)"
        role="alert"
      >
        <WarningCircleIcon size={14} class="mt-px shrink-0" />
        {actions.actionError}
      </div>
    {/if}

    <!-- On a phone the buttons stack full width, primary on top. -->
    <footer
      class="flex shrink-0 items-center justify-end gap-2 border-t border-(--solus-popover-border) px-4 py-3 max-md:flex-col-reverse max-md:items-stretch"
    >
      {#if canCommitOnly}
        <Button
          variant="outline"
          class="text-xs max-md:h-11 max-md:text-sm"
          disabled={!composer.canSubmit || actions.running}
          onclick={() => void submit("commit")}
        >
          {#if actions.running && submittingAction === "commit"}
            <CircleNotchIcon class="animate-spin" />
          {/if}
          Commit only
        </Button>
      {/if}
      <Button
        class="text-xs max-md:h-11 max-md:text-sm"
        disabled={!composer.canSubmit || actions.running}
        onclick={() => void submit()}
      >
        {#if actions.running && submittingAction !== "commit"}
          <CircleNotchIcon class="animate-spin" />
        {/if}
        {submitLabel}
        <kbd
          class="ml-0.5 font-sans text-[0.6875rem] opacity-70 pointer-coarse:hidden"
          >{isMac ? "⌘↵" : "Ctrl ↵"}</kbd
        >
      </Button>
    </footer>
  </div>
</div>
{/if}

<style>
  /* Scoped, unlayered, and therefore ahead of the utility classes that carry
     these animations: a reduced-motion reader gets the finished dialog. */
  @media (prefers-reduced-motion: reduce) {
    div {
      animation: none !important;
    }
  }

  @keyframes commit-composer-backdrop-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes commit-composer-enter {
    from {
      opacity: 0;
      transform: translate3d(0, 0.25rem, 0) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
</style>
