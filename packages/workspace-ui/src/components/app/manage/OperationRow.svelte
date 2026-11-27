<script lang="ts">
  import type { AppOperation, AppOperationMetrics } from "@solus/contracts/apps";
  import { appTime } from "../lib/app-view";

  /**
   * One operation in the list of the Operations section (docs/plans/apps.md
   * §9.2): its name, its one line under it, and its calls of the last 24
   * hours, the failed ones in the error colour. Chosen, the console beside
   * the list runs it.
   */
  interface Props {
    operation: AppOperation;
    metrics: AppOperationMetrics | undefined;
    isChosen: boolean;
    onChoose: () => void;
    onKeydown: (event: KeyboardEvent & { currentTarget: HTMLButtonElement }) => void;
  }
  let { operation, metrics, isChosen, onChoose, onKeydown }: Props = $props();

  const calls = $derived(metrics?.calls ?? 0);
  const failed = $derived(metrics?.failed ?? 0);
</script>

<button
  type="button"
  class="flex w-full min-w-0 items-start gap-3 overflow-hidden rounded-[10px] px-2.5 py-2.25 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset {isChosen ? 'bg-[var(--wash-3)]' : 'hover:bg-[var(--wash-1)]'}"
  aria-current={isChosen ? "true" : undefined}
  data-testid="app-operation"
  data-operation={operation.name}
  data-operation-row
  onclick={onChoose}
  onkeydown={onKeydown}
>
  <span class="flex min-w-0 flex-1 flex-col">
    <span class="truncate text-sm leading-5 text-foreground {isChosen ? 'font-medium' : ''}">{operation.name}</span>
    {#if operation.description}
      <span class="truncate text-[12.5px] leading-5 text-(--solus-text-tertiary)" title={operation.description}>{operation.description}</span>
    {/if}
  </span>
  <span
    class="shrink-0 pt-0.5 text-xs tabular-nums text-(--solus-text-tertiary)"
    title={calls === 0
      ? "No call in the last 24 hours"
      : `${calls.toLocaleString()} ${calls === 1 ? "call" : "calls"} in the last 24 hours${failed > 0 ? `, ${failed.toLocaleString()} failed` : ""}${metrics?.lastAt ? `. Last ${appTime(metrics.lastAt)}` : ""}`}
  >
    {calls.toLocaleString()}{#if failed > 0}<span class="text-(--failure)"> · {failed.toLocaleString()}<span class="sr-only"> failed</span></span>{/if}
  </span>
</button>
