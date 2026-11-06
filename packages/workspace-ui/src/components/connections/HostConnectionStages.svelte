<script lang="ts">
  /** The way to a host, one stage per row, in order (docs/plans/host-readiness.md).
   *  The word beside each stage carries the result; the mark only repeats it. */
  import { Check as CheckIcon, CircleHelp as UnknownIcon, X as FailedIcon } from "@lucide/svelte";
  import { connectionStageResultLabel, type ConnectionStageReport } from "@solus/contracts/host-connection";

  interface Props {
    stages: readonly ConnectionStageReport[];
  }

  let { stages }: Props = $props();
</script>

<ol class="flex flex-col gap-1.5 text-chrome-dense" data-testid="host-connection-stages">
  {#each stages as report (report.stage)}
    <li class="grid grid-cols-[1rem_minmax(0,1fr)_max-content] items-baseline gap-x-2">
      <span class="self-center" aria-hidden="true">
        {#if report.result === "ok"}
          <CheckIcon size={14} class="text-(--solus-text-secondary)" />
        {:else if report.result === "failed"}
          <FailedIcon size={14} class="text-(--solus-status-error)" />
        {:else}
          <UnknownIcon size={14} class="text-(--solus-text-tertiary)" />
        {/if}
      </span>
      <span class="min-w-0 font-medium text-(--solus-text-primary)">{report.label}</span>
      <span class={report.result === "failed" ? "text-(--solus-status-error)" : "text-(--solus-text-tertiary)"}>
        {connectionStageResultLabel(report.result)}
      </span>
      {#if report.detail}
        <span class="col-start-2 col-end-4 min-w-0 break-words text-(--solus-text-secondary) select-text">{report.detail}</span>
      {/if}
    </li>
  {/each}
</ol>
