<script lang="ts">
  import {
    Clock as ClockIcon,
    Cpu as CpuIcon,
    DollarSign as CurrencyDollarIcon,
    Wrench as WrenchIcon,
  } from "@lucide/svelte";
  import * as TooltipUI from "../ui/tooltip";
  import { formatClock, formatCost, formatTokens } from "./lib/format";
  import type { SessionTurnRow } from "./lib/session-summary";

  /**
   * What a turn row does not print, on hover — the same move the session
   * sidebar makes, so a session row and a turn row answer a second question the
   * same way.
   *
   * The row prints the three things that identify a turn. Everything else the
   * rollup recorded is here, asked one row at a time, rather than crowded onto
   * every row at once.
   */
  interface Props {
    row: SessionTurnRow;
  }

  let { row }: Props = $props();
</script>

<TooltipUI.Content
  side="right"
  align="start"
  sideOffset={6}
  class="max-w-80 items-stretch p-0 text-left font-normal whitespace-normal"
>
  <div class="flex max-w-80 min-w-0 flex-col gap-2 p-2.5">
    <div class="min-w-0 font-medium text-(--solus-text-primary)">
      <span class="text-(--solus-text-tertiary) tabular-nums">Turn {row.turnNumber}</span>
      · {row.title}
    </div>
    <div class="grid gap-1.5 pl-0.5 text-(--solus-text-tertiary)">
      <div class="flex min-w-0 items-center gap-2">
        <ClockIcon size={12} class="shrink-0" />
        <span class="min-w-0 truncate text-(--solus-text-secondary) tabular-nums"
          >{formatClock(row.startedAt)}{row.origin ? ` · ${row.origin}` : ""}</span
        >
      </div>
      {#if row.model}
        <div class="flex min-w-0 items-center gap-2">
          <CpuIcon size={12} class="shrink-0" />
          <span class="min-w-0 truncate text-(--solus-text-secondary)">{row.model}</span>
        </div>
      {/if}
      {#if row.tokens != null || row.costUsd != null}
        <div class="flex min-w-0 items-center gap-2">
          <CurrencyDollarIcon size={12} class="shrink-0" />
          <span class="min-w-0 truncate text-(--solus-text-secondary) tabular-nums">
            {row.tokens == null ? "tokens not recorded" : `${formatTokens(row.tokens)} tokens`}{row.costUsd ==
            null
              ? ""
              : ` · ${formatCost(row.costUsd)}`}
          </span>
        </div>
      {/if}
      {#if row.toolCallCount != null}
        <div class="flex min-w-0 items-center gap-2">
          <WrenchIcon size={12} class="shrink-0" />
          <span class="min-w-0 truncate text-(--solus-text-secondary) tabular-nums"
            >{row.toolCallCount}
            {row.toolCallCount === 1 ? "tool call" : "tool calls"}</span
          >
        </div>
      {/if}
      <!-- Named, not coloured: the status is the one fact here a reader may be
           hunting for, and an unfinished turn is not the same as a failed one. -->
      <div style={row.failed ? "color:var(--failure)" : ""}>
        {row.failed ? `Ended ${row.status}` : row.status}
      </div>
    </div>
  </div>
</TooltipUI.Content>
