<script lang="ts">
  import { ChevronDown as NextIcon, ChevronUp as PreviousIcon, Maximize2 as ExpandIcon, Minimize2 as ShrinkIcon, Sparkles as ModelIcon, X as CloseIcon } from "@lucide/svelte";
  import type { AppCallTerm, AppCallView, AppWebhookView } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { useScope } from "../../../lib/keybindings/use-keybinding.svelte";
  import { copyText, toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import CallDetail from "./CallDetail.svelte";
  import ModelCallDetail from "./ModelCallDetail.svelte";
  import StateIcon from "./StateIcon.svelte";
  import { callClockText, callMillisText, callMessage, type CallFieldName, type CallFixFacts } from "./lib/activity";
  import { callJsonText, callSheetSummary, callsAround, neighbourCall } from "./lib/call-sheet";
  import { canCancelModelCall } from "./lib/model-calls";
  import { callState } from "./lib/states";

  /**
   * One call of the log in a full-height sheet over the Manage page
   * (docs/plans/apps.md §9.2): its head with the way to the call before and
   * after it, its document, and a floating bar of actions. j and k, or the
   * arrow keys, step through the calls of the log; Escape closes the sheet.
   * It is fixed to the pane, so it covers the page and not the window.
   */
  interface Props {
    serverId: string;
    appId: string;
    call: AppCallView;
    /** The calls of the log in the order shown: the sheet steps through them. */
    calls: readonly AppCallView[];
    webhooks: AppWebhookView[];
    p95Ms?: number | null;
    liveVersion?: number | null;
    columns?: readonly CallFieldName[];
    onOpenCall: (callId: string) => void;
    onClose: () => void;
    onOpenRun?: (runId: string) => void;
    onAskAgent?: (call: CallFixFacts) => void;
    onFilter?: (term: AppCallTerm) => void;
    onToggleColumn?: (field: CallFieldName) => void;
  }
  let { serverId, appId, call, calls, webhooks, p95Ms = null, liveVersion = null, columns = [], onOpenCall, onClose, onOpenRun, onAskAgent, onFilter, onToggleColumn }: Props = $props();

  // A modal: the shortcuts of the page behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true });

  let isExpanded = $state(false);
  let isCancelling = $state(false);
  const index = $derived(calls.findIndex((entry) => entry.id === call.id));
  const previous = $derived(neighbourCall(calls, call.id, -1));
  const next = $derived(neighbourCall(calls, call.id, 1));
  const runId = $derived(call.caller.kind === "workflow" ? call.caller.runId : null);
  const operationDetail = $derived.by(() => {
    const read = call.kind === "operation" ? appsStore.callDetail.get(serverId, appId) : null;
    return read && read.id === call.id ? read : null;
  });
  const modelDetail = $derived.by(() => {
    const read = call.kind === "model" ? appsStore.modelCallDetail.get(serverId, appId) : null;
    return read && read.id === call.id ? read : null;
  });
  const json = $derived(operationDetail ? callJsonText(operationDetail) : modelDetail ? JSON.stringify(modelDetail, null, 2) : null);

  function focusSelf(node: HTMLElement) {
    node.focus({ preventScroll: true });
  }

  function isTyping(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select") !== null);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      // The topmost surface owns Escape: the page behind must not read it as "close the page".
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
    const step = event.key === "j" || event.key === "ArrowDown" ? next : event.key === "k" || event.key === "ArrowUp" ? previous : undefined;
    if (step === undefined) return;
    event.preventDefault();
    if (step) onOpenCall(step.id);
  }

  async function copyJson() {
    if (json === null) return;
    if (!(await copyText(json))) toasts.error("The call was not copied");
  }

  async function cancel() {
    if (isCancelling) return;
    isCancelling = true;
    try {
      await appsStore.cancelModelCall(serverId, appId, call.id);
    } catch (cause) {
      toasts.error("The model call did not stop", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      isCancelling = false;
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- The scrim closes the sheet on a click. The sheet's close control is the labelled way out. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-40 bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)]" onclick={onClose}></div>

<div
  class="call-sheet fixed top-2 right-2 bottom-2 z-40 flex flex-col overflow-hidden rounded-2xl bg-background text-left outline-none shadow-[shadow:var(--elev-lift)] {isExpanded
    ? 'left-2'
    : 'w-[min(38.75rem,calc(100%-1rem))]'}"
  role="dialog"
  aria-modal="true"
  aria-label="The call {call.operation}"
  tabindex="-1"
  data-testid="app-call-sheet"
  use:focusSelf
>
  <header class="flex shrink-0 flex-col gap-1.5 px-6 pt-5">
    <div class="flex min-w-0 items-center gap-2.5">
      <span class="flex w-4.5 shrink-0 justify-center">
        {#if call.kind === "model" && call.outcome === "ok"}
          <ModelIcon size={18} strokeWidth={1.75} class="text-(--solus-text-tertiary)" aria-label="Model call" />
        {:else}
          <StateIcon state={callState(call.outcome)} size={18} label={call.outcome === "failed" ? "Failed" : call.outcome === "running" ? "Running" : "Ended"} />
        {/if}
      </span>
      <h2 class="m-0 min-w-0 flex-1 truncate text-[19px] leading-6 font-semibold tracking-[-0.01em] text-foreground" title={call.operation}>{call.operation}</h2>
      <div class="flex shrink-0 items-center gap-0.5">
        <Button size="icon-sm" variant="ghost" disabled={!previous} aria-label="The call before (k)" title="The call before (k)" onclick={() => previous && onOpenCall(previous.id)}><PreviousIcon /></Button>
        <Button size="icon-sm" variant="ghost" disabled={!next} aria-label="The call after (j)" title="The call after (j)" onclick={() => next && onOpenCall(next.id)}><NextIcon /></Button>
        {#if index !== -1}
          <span class="px-1.5 font-mono text-[11.5px] whitespace-nowrap text-(--solus-text-tertiary) @max-[30rem]/pane:hidden">{index + 1} of {calls.length.toLocaleString()}</span>
        {/if}
        <span class="mx-1.5 h-4 w-px shrink-0 bg-[var(--hairline-strong)]" aria-hidden="true"></span>
        <Button size="icon-sm" variant="ghost" class="@max-[48rem]/pane:hidden" aria-label={isExpanded ? "Make the sheet narrow" : "Make the sheet wide"} aria-pressed={isExpanded} onclick={() => (isExpanded = !isExpanded)}>
          {#if isExpanded}<ShrinkIcon />{:else}<ExpandIcon />{/if}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Close the call (Escape)" title="Close (Escape)" onclick={onClose}><CloseIcon /></Button>
      </div>
    </div>
    <p class="m-0 min-w-0 truncate pl-7 text-[13px] leading-4.5 text-(--solus-text-tertiary)">
      {callSheetSummary(call)} · <span class="font-mono text-xs select-text">{call.id}</span>
    </p>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-24">
    {#if call.kind === "model"}
      <ModelCallDetail {serverId} {appId} row={call} {webhooks} {p95Ms} {liveVersion} {columns} {onFilter} {onToggleColumn} {around} />
    {:else}
      <CallDetail {serverId} {appId} callId={call.id} {webhooks} {p95Ms} {liveVersion} {columns} {onFilter} {onToggleColumn} {around} />
    {/if}
  </div>

  <!-- The actions float over the end of the document, so they stay in reach as it scrolls. -->
  <div class="absolute inset-x-3 bottom-3 flex min-w-0 flex-wrap items-center gap-2 rounded-[14px] bg-background px-3 py-2 shadow-[shadow:var(--elev-lift)]">
    {#if call.outcome === "failed" && onAskAgent}
      <Button size="sm" onclick={() => onAskAgent({ ...call, errorStack: operationDetail?.errorStack ?? null })}>Ask an agent to fix</Button>
    {/if}
    {#if modelDetail && canCancelModelCall(modelDetail)}
      <Button size="sm" variant="outline" disabled={isCancelling} onclick={() => void cancel()}>Cancel call</Button>
    {/if}
    {#if runId && onOpenRun}
      {@const id = runId}
      <Button size="sm" variant="outline" onclick={() => onOpenRun(id)}>Open run</Button>
    {/if}
    <Button size="sm" variant="outline" disabled={json === null} onclick={() => void copyJson()}>Copy as JSON</Button>
    <span class="flex-1"></span>
    <span class="pr-2 font-mono text-[11px] text-(--solus-text-tertiary) pointer-coarse:hidden" aria-hidden="true">j k · esc</span>
  </div>
</div>

{#snippet around()}
  {@const nearby = callsAround(calls, call.id)}
  <ol class="m-0 flex list-none flex-col p-0 px-4" aria-label="The calls around this call">
    {#each nearby as entry (entry.id)}
      {@const isThis = entry.id === call.id}
      {@const message = callMessage(entry)}
      <li>
        <button
          type="button"
          class="flex w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-[7px] px-2 py-1.5 text-left outline-none hover:bg-[var(--wash-1)] focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)] {isThis ? 'bg-[var(--wash-3)]' : ''}"
          aria-current={isThis ? "true" : undefined}
          onclick={() => onOpenCall(entry.id)}
        >
          <span class="flex w-4 shrink-0 justify-center">
            {#if entry.outcome !== "ok"}
              <StateIcon state={callState(entry.outcome)} size={14} />
            {:else if entry.kind === "model"}
              <ModelIcon size={14} strokeWidth={1.75} class="text-(--solus-text-tertiary)" aria-hidden="true" />
            {/if}
          </span>
          <span class="shrink-0 font-mono text-xs text-(--solus-text-secondary)">{callClockText(entry.startedAt, false)}{callMillisText(entry.startedAt)}</span>
          <span class="min-w-0 flex-1 truncate text-[13px] text-foreground"><span class="font-medium">{entry.operation}</span>{#if message}<span class="text-(--solus-text-tertiary)"> · {message}</span>{/if}</span>
        </button>
      </li>
    {/each}
  </ol>
{/snippet}

<style>
  /* The sheet arrives from the edge it is anchored to. Transform only, so the page behind does not repaint. */
  @media (prefers-reduced-motion: no-preference) {
    .call-sheet {
      animation: call-sheet-in 0.22s cubic-bezier(0.32, 0.72, 0, 1);
    }
  }

  @keyframes call-sheet-in {
    from {
      transform: translateX(2rem);
      opacity: 0;
    }
  }
</style>
