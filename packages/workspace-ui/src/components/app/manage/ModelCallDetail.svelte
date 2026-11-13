<script lang="ts">
  import { untrack } from "svelte";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import { callerText } from "../lib/app-view";
  import { canCancelModelCall, modelCallDuration, modelCallResultText, modelCallTokens, modelStepStateLabel } from "./lib/model-calls";

  /**
   * One model call (docs/plans/app-models.md §7): who started it, the model,
   * the prompt, the operations the model called, what it wrote, and its result
   * or error. The owner cancels a call that has not ended. A running call
   * reads again as it writes (`apps.activity`).
   */
  interface Props {
    serverId: string;
    appId: string;
    callId: string;
  }
  let { serverId, appId, callId }: Props = $props();

  $effect(() => {
    const hostId = serverId;
    const id = appId;
    const call = callId;
    return untrack(() => {
      const release = appsStore.modelCallDetail.watch(hostId, id, call);
      if (!appsStore.webhooks.get(hostId, id)) void appsStore.webhooks.load(hostId, id);
      return release;
    });
  });
  const read = $derived(appsStore.modelCallDetail.get(serverId, appId));
  // The store holds one call of an app at a time: the answer for another call is not this one's.
  const call = $derived(read && read.id === callId ? read : null);
  const isMissing = $derived(read === null && appsStore.modelCallDetail.queryFor(serverId, appId) === callId);
  const error = $derived(appsStore.modelCallDetail.errorFor(serverId, appId));
  const webhooks = $derived(appsStore.webhooks.get(serverId, appId) ?? []);

  let isBusy = $state(false);

  async function cancel() {
    if (isBusy) return;
    isBusy = true;
    try {
      await appsStore.cancelModelCall(serverId, appId, callId);
    } catch (cause) {
      toasts.error("The model call did not stop", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      isBusy = false;
      requestInputFocus();
    }
  }
</script>

<div class="flex min-w-0 flex-col gap-3 border-t border-border/40 px-3 py-3" data-testid="app-model-call-detail">
  {#if call}
    {@const tokens = modelCallTokens(call)}
    <dl class="m-0 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      <div class="flex gap-1.5"><dt>Started</dt><dd class="m-0 text-foreground">{new Date(call.createdAt).toLocaleString()}</dd></div>
      <div class="flex gap-1.5"><dt>By</dt><dd class="m-0 text-foreground">{callerText(call.caller, webhooks)}</dd></div>
      <div class="flex min-w-0 gap-1.5"><dt>Model</dt><dd class="m-0 min-w-0 truncate font-mono text-foreground">{call.model ?? "Not chosen yet"}</dd></div>
      <div class="flex gap-1.5"><dt>Effort</dt><dd class="m-0 text-foreground">{call.effort}</dd></div>
      <div class="flex gap-1.5"><dt>Time</dt><dd class="m-0 tabular-nums text-foreground">{modelCallDuration(call, call.endedAt ?? Date.now())}</dd></div>
      {#if tokens}
        <div class="flex gap-1.5"><dt>Tokens</dt><dd class="m-0 tabular-nums text-foreground">{tokens}</dd></div>
      {/if}
    </dl>

    {#if canCancelModelCall(call)}
      <div>
        <Button size="xs" variant="outline" disabled={isBusy} onclick={() => void cancel()}>Cancel</Button>
      </div>
    {/if}

    {#if call.error}
      <p class="m-0 text-sm text-destructive text-pretty" role="alert">{call.error}</p>
    {/if}

    <section class="flex min-w-0 flex-col gap-1" aria-label="Prompt">
      <h4 class="m-0 text-xs font-medium text-muted-foreground">Prompt</h4>
      <pre class="m-0 max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{call.prompt}</pre>
    </section>

    {#if call.steps.length > 0}
      <section class="flex min-w-0 flex-col gap-1.5" aria-label="Operations the model called">
        <h4 class="m-0 text-xs font-medium text-muted-foreground">Operations the model called</h4>
        <ol class="m-0 flex list-none flex-col gap-1 p-0" data-testid="app-model-call-steps">
          {#each call.steps as step, index (index)}
            <li class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg border border-border/50 px-3 py-1.5 text-xs">
              <code class="min-w-0 truncate font-mono text-(--solus-text-primary)">{step.tool}</code>
              <span class="shrink-0 {step.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}">{modelStepStateLabel(step.state)}</span>
              {#if step.error}
                <span class="min-w-0 basis-full truncate text-destructive" title={step.error}>{step.error}</span>
              {/if}
            </li>
          {/each}
        </ol>
      </section>
    {/if}

    {#if call.text}
      <section class="flex min-w-0 flex-col gap-1" aria-label="What the model wrote">
        <h4 class="m-0 text-xs font-medium text-muted-foreground">What the model wrote</h4>
        <pre class="m-0 max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap" aria-live="polite">{call.text}</pre>
      </section>
    {/if}

    {#if call.result !== null}
      <section class="flex min-w-0 flex-col gap-1" aria-label="Result">
        <h4 class="m-0 text-xs font-medium text-muted-foreground">Result</h4>
        <pre class="m-0 max-h-60 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{modelCallResultText(call.result)}</pre>
      </section>
    {/if}
  {:else if isMissing}
    <p class="m-0 text-xs text-muted-foreground">The host no longer keeps this model call.</p>
  {:else if error}
    <p class="m-0 text-xs text-destructive" role="alert">{error}</p>
  {:else}
    <p class="m-0 text-xs text-muted-foreground">Loading…</p>
  {/if}
</div>
