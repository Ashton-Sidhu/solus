<script lang="ts">
  import {
    PlayIcon,
    PauseIcon,
    StopIcon,
    TrashIcon,
    PencilSimpleIcon,
    StarIcon,
    ClockIcon,
    CircleNotchIcon,
  } from "phosphor-svelte";
  import type { Automation } from "../../../shared/types";
  import { compactRelativeTime } from "../ui/list-page";
  import { triggerSummary, folderLabel } from "./lib/automation-format";

  /** One line of the automations list, in the shared list-page row grammar:
   *  a 20px status tile, the name, the machine facts, then a right end that
   *  states the cadence and the last run at rest and swaps them for the verbs
   *  on hover. Lifecycle lives in the tile's tint and in the group heading —
   *  never in a badge, which would cost row width to say what the section
   *  already says. */
  interface Props {
    automation: Automation;
    /** Ticking clock from the page, so the age column counts up on its own. */
    now: number;
    selected?: boolean;
    onOpen: (a: Automation) => void;
    onToggleEnabled: (a: Automation, e: Event) => void;
    onRunNow: (a: Automation, e: Event) => void;
    onCancelRun: (a: Automation, e: Event) => void;
    onToggleFavorite: (a: Automation, e: Event) => void;
    onDelete: (a: Automation, e: Event) => void;
  }
  let {
    automation: a,
    now,
    selected = false,
    onOpen,
    onToggleEnabled,
    onRunNow,
    onCancelRun,
    onToggleFavorite,
    onDelete,
  }: Props = $props();

  const actBtn =
    "grid size-6 shrink-0 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-3)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

  const tone = $derived(
    a.lastRunStatus === "running"
      ? "running"
      : !a.enabled
        ? "paused"
        : a.lastRunStatus === "failed"
          ? "failed"
          : a.trigger.type === "manual"
            ? "manual"
            : "scheduled",
  );
  // One status token in, one fill/glyph pair out — no row picks a background
  // and a text colour separately and drifts from the chips beside it.
  const tile = $derived(
    {
      running: "bg-[color-mix(in_oklch,var(--running)_14%,transparent)] text-[var(--running)]",
      failed: "bg-[color-mix(in_oklch,var(--failure)_13%,transparent)] text-[color-mix(in_oklch,var(--failure)_70%,var(--foreground))]",
      scheduled: "bg-[color-mix(in_oklch,var(--running)_14%,transparent)] text-[var(--running)]",
      manual: "bg-[var(--wash-3)] text-muted-foreground",
      paused: "bg-[var(--wash-3)] text-muted-foreground",
    }[tone],
  );
  const schedule = $derived(triggerSummary(a.trigger));
  const toneLabel = $derived(
    tone === "running"
      ? "Running"
      : tone === "failed"
        ? "Last run failed"
        : tone === "paused"
          ? "Paused"
          : "Active",
  );
  const age = $derived(compactRelativeTime(a.lastRunAt, now));
</script>

<div
  class="group relative flex h-11 w-full items-center rounded-lg pr-2 pl-2.5 transition-shadow duration-150 {selected
    ? 'bg-[var(--wash-2)] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent)]'
    : 'hover:bg-[var(--wash-1)]'} {a.enabled ? '' : 'opacity-70'}"
  data-selected={selected}
>
  <button
    type="button"
    class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-[11px] border-0 bg-transparent p-0 text-left focus-visible:outline-none"
    onclick={() => onOpen(a)}
  >
    <!-- Slot 1 — cadence kind as a glyph, status as the tile's tint. -->
    <span
      class="flex size-5 shrink-0 items-center justify-center rounded-full shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_8%,transparent)] {tile}"
      title="{schedule} — {toneLabel}"
    >
      {#if tone === "running"}
        <CircleNotchIcon size={11} class="animate-spin [animation-duration:0.9s]" />
      {:else if a.trigger.type === "manual"}
        <PlayIcon size={9} weight="fill" />
      {:else}
        <ClockIcon size={10} />
      {/if}
    </span>

    <!-- Slot 2 — the only full-strength text in the row. -->
    <span
      class="max-w-[330px] shrink-0 truncate text-[13px] font-[450] tracking-[-.005em]"
      title={a.name}
    >
      {a.name}
    </span>

    <!-- Slot 3 — where it runs, and who wrote it. -->
    <span class="min-w-0 truncate font-mono text-[11px] text-muted-foreground opacity-75">
      {folderLabel(a.action.cwd)}{a.createdBy.kind === "agent" ? " · agent" : ""}
    </span>

    <span class="flex-1"></span>

    <!-- Slots 4 and 5 — what it does and when it last did it. They step aside
         for the verbs rather than sharing the line with them, so the right end
         is never two things at once. -->
    <span
      class="flex shrink-0 items-center gap-2 transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0"
    >
      <span
        class="w-[156px] text-right font-mono text-[11px] whitespace-nowrap text-muted-foreground opacity-85"
      >
        {schedule}
      </span>
      <span
        class="w-11 text-right font-mono text-[11px] tabular-nums text-muted-foreground opacity-70"
      >
        {age}
      </span>
    </span>
  </button>

  <div
    class="pointer-events-none absolute right-2 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
  >
    <button
      type="button"
      class="{actBtn} {a.favorite ? 'text-[var(--warning)]' : ''}"
      onclick={(e) => onToggleFavorite(a, e)}
      aria-label={a.favorite ? "Unstar" : "Star"}
      aria-pressed={a.favorite}
      title={a.favorite ? "Unstar" : "Star"}
    >
      <StarIcon size={12} weight={a.favorite ? "fill" : "regular"} />
    </button>
    <button
      type="button"
      class={actBtn}
      onclick={(e) => onRunNow(a, e)}
      disabled={!a.enabled || a.lastRunStatus === "running"}
      aria-label="Run now"
      title="Run now"
    >
      <PlayIcon size={12} weight="fill" />
    </button>
    <button
      type="button"
      class={actBtn}
      onclick={(e) => {
        e.stopPropagation();
        onOpen(a);
      }}
      aria-label="Edit"
      title="Edit"
    >
      <PencilSimpleIcon size={12} />
    </button>
    {#if a.lastRunStatus === "running"}
      <button
        type="button"
        class="{actBtn} text-[var(--failure)] hover:text-[var(--failure)]"
        onclick={(e) => onCancelRun(a, e)}
        aria-label="Stop run"
        title="Stop this run"
      >
        <StopIcon size={12} weight="fill" />
      </button>
    {:else if a.enabled}
      <button
        type="button"
        class={actBtn}
        onclick={(e) => onToggleEnabled(a, e)}
        aria-label="Pause automation"
        title="Pause — stop running on schedule"
      >
        <PauseIcon size={12} weight="fill" />
      </button>
    {:else}
      <button
        type="button"
        class="{actBtn} text-[var(--running)] hover:text-[var(--running)]"
        onclick={(e) => onToggleEnabled(a, e)}
        aria-label="Resume automation"
        title="Resume — run on schedule again"
      >
        <PlayIcon size={12} weight="fill" />
      </button>
    {/if}
    <button
      type="button"
      class="{actBtn} hover:bg-[color-mix(in_oklch,var(--failure)_13%,transparent)] hover:text-[var(--failure)]"
      onclick={(e) => onDelete(a, e)}
      aria-label="Delete"
      title="Delete"
    >
      <TrashIcon size={12} />
    </button>
  </div>
</div>
