<script lang="ts">
  import {
    PlayIcon,
    PauseIcon,
    StopIcon,
    TrashIcon,
    PencilSimpleIcon,
    StarIcon,
    CursorIcon,
    AsteriskIcon,
  } from "phosphor-svelte";
  import type { Automation } from "../../../shared/types";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";
  import {
    triggerSummary,
    relativeTime,
    cadenceMark,
    folderLabel,
  } from "./lib/automation-format";

  interface Props {
    automation: Automation;
    onOpen: (a: Automation) => void;
    onToggleEnabled: (a: Automation, e: Event) => void;
    onRunNow: (a: Automation, e: Event) => void;
    onCancelRun: (a: Automation, e: Event) => void;
    onToggleFavorite: (a: Automation, e: Event) => void;
    onDelete: (a: Automation, e: Event) => void;
  }
  let {
    automation: a,
    onOpen,
    onToggleEnabled,
    onRunNow,
    onCancelRun,
    onToggleFavorite,
    onDelete,
  }: Props = $props();

  const stateBtnClass =
    "grid size-7 shrink-0 cursor-pointer place-items-center rounded-[0.4375rem] border-0 bg-transparent text-(--solus-text-tertiary) transition-[background-color,color] duration-100 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none [@media(pointer:coarse)]:size-11";
  const dangerIconBtnClass = `${PAGE_ICON_BTN} [&:hover:not(:disabled)]:bg-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_14%,transparent)] [&:hover:not(:disabled)]:text-[var(--solus-status-error,#e53e3e)]`;

  const tone = $derived(
    !a.enabled
      ? "paused"
      : a.lastRunStatus === "failed"
        ? "error"
        : a.lastRunStatus === "running"
          ? "running"
          : "on",
  );
  const toneLabel = $derived(
    tone === "running"
      ? "Running"
      : tone === "error"
        ? "Last run failed"
        : tone === "paused"
          ? "Paused"
          : "Active",
  );
  const mark = $derived(cadenceMark(a.trigger));
  const schedule = $derived(triggerSummary(a.trigger));
  const lastRunLabel = $derived(
    a.lastRunStatus === "running"
      ? "Running now"
      : a.lastRunStatus === "failed" && a.lastRunAt
        ? `Failed ${relativeTime(a.lastRunAt)}`
        : a.lastRunAt
          ? `Last ran ${relativeTime(a.lastRunAt)}`
          : "",
  );
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="group relative flex cursor-pointer items-center gap-3.5 rounded-[0.6875rem] px-3 py-3 transition-colors duration-150 ease-in-out hover:bg-(--solus-surface-hover) focus-visible:bg-(--solus-accent-light) focus-visible:outline-none {a.enabled
    ? ''
    : 'opacity-60'}"
  role="button"
  tabindex="0"
  onclick={() => onOpen(a)}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(a);
    }
  }}
>
  <!-- Cadence tile — the automation's rhythm as a mark ("9a", "MON", "30m").
       Status rides on the tile's material, not a separate indicator: accent +
       breathing halo while running, error tint when the last run failed,
       dashed when paused. -->
  <span
    class="relative grid size-[1.875rem] shrink-0 place-items-center rounded-[0.5rem] font-mono text-[0.625rem] font-semibold tracking-[0.02em] uppercase tabular-nums transition-colors duration-150 {tone ===
    'running'
      ? 'bg-(--solus-accent-light) text-(--solus-accent) shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)]'
      : tone === 'error'
        ? 'bg-(--solus-status-error-bg) text-(--solus-status-error) shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--solus-status-error)_28%,transparent)]'
        : tone === 'paused'
          ? 'border border-dashed border-(--solus-container-border) text-(--solus-text-tertiary)'
          : 'bg-[color-mix(in_srgb,var(--solus-text-primary)_6%,transparent)] text-(--solus-text-secondary) shadow-[inset_0_0_0_0.0625rem_color-mix(in_srgb,var(--solus-text-primary)_9%,transparent)]'}"
    role="img"
    aria-label="{schedule} — {toneLabel}"
    title="{schedule} — {toneLabel}"
  >
    {#if tone === "running"}
      <span
        class="animate-breathing pointer-events-none absolute inset-0 rounded-[0.5rem] shadow-[0_0_0_0.0625rem_color-mix(in_srgb,var(--solus-accent)_45%,transparent)]"
        aria-hidden="true"
      ></span>
    {/if}
    {#if mark.kind === "manual"}
      <CursorIcon size={13} />
    {:else if mark.kind === "expr"}
      <AsteriskIcon size={11} weight="bold" />
    {:else}
      {mark.text}
    {/if}
  </span>

  <!-- Name + agent badge, with folder and last-run state on a quieter second
       line, set in the mono face so it reads as machine facts. -->
  <div class="min-w-0 flex-1">
    <div class="flex items-baseline gap-2">
      <span
        class="truncate text-[0.90625rem] font-semibold tracking-[-0.015em] text-(--solus-text-primary)"
        >{a.name}</span
      >
      {#if a.createdBy.kind === "agent"}
        <span
          class="shrink-0 rounded bg-(--solus-surface-hover) px-1.5 py-px text-[0.59375rem] font-semibold tracking-[0.09em] text-(--solus-text-tertiary) uppercase"
          title="Created by an agent">agent</span
        >
      {/if}
    </div>
    <div
      class="mt-0.5 flex items-center gap-1.5 font-mono text-[0.75rem] text-(--solus-text-tertiary)"
    >
      <span class="truncate">{folderLabel(a.action.cwd)}</span>
      {#if lastRunLabel}
        <span class="opacity-50" aria-hidden="true">·</span>
        <span
          class="shrink-0 {a.lastRunStatus === 'failed'
            ? 'text-[var(--solus-status-error,#e53e3e)]'
            : a.lastRunStatus === 'running'
              ? 'text-(--solus-accent)'
              : ''}">{lastRunLabel}</span
        >
      {/if}
    </div>
  </div>

  <!-- Right: schedule + secondary actions, then the always-visible pause /
       resume / stop state control. -->
  <div class="flex flex-shrink-0 items-center gap-1.5">
    <div class="relative flex items-center justify-end">
      <span
        class="text-[0.8125rem] whitespace-nowrap text-[color-mix(in_srgb,var(--solus-text-primary)_70%,var(--solus-text-tertiary))] transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0"
      >
        {schedule}
      </span>
      <div
        class="pointer-events-none absolute right-0 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
      >
        <button
          type="button"
          class="{PAGE_ICON_BTN} {a.favorite
            ? 'text-[var(--solus-art-2,#c9883f)] [&:hover:not(:disabled)]:bg-[color-mix(in_srgb,var(--solus-art-2,#c9883f)_14%,transparent)] [&:hover:not(:disabled)]:text-[var(--solus-art-2,#c9883f)]'
            : ''}"
          onclick={(e) => onToggleFavorite(a, e)}
          aria-label={a.favorite ? "Unstar" : "Star"}
          aria-pressed={a.favorite}
          title={a.favorite ? "Unstar" : "Star"}
        >
          <StarIcon size={13} weight={a.favorite ? "fill" : "regular"} />
        </button>
        <button
          type="button"
          class={PAGE_ICON_BTN}
          onclick={(e) => onRunNow(a, e)}
          disabled={!a.enabled || a.lastRunStatus === "running"}
          aria-label="Run now"
          title="Run now"
        >
          <PlayIcon size={13} weight="fill" />
        </button>
        <button
          type="button"
          class={PAGE_ICON_BTN}
          onclick={(e) => {
            e.stopPropagation();
            onOpen(a);
          }}
          aria-label="Edit"
          title="Edit"
        >
          <PencilSimpleIcon size={13} />
        </button>
        <button
          type="button"
          class={dangerIconBtnClass}
          onclick={(e) => onDelete(a, e)}
          aria-label="Delete"
          title="Delete"
        >
          <TrashIcon size={13} />
        </button>
      </div>
    </div>

    {#if a.lastRunStatus === "running"}
      <button
        type="button"
        class="{stateBtnClass} bg-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_12%,transparent)] text-[var(--solus-status-error,#e53e3e)] hover:bg-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_20%,transparent)] hover:text-[var(--solus-status-error,#e53e3e)] focus-visible:bg-[color-mix(in_srgb,var(--solus-status-error,#e53e3e)_20%,transparent)] focus-visible:text-[var(--solus-status-error,#e53e3e)]"
        onclick={(e) => onCancelRun(a, e)}
        aria-label="Stop run"
        title="Stop this run"
      >
        <StopIcon size={13} weight="fill" />
      </button>
    {:else if a.enabled}
      <button
        type="button"
        class={stateBtnClass}
        onclick={(e) => onToggleEnabled(a, e)}
        aria-label="Pause automation"
        title="Pause — stop running on schedule"
      >
        <PauseIcon size={13} weight="fill" />
      </button>
    {:else}
      <button
        type="button"
        class="{stateBtnClass} text-(--solus-accent) hover:bg-(--solus-accent-light) hover:text-(--solus-accent) focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-accent)"
        onclick={(e) => onToggleEnabled(a, e)}
        aria-label="Resume automation"
        title="Resume — run on schedule again"
      >
        <PlayIcon size={13} weight="fill" />
      </button>
    {/if}
  </div>
</div>
