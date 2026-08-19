<script lang="ts">
  import {
    ArrowsClockwiseIcon,
    CaretRightIcon,
    ChatCircleDotsIcon,
    ArrowRightIcon,
    PlayIcon,
    PauseIcon,
    StopIcon,
  } from "phosphor-svelte";
  import type { Automation } from "@solus/contracts/types";
  import type { AutomationBoard } from "./lib/automation-board";
  import { getWorkspaceContext } from "../../contexts";
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

  async function toggleEnabled(a: Automation, event: Event) {
    event.stopPropagation();
    await store.setEnabled(a.id, !a.enabled);
    requestInputFocus();
  }

  async function stop(a: Automation, event: Event) {
    event.stopPropagation();
    await store.cancel(a.id);
    requestInputFocus();
  }

  function viewAll() {
    session.openAutomations();
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

<ul class="m-0 flex list-none flex-col gap-px p-0">
  {#each board.rows as a (a.id)}
    {@const running = a.lastRunStatus === "running"}
    {@const emphasized = running || a.favorite}
    <li class="group relative flex w-full items-center">
      <button
        type="button"
        class="flex min-h-[2rem] w-full min-w-0 cursor-pointer items-center gap-2 rounded-[0.4375rem] border-none bg-transparent py-[0.3125rem] pr-8 pl-2 text-left transition-colors duration-150 hover:bg-(--solus-surface-hover) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
        onclick={() => open(a)}
      >
        <!-- 5c marks the row with a bare accent cycle glyph — no icon chip — and
             fades it back for anything that isn't currently scheduled. -->
        <span
          class="inline-flex shrink-0 text-(--solus-accent) transition-opacity duration-150 {a.enabled
            ? 'opacity-100'
            : 'opacity-45'}"
          class:animate-pulse={running}
          aria-hidden="true"
        >
          <ArrowsClockwiseIcon size={13} weight={emphasized ? "bold" : "regular"} />
        </span>
        <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span
            class="min-w-0 truncate font-normal text-(--solus-text-secondary) transition-colors duration-150 group-hover:text-(--solus-text-primary)"
          >
            {a.name}
          </span>
          <span
            class="max-w-28 shrink-0 truncate text-xs tabular-nums whitespace-nowrap"
            style:color={statusColor(a)}
          >
            {statusLabel(a)}
          </span>
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
        <span
          class="absolute top-1/2 right-2 inline-flex -translate-y-1/2 shrink-0 text-(--solus-text-tertiary) opacity-55 transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0"
          aria-hidden="true"
        >
          <CaretRightIcon size={11} />
        </span>
      </button>

      {#if running}
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          class="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-[opacity,background-color,color] duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 text-(--solus-status-error) hover:bg-[color-mix(in_srgb,var(--solus-status-error)_12%,transparent)] hover:text-(--solus-status-error)"
          title="Stop run"
          aria-label="Stop run"
          onclick={(event) => void stop(a, event)}
        >
          <StopIcon size={12} weight="fill" />
        </Button>
      {:else}
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          class="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-[opacity,background-color,color] duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 {toggleButtonClass(
            a,
          )}"
          title={a.enabled ? "Pause automation" : "Resume automation"}
          aria-label={a.enabled ? "Pause automation" : "Resume automation"}
          onclick={(event) => void toggleEnabled(a, event)}
        >
          {#if a.enabled}
            <PauseIcon size={12} weight="fill" />
          {:else}
            <PlayIcon size={12} weight="fill" />
          {/if}
        </Button>
      {/if}
    </li>
  {/each}
</ul>

{#if board.rows.length === 0}
  <p class="m-0 px-2 py-1.5 text-xs text-(--solus-text-tertiary)">
    Nothing scheduled or running.
  </p>
{/if}

{#if board.total > board.rows.length}
  <button
    type="button"
    class="group mt-px flex w-full cursor-pointer items-center gap-1 rounded-[0.4375rem] border-none bg-transparent px-2 py-1.5 text-left text-xs font-normal text-(--solus-text-tertiary) transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
    onclick={viewAll}
  >
    View all {board.total}
    <ArrowRightIcon
      size={11}
      class="motion-safe:transition-transform motion-safe:duration-150 group-hover:translate-x-0.5"
    />
  </button>
{/if}
