<script lang="ts">
  import {
    PaperPlaneTiltIcon,
    CircleNotchIcon,
    CheckIcon,
    XIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import { Textarea } from "../../ui/textarea";
  import type { WorkspaceContext, SessionEnvironmentStore } from "../../../contexts";
  import type { GitActions } from "../../../lib/git-actions.svelte";
  import type { GitAction } from "../../../../shared/types";
  import { CommitComposerState } from "./lib/commit-composer.svelte";
  import { STATUS_TONE_CLASS } from "./lib/commit-composer";
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

  const heading = $derived(
    action === "commit_push" ? "Commit and push files" : "Commit files",
  );
  const submitLabel = $derived(
    action === "commit_push" ? "Commit and push" : "Commit",
  );

  async function submit() {
    if (!composer.canSubmit || actions.running) return;
    await actions.run(action, {
      filePaths: composer.selectedPaths,
      commitMessage: composer.message.trim() || undefined,
    });
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

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="fixed inset-0 z-[10008] flex items-start justify-center pt-[13vh] pointer-events-auto bg-transparent [animation:commit-composer-backdrop-in_160ms_ease_both]"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget && !actions.running) onClose();
  }}
  onkeydown={onPanelKeydown}
>
  <div
    class="flex max-h-[min(38rem,80vh)] w-[clamp(20rem,44vw,30rem)] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] [.dark_&]:shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06)] outline-none [animation:commit-composer-enter_200ms_cubic-bezier(0.22,1,0.36,1)_backwards]"
    role="dialog"
    aria-label={heading}
    aria-modal="true"
  >
    <div
      class="relative flex h-[2.875rem] flex-shrink-0 items-center gap-2 px-[1.125rem] after:absolute after:bottom-0 after:left-[1.125rem] after:right-[1.125rem] after:h-[0.0625rem] after:bg-(--solus-popover-border) after:opacity-[0.35] after:content-['']"
    >
      <PaperPlaneTiltIcon
        size={14}
        weight="fill"
        class="flex-shrink-0 text-(--solus-accent)"
      />
      <span class="text-[0.8125rem] font-medium text-(--solus-text-primary)"
        >{heading}</span
      >
      <button
        type="button"
        class="ml-auto inline-flex size-6 flex-shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-(--solus-text-tertiary) transition-colors duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) disabled:opacity-50"
        onclick={onClose}
        disabled={actions.running}
        aria-label="Close"
      >
        <XIcon size={14} />
      </button>
    </div>

    <div
      class="flex flex-shrink-0 items-center justify-between gap-2 px-[1.125rem] pb-1.5 pt-3"
    >
      <span class="text-xs text-(--solus-text-tertiary)">
        {composer.selected.size} of {composer.files.length} selected
        {#if composer.selected.size > 0}
          · <span class="tabular-nums text-(--solus-status-complete)"
            >+{selectedTotals.additions}</span
          >
          <span class="tabular-nums text-(--solus-status-error)"
            >-{selectedTotals.deletions}</span
          >
        {/if}
      </span>
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="cursor-pointer rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-(--solus-text-secondary) hover:text-(--solus-text-primary) disabled:opacity-50"
          onclick={() => composer.selectAll()}
          disabled={composer.loading || composer.files.length === 0}
        >
          Select all
        </button>
        <span class="text-(--solus-text-tertiary)">·</span>
        <button
          type="button"
          class="cursor-pointer rounded-md border-0 bg-transparent px-1.5 py-0.5 text-xs text-(--solus-text-secondary) hover:text-(--solus-text-primary) disabled:opacity-50"
          onclick={() => composer.selectNone()}
          disabled={composer.loading || composer.selected.size === 0}
        >
          Select none
        </button>
      </div>
    </div>

    <div class="min-h-[6rem] flex-1 overflow-y-auto px-[1.125rem] pb-2">
      {#if composer.loading}
        <div
          class="flex items-center gap-2 py-4 text-xs text-(--solus-text-tertiary)"
        >
          <CircleNotchIcon
            size={14}
            class="animate-spin [animation-duration:0.7s]"
          />
          Loading changed files…
        </div>
      {:else if composer.loadError}
        <div
          class="flex items-center gap-2 py-4 text-xs text-(--solus-status-error)"
        >
          <WarningCircleIcon size={14} />
          {composer.loadError}
        </div>
      {:else if composer.files.length === 0}
        <div class="py-4 text-xs text-(--solus-text-tertiary)">
          No changed files.
        </div>
      {:else}
        <ul class="flex flex-col">
          {#each composer.files as file (file.path)}
            {@const isSelected = composer.selected.has(file.path)}
            <li>
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-(--solus-surface-hover)"
                onclick={() => composer.toggle(file.path)}
                aria-pressed={isSelected}
              >
                <span
                  class="grid size-3.5 flex-shrink-0 place-items-center rounded-[0.25rem] border transition-colors duration-100 {isSelected
                    ? 'border-(--solus-accent) bg-(--solus-accent) text-white'
                    : 'border-(--solus-container-border)'}"
                >
                  <CheckIcon
                    size={11}
                    weight="bold"
                    class="transition-[opacity,scale] duration-150 {isSelected
                      ? 'scale-100 opacity-100'
                      : 'scale-50 opacity-0'}"
                  />
                </span>
                <span
                  class="w-3.5 flex-shrink-0 text-center text-xs font-medium {STATUS_TONE_CLASS[
                    file.status
                  ]}">{file.status}</span
                >
                <span
                  class="min-w-0 flex-1 truncate font-mono text-xs text-(--solus-text-secondary)"
                  >{file.path}</span
                >
                <span
                  class="flex-shrink-0 text-xs tabular-nums text-(--solus-status-complete)"
                  >+{file.additions}</span
                >
                <span
                  class="flex-shrink-0 text-xs tabular-nums text-(--solus-status-error)"
                  >-{file.deletions}</span
                >
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="flex-shrink-0 px-[1.125rem] pb-2">
      <Textarea
        bind:ref={messageEl}
        bind:value={composer.message}
        placeholder="Commit message (optional — leave blank to generate one)"
        rows={2}
        disabled={actions.running}
        class="w-full resize-none rounded-md border border-(--solus-container-border) bg-(--solus-input-bg-soft) px-2 py-1.5 text-xs text-(--solus-text-primary) outline-none focus:border-(--solus-accent)"
        onSubmit={() => void submit()}
        submitOn="mod-enter"
      />
    </div>

    {#if actions.actionError}
      <div
        class="flex-shrink-0 px-[1.125rem] pb-2 text-xs text-(--solus-status-error)"
      >
        {actions.actionError}
      </div>
    {/if}

    <div
      class="relative flex h-[3.25rem] flex-shrink-0 items-center justify-end gap-1.5 px-[1.125rem] before:absolute before:left-[1.125rem] before:right-[1.125rem] before:top-0 before:h-[0.0625rem] before:bg-(--solus-popover-border) before:opacity-[0.35] before:content-['']"
    >
      <button
        type="button"
        class="cursor-pointer rounded-md border-0 bg-transparent px-2.5 py-[0.3125rem] text-xs font-medium text-(--solus-text-tertiary) transition-colors duration-100 hover:text-(--solus-text-secondary) disabled:opacity-50"
        onclick={onClose}
        disabled={actions.running}
      >
        Cancel
      </button>
      <button
        type="button"
        class="inline-flex cursor-pointer items-center gap-1.5 rounded-md border-0 bg-(--solus-accent) px-3 py-[0.3125rem] text-xs font-medium text-white transition-[opacity] duration-100 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!composer.canSubmit || actions.running}
        onclick={() => void submit()}
      >
        {#if actions.running}
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

<style>
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
      transform: translate3d(0, 0.5rem, 0) scale(0.97);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
</style>
