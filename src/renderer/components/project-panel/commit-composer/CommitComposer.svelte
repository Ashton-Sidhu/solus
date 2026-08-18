<script lang="ts">
  import {
    PaperPlaneTiltIcon,
    CircleNotchIcon,
    CheckIcon,
    MagnifyingGlassIcon,
    XIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import { Input } from "../../ui/input";
  import { Textarea } from "../../ui/textarea";
  import {
    runtime,
    type WorkspaceContext,
    type SessionEnvironmentStore,
  } from "../../../contexts";
  import type { GitActions } from "../../../lib/git-actions.svelte";
  import type { GitAction } from "../../../../shared/types";
  import { getPopoverLayer } from "../../popoverLayer.svelte";
  import { portal } from "../../portal";
  import {
    centringPadding,
    observeConversationBounds,
    type ConversationBounds,
  } from "../../pickers/lib/conversation-bounds";
  import { CommitComposerState } from "./lib/commit-composer.svelte";
  import { STATUS_TONE_CLASS, splitPath } from "./lib/commit-composer";
  import { changedFileTotals } from "../../../lib/diff-stats";

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

  // Same centring contract as the pickers: the dialog belongs to the
  // conversation it was opened from, so it centres on that column rather than
  // the window — an open sidebar and project panel push a window-centred dialog
  // visibly off-axis. Centring on measured viewport coordinates only holds while
  // the overlay is viewport-anchored, so it portals to the app-root layer rather
  // than trusting every ancestor of the panel to stay free of a containing block.
  const layer = getPopoverLayer();
  let viewportWidth = $state(0);
  let conversationBounds = $state<ConversationBounds | null>(null);
  const centringStyle = $derived(
    runtime.isMobileViewport
      ? ""
      : centringPadding(conversationBounds, viewportWidth),
  );
  $effect(() => observeConversationBounds((bounds) => (conversationBounds = bounds)));

  const composer = new CommitComposerState();
  $effect(() => {
    void composer.load(
      api,
      session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
    );
  });

  const selectedTotals = $derived(changedFileTotals(composer.selectedFiles));

  let messageEl = $state<HTMLTextAreaElement | null>(null);
  $effect(() => {
    if (composer.loading) return;
    const raf = requestAnimationFrame(() =>
      messageEl?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(raf);
  });

  const branchName = $derived(env.branch ?? null);
  const heading = $derived(
    action === "commit_push" ? "Commit and push files" : "Commit files",
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

<svelte:window bind:innerWidth={viewportWidth} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
{#if layer.el}
<div
  use:portal={layer.el}
  data-solus-ui
  class="fixed inset-0 z-[10008] flex items-center justify-center overflow-hidden overscroll-contain pointer-events-auto bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] [animation:commit-composer-backdrop-in_160ms_ease_both]"
  style={centringStyle}
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && !actions.running) onClose();
  }}
  onkeydown={onPanelKeydown}
>
  <div
    class="flex max-h-[min(38rem,80svh)] w-[clamp(20rem,44vw,30rem)] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl max-md:max-h-[88svh] max-md:w-[calc(100vw-1.5rem)] max-md:max-w-none border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] [.dark_&]:shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06)] outline-none [animation:commit-composer-enter_200ms_cubic-bezier(0.22,1,0.36,1)_backwards]"
    role="dialog"
    aria-label={heading}
    aria-modal="true"
  >
    <!-- Header, list, and footer enter as three staggered chunks rather than one
         block, so the dialog assembles instead of appearing. -->
    <div
      class="relative flex h-[3.25rem] flex-shrink-0 items-center gap-2.5 px-[1.125rem] after:absolute after:bottom-0 after:left-[1.125rem] after:right-[1.125rem] after:h-[0.0625rem] after:bg-(--solus-popover-border) after:opacity-[0.35] after:content-[''] [animation:commit-composer-section-in_260ms_cubic-bezier(0.22,1,0.36,1)_60ms_backwards]"
    >
      <span
        class="grid size-7 flex-shrink-0 place-items-center rounded-[0.5rem] bg-(--solus-accent-light) text-(--solus-accent) shadow-[inset_0_0_0_0.0625rem_var(--solus-accent-border)]"
      >
        <PaperPlaneTiltIcon size={14} weight="fill" />
      </span>
      <div class="flex min-w-0 flex-col">
        <span
          class="truncate text-sm font-medium leading-tight text-(--solus-text-primary)"
          >{heading}</span
        >
        <span
          class="truncate text-xs leading-tight text-(--solus-text-tertiary)"
        >
          {#if composer.loading}
            Reading the working tree…
          {:else}
            <span class="tabular-nums">{composer.files.length}</span> changed file{composer
              .files.length === 1
              ? ""
              : "s"}
            {#if branchName}
              on <span class="font-medium">{branchName}</span>
            {/if}
          {/if}
        </span>
      </div>
      <button
        type="button"
        class="relative ml-auto inline-flex size-7 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] disabled:opacity-50 after:absolute after:-inset-1.5 after:content-[''] max-md:after:-inset-2.5"
        onclick={onClose}
        disabled={actions.running}
        aria-label="Close"
      >
        <XIcon size={14} />
      </button>
    </div>

    <div
      class="flex flex-1 flex-col overflow-hidden [animation:commit-composer-section-in_260ms_cubic-bezier(0.22,1,0.36,1)_120ms_backwards]"
    >
      <div class="relative flex-shrink-0 px-[1.125rem] pt-3">
        <MagnifyingGlassIcon
          size={13}
          class="pointer-events-none absolute left-[1.75rem] top-1/2 mt-[0.375rem] -translate-y-1/2 text-(--solus-text-tertiary) max-md:left-[1.875rem] max-md:size-4"
        />
        <!-- `max-md:text-base` is load-bearing, not taste: iOS zooms the page on
             focus for any field under 16px. -->
        <Input
          bind:value={composer.query}
          placeholder="Filter files…"
          spellcheck={false}
          autocomplete="off"
          aria-label="Filter changed files"
          class="h-8 rounded-lg border-transparent bg-(--solus-input-bg-soft) pl-7 pr-7 text-xs shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--solus-container-border)_70%,transparent)] focus-visible:border-transparent focus-visible:ring-[0.125rem] focus-visible:ring-[color-mix(in_srgb,var(--solus-accent)_30%,transparent)] max-md:h-11 max-md:pl-9 max-md:pr-11 max-md:text-base"
        />
        {#if composer.query}
          <button
            type="button"
            class="absolute right-[1.5rem] top-1/2 mt-[0.375rem] inline-flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] after:absolute after:content-[''] max-md:size-7 max-md:after:-inset-2.5"
            onclick={() => (composer.query = "")}
            aria-label="Clear the filter"
          >
            <XIcon size={11} />
          </button>
        {/if}
      </div>

      <div
        class="flex flex-shrink-0 items-center justify-between gap-2 px-[1.125rem] pb-1 pt-2.5"
      >
        <span class="min-w-0 truncate text-xs text-(--solus-text-tertiary)">
          <span class="tabular-nums">{composer.selected.size}</span> of
          <span class="tabular-nums">{composer.files.length}</span> selected
          {#if composer.selected.size > 0}
            · <span class="tabular-nums text-(--solus-status-complete)"
              >+{selectedTotals.additions}</span
            >
            <span class="tabular-nums text-(--solus-status-error)"
              >−{selectedTotals.deletions}</span
            >
          {/if}
        </span>
        <div class="flex flex-shrink-0 items-center gap-0.5">
          <button
            type="button"
            class="cursor-pointer rounded-md border-0 bg-transparent px-1.5 py-1 text-xs text-(--solus-text-secondary) transition-[background-color,color,scale] duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 max-md:h-11 max-md:px-3 max-md:text-sm"
            onclick={() => composer.selectAll()}
            disabled={composer.loading || composer.visibleFiles.length === 0}
          >
            Select all
          </button>
          <button
            type="button"
            class="cursor-pointer rounded-md border-0 bg-transparent px-1.5 py-1 text-xs text-(--solus-text-secondary) transition-[background-color,color,scale] duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 max-md:h-11 max-md:px-3 max-md:text-sm"
            onclick={() => composer.selectNone()}
            disabled={composer.loading || composer.visibleSelectedCount === 0}
          >
            None
          </button>
        </div>
      </div>

      <div class="min-h-[6rem] flex-1 overflow-y-auto px-3 pb-2">
        {#if composer.loading}
          <div
            class="flex items-center gap-2 px-1.5 py-4 text-xs text-(--solus-text-tertiary)"
          >
            <CircleNotchIcon
              size={14}
              class="animate-spin [animation-duration:0.7s]"
            />
            Loading changed files…
          </div>
        {:else if composer.loadError}
          <div
            class="flex items-center gap-2 px-1.5 py-4 text-xs text-pretty text-(--solus-status-error)"
          >
            <WarningCircleIcon size={14} class="flex-shrink-0" />
            {composer.loadError}
          </div>
        {:else if composer.files.length === 0}
          <div class="px-1.5 py-4 text-xs text-(--solus-text-tertiary)">
            No changed files.
          </div>
        {:else if composer.visibleFiles.length === 0}
          <div class="px-1.5 py-4 text-xs text-pretty text-(--solus-text-tertiary)">
            No file matches “{composer.query}”.
          </div>
        {:else}
          <ul class="flex flex-col gap-px">
            {#each composer.visibleFiles as file (file.path)}
              {@const isSelected = composer.selected.has(file.path)}
              {@const parts = splitPath(file.path)}
              <li>
                <button
                  type="button"
                  class="flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-100 hover:bg-(--solus-surface-hover) max-md:h-12 max-md:gap-3 max-md:px-2.5 {isSelected
                    ? ''
                    : 'opacity-70'}"
                  onclick={() => composer.toggle(file.path)}
                  aria-pressed={isSelected}
                >
                  <span
                    class="grid size-[0.9375rem] flex-shrink-0 place-items-center rounded-[0.3125rem] transition-[background-color,box-shadow] duration-100 max-md:size-5 max-md:rounded-md {isSelected
                      ? 'bg-(--solus-accent) text-white shadow-[inset_0_0_0_0.0625rem_var(--solus-accent)]'
                      : 'shadow-[inset_0_0_0_0.0625rem_var(--solus-container-border)]'}"
                  >
                    <CheckIcon
                      size={10}
                      weight="bold"
                      class="max-md:size-3.5 transition-[opacity,scale,filter] duration-150 {isSelected
                        ? 'scale-100 opacity-100 blur-none'
                        : 'scale-[0.25] opacity-0 blur-[0.25rem]'}"
                    />
                  </span>
                  <span
                    class="w-3 flex-shrink-0 text-center text-xs font-semibold {STATUS_TONE_CLASS[
                      file.status
                    ]}">{file.status}</span
                  >
                  <span
                    class="flex min-w-0 flex-1 items-baseline text-xs max-md:text-sm"
                  >
                    {#if parts.folders}
                      <span
                        class="min-w-0 flex-shrink truncate text-(--solus-text-tertiary)"
                        >{parts.folders}</span
                      >
                    {/if}
                    <span class="flex-shrink-0 truncate text-(--solus-text-primary)"
                      >{parts.name}</span
                    >
                  </span>
                  <span
                    class="flex-shrink-0 text-xs tabular-nums text-(--solus-status-complete)"
                    >+{file.additions}</span
                  >
                  <span
                    class="w-8 flex-shrink-0 text-xs tabular-nums text-(--solus-status-error)"
                    >−{file.deletions}</span
                  >
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>

    <div
      class="flex-shrink-0 px-[1.125rem] pb-2 [animation:commit-composer-section-in_260ms_cubic-bezier(0.22,1,0.36,1)_180ms_backwards]"
    >
      <Textarea
        bind:ref={messageEl}
        bind:value={composer.message}
        placeholder="Commit message (optional — leave blank to generate one)"
        rows={2}
        disabled={actions.running}
        class="w-full resize-none rounded-lg border-transparent bg-(--solus-input-bg-soft) px-2.5 py-2 text-xs text-(--solus-text-primary) shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--solus-container-border)_70%,transparent)] outline-none focus:border-transparent focus-visible:ring-[0.125rem] focus-visible:ring-[color-mix(in_srgb,var(--solus-accent)_30%,transparent)] max-md:px-3 max-md:py-2.5 max-md:text-base"
        onSubmit={() => void submit()}
        submitOn="mod-enter"
      />
    </div>

    {#if actions.actionError}
      <div
        class="flex-shrink-0 px-[1.125rem] pb-2 text-xs text-pretty text-(--solus-status-error)"
      >
        {actions.actionError}
      </div>
    {/if}

    <div
      class="relative flex h-[3.25rem] flex-shrink-0 items-center gap-1.5 px-[1.125rem] before:absolute before:left-[1.125rem] before:right-[1.125rem] before:top-0 before:h-[0.0625rem] before:bg-(--solus-popover-border) before:opacity-[0.35] before:content-[''] [animation:commit-composer-section-in_260ms_cubic-bezier(0.22,1,0.36,1)_180ms_backwards] max-md:h-auto max-md:flex-col-reverse max-md:items-stretch max-md:gap-2 max-md:py-3"
    >
      <!-- Three buttons and a hint cannot share one row on a phone. The column
           reverses so the primary action stays on top, and the shortcut hint
           goes away where there is no keyboard to press it. -->
      <span
        class="min-w-0 flex-1 truncate text-xs text-(--solus-text-tertiary) max-md:hidden"
        >⌘↵ to {submitLabel.toLowerCase()}</span
      >
      <button
        type="button"
        class="cursor-pointer rounded-lg border-0 bg-transparent px-2.5 py-[0.375rem] text-xs font-medium text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary) active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 max-md:h-11 max-md:text-sm"
        onclick={onClose}
        disabled={actions.running}
      >
        Cancel
      </button>
      {#if canCommitOnly}
        <button
          type="button"
          class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-(--solus-surface-hover) px-2.5 py-[0.375rem] text-xs font-medium text-(--solus-text-secondary) shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--solus-container-border)_70%,transparent)] transition-[background-color,color,scale] duration-100 hover:text-(--solus-text-primary) active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 max-md:h-11 max-md:justify-center max-md:text-sm"
          disabled={!composer.canSubmit || actions.running}
          onclick={() => void submit("commit")}
        >
          {#if actions.running && submittingAction === "commit"}
            <CircleNotchIcon
              size={14}
              class="animate-spin [animation-duration:0.7s]"
            />
          {/if}
          Commit only
        </button>
      {/if}
      <button
        type="button"
        class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-(--solus-accent) px-3 py-[0.375rem] text-xs font-medium text-white shadow-[0_0.0625rem_0.125rem_rgba(0,0,0,0.12),inset_0_0.0625rem_0_rgba(255,255,255,0.18)] transition-[opacity,scale] duration-100 hover:opacity-90 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 max-md:h-11 max-md:justify-center max-md:text-sm"
        disabled={!composer.canSubmit || actions.running}
        onclick={() => void submit()}
      >
        {#if actions.running && submittingAction !== "commit"}
          <CircleNotchIcon
            size={14}
            class="animate-spin [animation-duration:0.7s]"
          />
        {/if}
        {submitLabel}
      </button>
    </div>
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

  /* One chunk of the dialog arriving. Delays stagger header → list → footer, so
     the dialog assembles rather than appearing whole. */
  @keyframes commit-composer-section-in {
    from {
      opacity: 0;
      transform: translate3d(0, 0.375rem, 0);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0);
    }
  }

  @keyframes commit-composer-enter {
    from {
      opacity: 0;
      transform: translate3d(0, 0.5rem, 0) scale(0.97);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
</style>
