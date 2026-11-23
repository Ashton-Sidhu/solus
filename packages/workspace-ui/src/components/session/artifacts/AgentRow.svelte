<script lang="ts">
  import { AlarmClock as SnoozedIcon, Bot as BotIcon } from "@lucide/svelte";
  import ProviderMark from "../../ui/ProviderMark.svelte";
  import AgentStateMark from "../../conversation/AgentStateMark.svelte";
  import { agentMarkShowsElapsed } from "../../conversation/lib/agent-link";
  import { formatCompactElapsed, type RailAgentRow } from "../../project-panel/lib/rail-agents";
  import { wakeTimeLabel } from "./lib/overview-view";

  /**
   * One agent the session dispatched: a sub-agent, or a session it started.
   * Its provider leads; the title line ends with its state mark, the one the
   * conversation's row shows for it, and how long it ran (counting while it
   * runs); the line under it says what it is on or came back with. What it linked is in the surface's link cards, not on
   * the row. A snoozed session shows when it wakes; the pill wakes it now.
   */
  interface Props {
    row: RailAgentRow;
    onOpen: (split: boolean) => void;
    /** The session's menu. Absent for a sub-agent, which is no session of its own. */
    onContextMenu?: (event: MouseEvent) => void;
    /** When the snoozed session wakes, in epoch ms. Null while it is not snoozed. */
    wakesAt?: number | null;
    onWake?: () => void;
  }
  let { row, onOpen, onContextMenu, wakesAt = null, onWake }: Props = $props();

  const mark = $derived(row.provider === "codex" ? "codex" : row.provider === "claude-code" ? "claude" : null);
  const elapsed = $derived(agentMarkShowsElapsed(row.mark) ? formatCompactElapsed(row.elapsedMs) : null);
  const wakeTime = $derived(wakesAt === null ? null : wakeTimeLabel(wakesAt, Date.now()));
</script>

<!-- The button stretches over the whole row (its ::after), so the row opens
     the agent from anywhere; the wake pill and the chips sit above it and act on their own. -->
<div
  class="relative grid grid-cols-[1rem_minmax(0,1fr)_auto] gap-x-2.5 rounded-lg px-2 py-2 transition-colors duration-(--duration-base) ease-(--ease-premium) hover:bg-[var(--wash-2)] has-[>button:disabled]:hover:bg-transparent"
  data-testid="artifacts-agent-row"
  data-state={row.standing}
  oncontextmenu={onContextMenu}
>
  <span class="flex h-5 items-center justify-center opacity-70" aria-hidden="true">
    {#if mark}
      <ProviderMark {mark} size={mark === "codex" ? 11 : 14} transparent />
    {:else}
      <BotIcon size={16} class="text-muted-foreground" />
    {/if}
  </span>
  <button
    type="button"
    title={row.tooltip}
    aria-label="{row.title}, {row.status}"
    disabled={row.kind === "session" && row.pending}
    class="min-w-0 cursor-pointer overflow-hidden border-0 bg-transparent p-0 text-left after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-(--solus-accent-border-medium) disabled:cursor-default"
    onclick={(event) => onOpen(event.metaKey || event.ctrlKey)}
  >
    <span class="block truncate text-workspace-chrome leading-5 text-foreground">{row.title}</span>
    <span class="block truncate text-xs leading-5 text-muted-foreground">{row.detail || row.status}</span>
  </button>
  <span class="flex h-5 shrink-0 items-center gap-2">
    {#if wakeTime}
      <!-- The blue of the sidebar's Snoozed shelf, so a snoozed row reads the same in both places. -->
      <button
        type="button"
        class="relative inline-flex h-5 max-w-48 min-w-0 cursor-pointer items-center gap-1 overflow-hidden rounded-full border-0 bg-[color-mix(in_oklch,var(--solus-status-unread)_14%,transparent)] px-2 text-[11px] font-medium text-(--solus-status-unread) transition-colors duration-(--duration-base) ease-(--ease-premium) hover:bg-[color-mix(in_oklch,var(--solus-status-unread)_22%,transparent)] focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:h-7"
        title="Wake now"
        aria-label="Snoozed until {wakeTime}. Wake now"
        onclick={onWake}
      >
        <SnoozedIcon size={12} class="shrink-0" />
        <span class="truncate tabular-nums @max-[23rem]/card:hidden">Until {wakeTime}</span>
      </button>
    {/if}
    {#if row.mark}<AgentStateMark mark={row.mark} label={row.status} />{/if}
    <!-- The sidebar's clock: ink, not hue, so it never competes with the mark or a chip's colour. -->
    {#if elapsed}
      <span class="shrink-0 text-sidebar-time tabular-nums text-[color-mix(in_oklch,var(--foreground)_45%,transparent)]">{elapsed}</span>
    {/if}
  </span>
</div>
