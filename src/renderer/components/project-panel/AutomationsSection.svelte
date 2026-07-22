<script lang="ts">
  import {
    LightningIcon,
    PlayIcon,
    PauseIcon,
    StopIcon,
    ChatCircleDotsIcon,
    ArrowRightIcon,
  } from "phosphor-svelte";
  import type { Automation } from "../../../shared/types";
  import type { AutomationBoard } from "./lib/automation-board";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    triggerSummary,
    relativeTime,
  } from "../automations/lib/automation-format";
  import { Button } from "../ui/button";

  interface Props {
    board: AutomationBoard;
  }
  let { board }: Props = $props();

  const session = getWorkspaceContext();
  const store = session.automationsStore;

  let now = $state(Date.now());
  $effect(() => {
    const hasScheduled = board.rows.some((a) => a.enabled && a.nextRunAt);
    if (!hasScheduled) return;
    const t = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(t);
  });

  function open(a: Automation) {
    session.openAutomations(a.id);
    requestInputFocus();
  }

  function viewAll() {
    session.openAutomations();
    requestInputFocus();
  }

  async function toggle(a: Automation, e: Event) {
    e.stopPropagation();
    await store.setEnabled(a.id, !a.enabled);
    requestInputFocus();
  }

  async function stop(a: Automation, e: Event) {
    e.stopPropagation();
    await store.cancel(a.id);
    requestInputFocus();
  }

  // One quiet right-aligned word/phrase that names the row's state — the calm
  // single-line language of the rest of the panel. Paused / Failed read as
  // status; an active schedule reads as its next fire ("in 2 hr"), falling back
  // to the cadence ("Daily", "Manual") when nothing is queued.
  function statusLabel(a: Automation): string {
    void now; // reactive dependency — re-runs when the minute tick fires
    if (!a.enabled) return "Paused";
    if (a.lastRunStatus === "failed") return "Failed";
    if (a.nextRunAt) {
      const next = relativeTime(a.nextRunAt);
      if (next) return next;
    }
    return triggerSummary(a.trigger);
  }

  function statusColor(a: Automation): string {
    if (a.lastRunStatus === "failed" && a.enabled)
      return "var(--solus-status-error)";
    return "var(--solus-text-tertiary)";
  }

  function toggleButtonClass(a: Automation): string {
    if (a.enabled) {
      return "text-[color-mix(in_srgb,var(--solus-status-error)_76%,var(--solus-text-tertiary))] hover:bg-[color-mix(in_srgb,var(--solus-status-error)_12%,transparent)] hover:text-(--solus-status-error)";
    }

    return "text-[color-mix(in_srgb,var(--project-icon-green)_76%,var(--solus-text-tertiary))] hover:bg-[color-mix(in_srgb,var(--project-icon-green)_12%,transparent)] hover:text-(--project-icon-green)";
  }
</script>

{#if board.summary}
  <p
    class="m-0 mb-1 px-2 text-[0.6875rem] text-(--solus-text-tertiary)"
    aria-live="polite"
  >
    {board.summary}
  </p>
{/if}

<ul class="m-0 flex list-none flex-col gap-px p-0">
  {#each board.rows as a (a.id)}
    {@const running = a.lastRunStatus === "running"}
    {@const lightningFilled = running || a.favorite}
    <li class="group flex items-center gap-0.5">
      <button
        type="button"
        class="flex min-h-[2rem] min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[0.4375rem] border-none bg-transparent px-2 py-[0.3125rem] text-left transition-colors duration-150 hover:bg-(--solus-surface-hover) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
        onclick={() => open(a)}
      >
        <span
          class="inline-flex shrink-0 transition-colors duration-150 {running
            ? 'text-(--project-icon-amber)'
            : 'text-[color-mix(in_srgb,var(--project-icon-amber)_82%,var(--solus-text-tertiary))] group-hover:text-(--project-icon-amber)'}"
          class:animate-pulse={running}
          aria-hidden="true"
        >
          <LightningIcon size={13} weight={lightningFilled ? "fill" : "regular"} />
        </span>
        <span
          class="min-w-0 flex-1 truncate text-[0.8125rem] font-normal text-(--solus-text-secondary) transition-colors duration-150 group-hover:text-(--solus-text-primary)"
        >
          {a.name}
        </span>
        {#if a.action.sessionId}
          <span
            class="inline-flex shrink-0 text-(--solus-text-tertiary)"
            title="Runs in this chat thread"
            aria-label="Runs in this chat thread"
          >
            <ChatCircleDotsIcon size={10} />
          </span>
        {/if}
      </button>

      <!-- Trailing slot: a quiet status word at rest cross-fades to the
           pause / resume control on hover (mirrors the Git section's
           stats↔copy reveal). A live run keeps its stop control visible. -->
      {#if running}
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          class="text-(--solus-status-error) hover:bg-[color-mix(in_srgb,var(--solus-status-error)_12%,transparent)] hover:text-(--solus-status-error)"
          title="Stop run"
          aria-label="Stop run"
          onclick={(e) => stop(a, e)}
        >
          <StopIcon size={12} weight="fill" />
        </Button>
      {:else}
        <span class="relative flex shrink-0 items-center justify-end">
          <span
            class="max-w-28 truncate text-[0.6875rem] tabular-nums whitespace-nowrap transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0"
            style:color={statusColor(a)}
          >
            {statusLabel(a)}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            class="pointer-events-none absolute right-0 opacity-0 transition-[opacity,background-color,color] duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 {toggleButtonClass(
              a,
            )}"
            title={a.enabled ? "Pause automation" : "Resume automation"}
            aria-label={a.enabled ? "Pause automation" : "Resume automation"}
            onclick={(e) => toggle(a, e)}
          >
            {#if a.enabled}
              <PauseIcon size={12} weight="fill" />
            {:else}
              <PlayIcon size={12} weight="fill" />
            {/if}
          </Button>
        </span>
      {/if}
    </li>
  {/each}
</ul>

{#if board.rows.length === 0}
  <p class="m-0 px-2 py-1.5 text-[0.6875rem] text-(--solus-text-tertiary)">
    Nothing scheduled or running.
  </p>
{/if}

{#if board.total > board.rows.length}
  <button
    type="button"
    class="group mt-px flex w-full cursor-pointer items-center gap-1 rounded-[0.4375rem] border-none bg-transparent px-2 py-1.5 text-left text-[0.6875rem] font-normal text-(--solus-text-tertiary) transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
    onclick={viewAll}
  >
    View all {board.total}
    <ArrowRightIcon
      size={11}
      class="motion-safe:transition-transform motion-safe:duration-150 group-hover:translate-x-0.5"
    />
  </button>
{/if}
