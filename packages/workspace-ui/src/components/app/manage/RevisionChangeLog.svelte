<script lang="ts">
  import { activationLabel, type AppChangeLogEntry } from "@solus/client-core/app-versions";
  import ActivationConfirm from "./ActivationConfirm.svelte";
  import type { VersionActions } from "./lib/version-actions.svelte";
  import { historyMark, historyMeta } from "./lib/versions";

  /**
   * The history: every save of the app's source on one line, the newest
   * first, plain on the page. The saves that do not run have a hollow mark,
   * the live one the accent mark, a save whose build failed a mark in the
   * failure colour, and the earlier ones a quiet dot with Roll back. A save
   * opens in the change card beside the line. The arrow keys move along it.
   */
  interface Props {
    entries: AppChangeLogEntry[];
    selectedCommit: string | null;
    onSelect: (commit: string) => void;
    liveVersion: number | null;
    isDeploying: boolean;
    actions: VersionActions;
    now: number;
  }
  let { entries, selectedCommit, onSelect, liveVersion, isDeploying, actions, now }: Props = $props();

  function handleKeydown(event: KeyboardEvent & { currentTarget: HTMLElement }) {
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    const index = entries.findIndex((entry) => entry.revision.commit === selectedCommit);
    const next = entries[Math.max(0, Math.min(entries.length - 1, index + delta))];
    if (!next) return;
    event.preventDefault();
    onSelect(next.revision.commit);
    event.currentTarget.querySelector<HTMLElement>(`[data-commit="${next.revision.commit}"]`)?.focus();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<ol class="m-0 flex list-none flex-col p-0" aria-label="History" data-testid="app-change-log" onkeydown={handleKeydown}>
  {#each entries as entry, index (entry.revision.commit)}
    {@const mark = historyMark(entry)}
    {@const isSelected = entry.revision.commit === selectedCommit}
    {@const confirmKey = `log:activate:${entry.revision.commit}`}
    {@const canRollTo = entry.restorable !== null && entry.position !== "live"}
    <li class="flex min-w-0 gap-3.5 rounded-lg px-3 transition-colors duration-150 {isSelected ? 'bg-[var(--wash-3)]' : 'hover:bg-[var(--wash-1)]'}" data-testid="app-revision" data-position={entry.position}>
      <!-- The line and the save's mark. -->
      <span class="flex w-4 shrink-0 flex-col items-center" aria-hidden="true">
        <span class="h-4.5 w-0.5 shrink-0 {index === 0 ? 'bg-transparent' : 'bg-[var(--hairline-strongest)]'}"></span>
        {#if mark === "live"}
          <span class="size-3.5 shrink-0 rounded-full bg-(--solus-accent) shadow-[0_0_0_4px_color-mix(in_srgb,var(--solus-accent)_16%,transparent)]"></span>
        {:else if mark === "ahead"}
          <span class="size-3 shrink-0 rounded-full border-2 border-foreground bg-background"></span>
        {:else if mark === "failed"}
          <span class="size-3 shrink-0 rounded-full border-[1.5px] border-(--failure) bg-background"></span>
        {:else}
          <span class="size-3 shrink-0 rounded-full bg-[color-mix(in_oklch,var(--foreground)_38%,transparent)]"></span>
        {/if}
        <span class="w-0.5 flex-1 {index === entries.length - 1 ? 'bg-transparent' : 'bg-[var(--hairline-strongest)]'}"></span>
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-2 py-3.25">
        <button
          type="button"
          class="flex min-w-0 cursor-pointer flex-col gap-0.75 overflow-hidden border-0 bg-transparent p-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
          aria-current={isSelected ? "true" : undefined}
          data-commit={entry.revision.commit}
          tabindex={isSelected || (selectedCommit === null && index === 0) ? 0 : -1}
          onclick={() => onSelect(entry.revision.commit)}
        >
          <span class="flex min-w-0 items-center gap-2">
            <span class="truncate text-sm leading-4.5 text-foreground {mark === 'ahead' || isSelected ? 'font-semibold' : mark === 'live' ? 'font-medium' : ''}" title={entry.revision.message}>{entry.revision.message || "No message"}</span>
            {#if mark === "live"}
              <span class="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--solus-accent)_14%,transparent)] px-2 py-px text-xs font-medium text-(--solus-accent)">Live</span>
            {/if}
          </span>
          <span class="truncate text-[13px] leading-4 {mark === 'failed' ? 'text-(--failure)' : 'text-(--solus-text-tertiary)'}">{historyMeta(entry, now)}</span>
        </button>
        {#if canRollTo && entry.restorable}
          <button
            type="button"
            class="w-fit cursor-pointer border-0 bg-transparent p-0 text-[13px] text-foreground underline decoration-[var(--hairline-strongest)] underline-offset-2 hover:decoration-current disabled:cursor-default disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
            disabled={actions.isActivating || isDeploying}
            onclick={() => actions.askToActivate(confirmKey)}
            data-testid="app-revision-activate">{activationLabel(entry.restorable.number, liveVersion)}</button
          >
          <ActivationConfirm {actions} rowKey={confirmKey} target={entry.restorable.number} live={liveVersion} />
        {/if}
      </div>
    </li>
  {/each}
</ol>
