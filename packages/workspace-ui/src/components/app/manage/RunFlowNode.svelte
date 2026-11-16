<script lang="ts">
  import {
    Bot as AgentIcon,
    Check as DoneIcon,
    CircleDashed as RunningIcon,
    Clock as ScheduleIcon,
    Link as WebhookIcon,
    Moon as SleepingIcon,
    Sparkles as ModelIcon,
    User as PersonIcon,
    Workflow as WorkflowIcon,
    X as FailedIcon,
  } from "@lucide/svelte";
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import { getRunFlowView } from "./lib/flow-views";
  import type { RunFlowNode } from "./lib/run-flow";
  import { stepNodeText } from "./lib/run-graph";

  /**
   * One node of the run graph: the trigger, or a step with its mark, its
   * name, and its time or tries. The step that failed is outlined, a step
   * that did not run is dashed, and the selected step has the accent ring.
   * A press or Enter on a step selects it for the inspector.
   */
  let { data }: NodeProps<RunFlowNode> = $props();

  const view = getRunFlowView();
</script>

{#if data.kind === "trigger"}
  <div class="flex size-full items-center gap-2.5 rounded-lg border border-(--hairline) bg-background px-3 shadow-[0_1px_3px_rgb(0_0_0/0.06)] dark:bg-card" data-testid="app-run-graph-trigger">
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
      : isSelected
        ? 'border-[1.5px] border-(--solus-accent) bg-background shadow-[0_0_0_5px_color-mix(in_srgb,var(--solus-accent)_14%,transparent),0_2px_6px_rgb(0_0_0/0.08)] dark:bg-card'
        : state === 'failed'
          ? 'border-[1.5px] border-[color-mix(in_oklch,var(--failure)_55%,transparent)] bg-background shadow-[0_1px_3px_rgb(0_0_0/0.06)] dark:bg-card'
          : 'border border-(--hairline) bg-background shadow-[0_1px_3px_rgb(0_0_0/0.06)] hover:shadow-[0_2px_8px_rgb(0_0_0/0.08)] dark:bg-card'} {state === 'not-run' && isSelected ? 'shadow-[0_0_0_5px_color-mix(in_srgb,var(--solus-accent)_14%,transparent)]' : ''}"
    aria-pressed={isSelected}
    data-testid="app-run-graph-step"
    data-state={state}
    onclick={() => view.selectStep(data.entry.name)}
  >
    <span
      class="grid size-7 shrink-0 place-items-center rounded-md {state === 'done'
        ? 'bg-[color-mix(in_oklch,var(--success)_14%,transparent)] text-(--success)'
        : state === 'failed'
          ? 'bg-[color-mix(in_oklch,var(--failure)_13%,transparent)] text-(--failure)'
          : state === 'running'
            ? 'bg-[color-mix(in_oklch,var(--running)_14%,transparent)] text-(--running)'
            : 'bg-(--wash-3) text-(--solus-text-tertiary)'}"
      aria-hidden="true"
    >
      {#if state === "done"}
        <DoneIcon size={13} strokeWidth={2.6} />
      {:else if state === "failed"}
        <FailedIcon size={12} strokeWidth={2.8} />
      {:else if state === "running"}
        <RunningIcon size={14} strokeWidth={2} />
      {:else if state === "sleeping"}
        <SleepingIcon size={13} strokeWidth={2} />
      {:else}
        <WorkflowIcon size={13} strokeWidth={1.8} />
      {/if}
    </span>
    <span class="flex min-w-0 flex-col gap-px">
      <span class="truncate text-[13px] leading-4 {state === 'not-run' ? 'font-medium text-(--solus-text-tertiary)' : isSelected ? 'font-semibold text-foreground' : 'font-medium text-foreground'}">{data.entry.name}</span>
      <span class="truncate text-xs leading-4 tabular-nums {state === 'failed' ? 'text-(--failure)' : 'text-(--solus-text-tertiary)'}">{stepNodeText(data.entry, view.now)}</span>
    </span>
  </button>
  <Handle type="source" position={Position.Bottom} isConnectable={false} />
{/if}
