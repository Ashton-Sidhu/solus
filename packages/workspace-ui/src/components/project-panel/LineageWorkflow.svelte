<script lang="ts">
  import type { DigestWorkflow } from "@solus/contracts/session-digest";
  import { workflowPhases } from "./lib/rail-agents";

  let { workflow, halted }: { workflow: DigestWorkflow; halted: boolean } = $props();
  const phases = $derived(workflowPhases(workflow));
  const status = { queued: "Queued", running: "Running", completed: "Completed", failed: "Failed" };
</script>

{#if phases.length > 0}
  <details class="mx-2 mb-1 rounded-lg border border-(--solus-container-border) px-2 py-1 text-chrome-dense" data-testid="lineage-workflow">
    <summary class="cursor-pointer text-(--solus-text-secondary) focus-visible:outline-2 focus-visible:outline-ring">Workflow progress</summary>
    {#each phases as phase (phase.index)}
      <div class="py-1">
        <h3 class="m-0 font-medium">{phase.title}</h3>
        {#each phase.agents as agent (agent.index)}
          <div class="flex justify-between gap-2 py-0.5">
            <span class="min-w-0 truncate" title={agent.label}>{agent.label}</span>
            <span class="shrink-0 {agent.state === 'failed' ? 'text-(--solus-status-error)' : 'text-(--solus-text-tertiary)'}">
              {halted && (agent.state === "queued" || agent.state === "running") ? "Stopped" : status[agent.state]}
            </span>
          </div>
        {/each}
      </div>
    {/each}
  </details>
{/if}
