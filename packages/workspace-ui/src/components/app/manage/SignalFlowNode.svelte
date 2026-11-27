<script lang="ts">
  import { BellRing as SignalIcon, Plus as AddIcon } from "@lucide/svelte";
  import { Handle, Position, type NodeProps } from "@xyflow/svelte";
  import { Switch } from "../../ui/switch";
  import StateIcon from "./StateIcon.svelte";
  import { appTime } from "../lib/app-view";
  import { getSignalFlowView } from "./lib/flow-views";
  import { actionCountText, type SignalFlowNode } from "./lib/signal-flow";

  /**
   * One node of a signal's flow: what emitted it, the signal, one of its
   * actions (a press opens its editor; its switch turns it on or off), or
   * the dashed node that adds an action. The controls take no drag and no
   * pan, so a press on them is only a press.
   */
  let { data }: NodeProps<SignalFlowNode> = $props();

  const view = getSignalFlowView();
  const targetPosition = $derived(view.isStacked ? Position.Top : Position.Left);
  const sourcePosition = $derived(view.isStacked ? Position.Bottom : Position.Right);
</script>

{#if data.kind === "emitter"}
  <div class="flex size-full flex-col justify-center gap-0.5 overflow-hidden rounded-lg bg-background px-3.5 shadow-[shadow:var(--elev-lift)] dark:bg-card">
    {#if data.emitter}
      <span class="truncate text-xs text-muted-foreground">{data.emitter.label}</span>
      <span class="truncate text-sm font-medium text-foreground" title={data.emitter.name}>{data.emitter.name}</span>
    {:else}
      <span class="line-clamp-2 text-xs text-muted-foreground">The app did not emit this signal yet.</span>
    {/if}
  </div>
  <Handle type="source" position={sourcePosition} isConnectable={false} />
{:else if data.kind === "signal"}
  <Handle type="target" position={targetPosition} isConnectable={false} />
  <div class="flex w-full flex-col gap-2 rounded-[14px] bg-background px-4 py-3.5 shadow-[shadow:var(--elev-lift)] ring-[1.5px] ring-primary dark:bg-card">
    <div class="flex min-w-0 items-center gap-1.75">
      <SignalIcon size={15} class="shrink-0 text-primary" aria-hidden="true" />
      <h3 class="m-0 min-w-0 truncate text-[15px] leading-4.5 font-semibold text-foreground">{data.signal.name}</h3>
    </div>
    <span class="text-xs text-muted-foreground">
      {data.signal.count7d} this week{data.signal.lastEmittedAt === null ? "" : ` · last ${appTime(data.signal.lastEmittedAt)}`}
    </span>
    {#if data.fields.length > 0}
      <div class="flex flex-wrap gap-1" aria-label="Payload fields">
        {#each data.fields as field (field)}
          <span class="rounded-full bg-(--wash-2) px-2 py-0.75 font-mono text-xs text-(--solus-text-secondary)">{field}</span>
        {/each}
      </div>
    {/if}
  </div>
  <Handle type="source" position={sourcePosition} isConnectable={false} />
{:else if data.kind === "action"}
  {@const action = data.action}
  {@const summary = view.summaryOf(action)}
  {@const count = actionCountText(action)}
  <Handle type="target" position={targetPosition} isConnectable={false} />
  <div
    class="flex size-full min-w-0 items-center gap-2.5 rounded-lg bg-background px-3.5 shadow-[shadow:var(--elev-lift)] dark:bg-card {view.editingActionId === action.id ? 'ring-[1.5px] ring-primary' : ''}"
    data-testid="app-signal-action"
  >
    <button
      type="button"
      class="nodrag nopan flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 overflow-hidden rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      aria-label="Change the action: {summary}"
      disabled={view.isBusy}
      onclick={() => view.edit(action)}
    >
      <span class="truncate text-sm font-medium {action.enabled ? 'text-foreground' : 'text-muted-foreground'}" title={summary}>{summary}</span>
      <span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {#if count.hasFailures}<StateIcon state="failed" label="Some deliveries failed" size={12} />{/if}
        <span class="truncate">{count.text}</span>
      </span>
    </button>
    <!-- The switch shows what the host holds: a change that the host refused does not stay on screen. -->
    <Switch class="nodrag nopan" bind:checked={() => action.enabled, (enabled) => view.setEnabled(action, enabled)} disabled={view.isBusy} aria-label="{summary}, on" />
  </div>
{:else}
  <Handle type="target" position={targetPosition} isConnectable={false} />
  <button
    type="button"
    class="nodrag nopan flex size-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg border-[1.5px] border-dashed border-(--hairline-strongest) px-3.5 text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    disabled={view.isBusy}
    onclick={() => view.edit(null)}
  >
    <AddIcon size={14} class="shrink-0" aria-hidden="true" />
    <span class="truncate">Add an action</span>
  </button>
{/if}
