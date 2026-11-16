<script lang="ts">
  import { untrack } from "svelte";
  import { CircleCheck as ResultIcon, MessageSquareText as PromptIcon, NotebookPen as NotesIcon, Wrench as OperationsIcon } from "@lucide/svelte";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import { callerText } from "../lib/app-view";
  import ModelCallResult from "./ModelCallResult.svelte";
  import StateIcon from "./StateIcon.svelte";
  import { canCancelModelCall, isLongPrompt, modelCallDuration, modelCallEndText, modelCallTokens, modelStepDuration, modelStepStateLabel } from "./lib/model-calls";

  /**
   * One model call (docs/plans/app-models.md §7): who started it, the model,
   * then the call in the order it happened — the prompt, the operations the
   * model called, what it wrote, and its result or error. The owner cancels a call that has not ended. A running call
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
  let isPromptOpen = $state(false);

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

<!-- A call reads top to bottom as it happened: what the app asked, the operations the model called, what the model wrote as it worked, and how it ended. -->
<div class="flex min-w-0 flex-col gap-6 px-4 pt-2 pb-5" data-testid="app-model-call-detail">
  {#if call}
    {@const tokens = modelCallTokens(call)}
    <div class="flex min-w-0 items-start gap-4">
      <dl class="m-0 grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-6 gap-y-3">
        <div class="min-w-0"><dt class="text-xs text-muted-foreground">Model</dt><dd class="m-0 mt-0.5 truncate text-sm text-foreground" title={call.provider ?? undefined}>{call.model ?? "Not chosen yet"}</dd></div>
        <div class="min-w-0"><dt class="text-xs text-muted-foreground">Effort</dt><dd class="m-0 mt-0.5 truncate text-sm text-foreground capitalize">{call.effort}</dd></div>
        <div class="min-w-0"><dt class="text-xs text-muted-foreground">Started by</dt><dd class="m-0 mt-0.5 truncate text-sm text-foreground">{callerText(call.caller, webhooks)}</dd></div>
        <div class="min-w-0"><dt class="text-xs text-muted-foreground">Started</dt><dd class="m-0 mt-0.5 truncate text-sm text-foreground" title={new Date(call.createdAt).toLocaleString()}>{new Date(call.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
        <div class="min-w-0"><dt class="text-xs text-muted-foreground">Duration</dt><dd class="m-0 mt-0.5 truncate text-sm tabular-nums text-foreground">{modelCallDuration(call, call.endedAt ?? Date.now())}</dd></div>
        {#if tokens}
          <div class="min-w-0"><dt class="text-xs text-muted-foreground">Tokens</dt><dd class="m-0 mt-0.5 truncate text-sm tabular-nums text-foreground">{tokens}</dd></div>
        {/if}
      </dl>
      {#if canCancelModelCall(call)}
        <Button size="xs" variant="outline" class="shrink-0" disabled={isBusy} onclick={() => void cancel()}>Cancel call</Button>
      {/if}
    </div>

    <section class="flex min-w-0 flex-col gap-1.5" aria-label="Prompt">
      {@render stageHeading(PromptIcon, "Prompt", "what the app asked")}
      <p class="m-0 text-sm/relaxed whitespace-pre-wrap text-pretty text-foreground {isPromptOpen ? 'max-h-[32rem] overflow-auto' : 'line-clamp-4'}">{call.prompt}</p>
      {#if isLongPrompt(call.prompt)}
        <Button size="xs" variant="ghost" class="-ml-2 self-start text-muted-foreground" aria-expanded={isPromptOpen} onclick={() => (isPromptOpen = !isPromptOpen)}>
          {isPromptOpen ? "Show less" : "Show the whole prompt"}
        </Button>
      {/if}
    </section>

    {#if call.steps.length > 0}
      <section class="flex min-w-0 flex-col gap-1.5" aria-label="Operations the model called">
        {@render stageHeading(OperationsIcon, "Operations", "the app's operations the model called")}
        <ol class="m-0 flex list-none flex-col p-0" data-testid="app-model-call-steps">
          {#each call.steps as step, index (index)}
            <li class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-1 text-[13px]">
              <StateIcon state={step.state === "done" ? "ok" : step.state} label={modelStepStateLabel(step.state)} size={14} />
              <span class="min-w-0 flex-1 truncate text-foreground">{step.tool}</span>
              <span class="shrink-0 text-xs tabular-nums {step.state === 'failed' ? 'text-(--failure)' : 'text-muted-foreground'}">{step.state === "done" ? modelStepDuration(step) : modelStepStateLabel(step.state)}</span>
              {#if step.error}
                <span class="min-w-0 basis-full truncate pl-5.5 text-xs text-(--failure)" title={step.error}>{step.error}</span>
              {/if}
            </li>
          {/each}
        </ol>
      </section>
    {/if}

    {#if call.text}
      <section class="flex min-w-0 flex-col gap-1.5" aria-label="What the model wrote">
        {@render stageHeading(NotesIcon, "Model notes", "what it wrote as it worked")}
        <p class="m-0 max-h-72 overflow-auto text-sm/relaxed whitespace-pre-wrap text-pretty text-(--solus-text-secondary)" aria-live="polite">{call.text}</p>
      </section>
    {/if}

    {#if call.error}
      <section class="flex min-w-0 flex-col gap-1.5" aria-label="Error">
        <h4 class="m-0 flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <StateIcon state={call.status === "cancelled" ? "stopped" : "failed"} />
          {call.status === "cancelled" ? "Cancelled" : "Failed"}
        </h4>
        <p class="m-0 text-sm text-(--failure) text-pretty" role="alert">{call.error}</p>
      </section>
    {:else if call.result !== null}
      <section class="flex min-w-0 flex-col" aria-label="Result">
        <ModelCallResult result={call.result}>
          {#snippet heading()}{@render stageHeading(ResultIcon, "Result", "what the app got back")}{/snippet}
        </ModelCallResult>
      </section>
    {:else}
      <p class="m-0 flex items-center gap-2 text-sm text-muted-foreground">
        <StateIcon state={canCancelModelCall(call) ? "running" : "idle"} />
        {modelCallEndText(call.status)}
      </p>
    {/if}
  {:else if isMissing}
    <p class="m-0 text-sm text-muted-foreground">The host no longer keeps this model call.</p>
  {:else if error}
    <p class="m-0 text-sm text-destructive" role="alert">{error}</p>
  {:else}
    <p class="m-0 text-sm text-muted-foreground" role="status" aria-busy="true">Loading the call…</p>
  {/if}
</div>

<!-- A stage of the call: its mark, its name, and one quiet line on what it holds. -->
{#snippet stageHeading(Icon: typeof PromptIcon, label: string, hint: string)}
  <h4 class="m-0 flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
    <Icon size={16} strokeWidth={1.5} class="shrink-0 text-muted-foreground" aria-hidden="true" />
    {label}
    <span class="truncate text-xs font-normal text-muted-foreground">{hint}</span>
  </h4>
{/snippet}
