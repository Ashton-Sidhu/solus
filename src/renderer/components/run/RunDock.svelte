<script lang="ts">
  import { tick } from "svelte";
  import {
    CheckIcon,
    SpinnerGapIcon,
    XIcon,
  } from "phosphor-svelte";
  import { getRunStore, getRunDockStore, getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { runLabel } from "../../lib/run-utils";
  import LogConsole from "../project-panel/LogConsole.svelte";
  import type { RunStatus } from "../../../shared/types";

  interface Props {
    cwd: string;
  }
  let { cwd }: Props = $props();

  const runStore = getRunStore();
  const runDock = getRunDockStore();
  const settings = getSettingsContext();
  const runs = $derived(runStore.runsFor(cwd) ?? []);
  let rootEl: HTMLDivElement | undefined = $state();

  // The active tab falls back to the first run when the stored id isn't present
  // (e.g. after switching to a project whose runs differ).
  const activeRun = $derived<RunStatus | null>(
    runs.find((r) => r.commandId === runDock.activeCommandId) ??
      runs[0] ??
      null,
  );
  const activeCommandId = $derived(activeRun?.commandId ?? null);

  function selectRun(run: RunStatus) {
    runDock.activeCommandId = run.commandId;
  }

  function close() {
    runDock.close();
    settings.update({ runDockOpen: false });
    requestInputFocus();
  }

  function focusFilter() {
    void tick().then(() => {
      rootEl
        ?.querySelector<HTMLInputElement>("[data-run-log-filter]")
        ?.focus();
    });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    const activeEl = document.activeElement;
    if (!activeEl || !rootEl?.contains(activeEl)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  $effect(() => {
    if (!activeCommandId) return;
    focusFilter();
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="run-dock" bind:this={rootEl}>
  <div class="dock-tabs">
    <div class="dock-tab-scroll" role="tablist" aria-label="Run logs">
      {#each runs as run (run.commandId)}
        {@const active = run.commandId === activeRun?.commandId}
        <button
          type="button"
          role="tab"
          aria-selected={active}
          class="dock-tab state-{run.state}"
          class:active
          title={runLabel(run)}
          onclick={() => selectRun(run)}
        >
          {#if run.state === "starting"}
            <span class="tab-spin"><SpinnerGapIcon size={10} /></span>
          {:else if run.state === "completed"}
            <span class="tab-check"><CheckIcon size={10} weight="bold" /></span>
          {:else}
            <span class="tab-dot"></span>
          {/if}
          <span class="tab-name">{runLabel(run)}</span>
        </button>
      {/each}
    </div>
    <button
      class="dock-close"
      type="button"
      aria-label="Close run logs (⌥J)"
      title="Close (⌥J)"
      onclick={close}
    >
      <XIcon size={13} />
    </button>
  </div>

  {#if activeRun}
    {#key activeRun.commandId}
      <LogConsole {cwd} run={activeRun} />
    {/key}
  {:else}
    <div class="dock-empty">No run commands.</div>
  {/if}
</div>

<style>
  .run-dock {
    flex: 1;
    min-height: 0;
    width: 100%;
    max-width: var(--solus-reading-max);
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--solus-container-border);
    border-radius: 16px;
    background: var(--solus-input-pill-bg);
    box-shadow: var(--solus-card-shadow-collapsed);
  }

  .dock-tabs {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid
      color-mix(in srgb, var(--solus-text-tertiary) 14%, transparent);
    flex-shrink: 0;
  }
  /* Tabs scroll horizontally so a narrow dock (split panes / small laptop
     window) never clips them; the close button stays pinned outside the scroll. */
  .dock-tab-scroll {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.125rem;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .dock-tab-scroll::-webkit-scrollbar {
    display: none;
  }
  .dock-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    max-width: 12rem;
    flex-shrink: 0;
    padding: 0.3125rem 0.625rem;
    border: none;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    font-family: inherit;
    font-size: 0.71875rem;
    font-weight: 500;
    cursor: pointer;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }
  .dock-tab:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-secondary);
  }
  .dock-tab.active {
    background: color-mix(in srgb, var(--solus-text-tertiary) 12%, transparent);
    color: var(--solus-text-primary);
  }
  .dock-tab:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Status indicator — mirrors the Run section's state language. */
  .tab-dot {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 999px;
    flex-shrink: 0;
    background: var(--solus-text-tertiary);
  }
  .dock-tab.state-running .tab-dot {
    background: var(--solus-status-live);
  }
  @media (prefers-reduced-motion: no-preference) {
    .dock-tab.state-running .tab-dot {
      animation: dock-pulse 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
  }
  @keyframes dock-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 var(--solus-status-live-glow);
    }
    50% {
      box-shadow: 0 0 0 0.1875rem transparent;
    }
  }
  .dock-tab.state-error .tab-dot {
    background: var(--solus-status-error);
  }
  .tab-check {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--solus-status-complete);
  }
  .tab-spin {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--solus-accent);
  }
  @media (prefers-reduced-motion: no-preference) {
    .tab-spin {
      animation: tab-spin 0.7s linear infinite;
    }
  }
  @keyframes tab-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .dock-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.625rem;
    height: 1.625rem;
    flex-shrink: 0;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }
  .dock-close:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .dock-close:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }

  .dock-empty {
    padding: 1rem;
    color: var(--solus-text-tertiary);
    font-size: 0.75rem;
  }
</style>
