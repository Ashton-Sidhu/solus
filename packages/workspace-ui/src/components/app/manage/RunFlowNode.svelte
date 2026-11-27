<script lang="ts">
  import {
    Bot as AgentIcon,
    Clock as ScheduleIcon,
    Link as WebhookIcon,
    Sparkles as ModelIcon,
    User as PersonIcon,
    Workflow as WorkflowIcon,
  } from "@lucide/svelte";
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import { getRunFlowView } from "./lib/flow-views";
  import type { RunFlowNode } from "./lib/run-flow";
  import { stepNodeText, stepStateLabel } from "./lib/run-graph";
  import { stepState } from "./lib/states";
  import StateIcon from "./StateIcon.svelte";

  /**
   * One node of the run graph: the trigger, or a step with its state mark,
   * its name, and its time or tries. A step that did not run is dashed, and
   * the selected step has the accent ring. The mark alone says the state:
   * the node takes no tint.
   * A press or Enter on a step selects it for the inspector.
   */
  let { data }: NodeProps<RunFlowNode> = $props();

  const view = getRunFlowView();
</script>

{#if data.kind === "trigger"}
  <div class="flex size-full items-center gap-2.5 rounded-lg bg-background px-3 shadow-[shadow:var(--elev-lift)] dark:bg-card" data-testid="app-run-graph-trigger">
    <span class="grid size-7 shrink-0 place-items-center rounded-md bg-(--wash-3) text-(--solus-text-secondary)" aria-hidden="true">
      {#if data.caller.kind === "webhook"}
        <WebhookIcon size={14} strokeWidth={1.8} />
      {:else if data.caller.kind === "schedule"}
        <ScheduleIcon size={14} strokeWidth={1.8} />
      {:else if data.caller.kind === "agent"}
        <AgentIcon size={14} strokeWidth={1.8} />
      {:else if data.caller.kind === "workflow"}
        <WorkflowIcon size={14} strokeWidth={1.8} />
      {:else if data.caller.kind === "model"}
        <ModelIcon size={14} strokeWidth={1.8} />
      {:else}
        <PersonIcon size={14} strokeWidth={1.8} />
      {/if}
    </span>
    <span class="flex min-w-0 flex-col gap-px">
      <span class="truncate text-[13px] leading-4 font-medium text-foreground">{data.name}</span>
      <span class="truncate text-xs leading-4 text-(--solus-text-tertiary)">{data.detail}</span>
    </span>
  </div>
  <Handle type="source" position={Position.Bottom} isConnectable={false} />
{:else}
  {@const state = data.state}
  {@const isSelected = view.selectedStep === data.entry.name}
  <Handle type="target" position={Position.Top} isConnectable={false} />
  <button
    type="button"
    class="flex size-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg px-3 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] motion-safe:transition-shadow motion-safe:duration-150 {state === 'not-run'
      ? 'border-[1.5px] border-dashed border-(--hairline-strongest) bg-transparent'
      : 'bg-background shadow-[shadow:var(--elev-lift)] dark:bg-card'} {isSelected ? 'ring-[1.5px] ring-(--solus-accent)' : ''}"
    aria-pressed={isSelected}
    data-testid="app-run-graph-step"
    data-state={state}
    onclick={() => view.selectStep(data.entry.name)}
  >
    {#if state === "not-run"}
      <span class="grid size-7 shrink-0 place-items-center rounded-md bg-(--wash-3) text-(--solus-text-tertiary)" aria-hidden="true">
        <WorkflowIcon size={13} strokeWidth={1.8} />
      </span>
    {:else}
      <span class="grid size-7 shrink-0 place-items-center">
        <StateIcon state={stepState(state)} label={stepStateLabel(state)} />
      </span>
    {/if}
    <span class="flex min-w-0 flex-col gap-px">
      <span class="truncate text-[13px] leading-4 {state === 'not-run' ? 'font-medium text-(--solus-text-tertiary)' : isSelected ? 'font-semibold text-foreground' : 'font-medium text-foreground'}">{data.entry.name}</span>
      <span class="truncate text-xs leading-4 tabular-nums text-(--solus-text-tertiary)">{stepNodeText(data.entry, view.now)}</span>
    </span>
  </button>
  <Handle type="source" position={Position.Bottom} isConnectable={false} />
{/if}
