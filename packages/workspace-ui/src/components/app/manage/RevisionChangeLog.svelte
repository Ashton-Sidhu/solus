<script lang="ts">
  import { activationLabel, type AppChangeLogEntry } from "@solus/client-core/app-versions";
  import ActivationConfirm from "./ActivationConfirm.svelte";
  import StateIcon from "./StateIcon.svelte";
  import type { VersionActions } from "./lib/version-actions.svelte";
  import { historyMeta, historyState } from "./lib/versions";

  /**
   * The history: every save of the app's source, the newest first, plain on
   * the page. Each row has the session mark of the save (idle for a save that
   * does not run, complete for the live one, working while it builds, error
   * for a failed build), its message, and a quiet line under it. An earlier
   * version has Roll back on that line. A save opens in the change detail
   * beside the list. The arrow keys move along it.
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
<ol class="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="History" data-testid="app-change-log" onkeydown={handleKeydown}>
  {#each entries as entry, index (entry.revision.commit)}
    {@const meta = historyMeta(entry, now)}
    {@const isSelected = entry.revision.commit === selectedCommit}
    {@const confirmKey = `log:activate:${entry.revision.commit}`}
    {@const canRollTo = entry.restorable !== null && entry.position !== "live"}
    <li class="relative flex min-w-0 gap-2.5 rounded-[10px] px-3 py-2.5 transition-colors duration-150 {isSelected ? 'bg-[var(--wash-3)]' : 'hover:bg-[var(--wash-1)]'}" data-testid="app-revision" data-position={entry.position}>
      <!-- The whole row selects the save; Roll back sits above it. -->
      <button
        type="button"
        class="absolute inset-0 cursor-pointer rounded-[10px] border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
        aria-label={entry.revision.message || "No message"}
        aria-current={isSelected ? "true" : undefined}
        data-commit={entry.revision.commit}
        tabindex={isSelected || (selectedCommit === null && index === 0) ? 0 : -1}
        onclick={() => onSelect(entry.revision.commit)}
      ></button>
      <span class="pointer-events-none flex shrink-0 pt-px"><StateIcon state={historyState(entry)} /></span>
      <div class="pointer-events-none flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-sm leading-4.5 text-foreground {isSelected ? 'font-medium' : ''}" title={entry.revision.message}>{entry.revision.message || "No message"}</span>
        <span class="flex min-w-0 items-baseline gap-1 text-xs leading-4 text-(--solus-text-tertiary)">
          <span class="min-w-0 truncate {meta.isCode ? 'font-mono' : ''}" title={meta.text}>{meta.text}</span>
          {#if canRollTo && entry.restorable}
            <span class="shrink-0" aria-hidden="true">·</span>
            <button
              type="button"
              class="pointer-events-auto relative shrink-0 cursor-pointer border-0 bg-transparent p-0 text-xs text-(--solus-text-secondary) underline decoration-1 underline-offset-2 hover:text-foreground disabled:cursor-default disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
              disabled={actions.isActivating || isDeploying}
              onclick={() => actions.askToActivate(confirmKey)}
              data-testid="app-revision-activate">{activationLabel(entry.restorable.number, liveVersion)}</button
            >
          {/if}
        </span>
        {#if canRollTo && entry.restorable}
          <div class="pointer-events-auto relative empty:hidden">
            <ActivationConfirm {actions} rowKey={confirmKey} target={entry.restorable.number} live={liveVersion} />
          </div>
        {/if}
      </div>
    </li>
  {/each}
</ol>
