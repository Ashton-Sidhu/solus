<script lang="ts">
  import { untrack } from "svelte";
  import { Plus as AddIcon } from "@lucide/svelte";
  import type { AppSignalActionView, AppSignalView, AppSummary } from "@solus/contracts/apps";
  import { getClientShellContext, getWorkspaceContext } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import { Switch } from "../../ui/switch";
  import ManageHeading from "./ManageHeading.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import SignalActionEditor from "./SignalActionEditor.svelte";
  import { appTime } from "../lib/app-view";
  import { prettyJson } from "./lib/activity";
  import { hasSchema, jsonText } from "./lib/operations";
  import {
    deliveryText,
    emptySignalActionDraft,
    occurrencesOf,
    signalActionDraftOf,
    signalActionOf,
    signalActionSummary,
    type SignalActionDraft,
  } from "./lib/signal-actions";

  /**
   * The signals the active version declares (docs/plans/apps.md §8.4). A signal
   * does nothing by itself: the owner's signal actions decide. Each signal
   * shows its newest occurrences with how each action ended.
   */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  const session = getWorkspaceContext();
  const shell = getClientShellContext();

  /** The occurrences each signal shows. */
  const OCCURRENCES_SHOWN = 5;

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    return untrack(() => {
      const releaseSignals = appsStore.signals.watch(hostId, appId);
      const releaseOccurrences = appsStore.occurrences.watch(hostId, appId);
      // The automations of the app's host, for `run_automation`.
      const releaseAutomations = session.automationsStore.watchHost(hostId);
      return () => {
        releaseSignals();
        releaseOccurrences();
        releaseAutomations();
      };
    });
  });
  const signals = $derived(appsStore.signals.get(serverId, app.id));
  const occurrences = $derived(appsStore.occurrences.get(serverId, app.id));
  const automations = $derived(session.automationsStore.itemsForHost(serverId));
  const automationName = (automationId: string) => automations.find((automation) => automation.id === automationId)?.name;

  /** The action the owner makes or changes now: one editor is open at a time. `actionId` is null for a new action. */
  let editing = $state<{ signal: string; actionId: string | null; draft: SignalActionDraft } | null>(null);
  let editError = $state<string | null>(null);
  let isBusy = $state(false);

  function startEdit(signal: AppSignalView, action: AppSignalActionView | null) {
    editError = null;
    editing = { signal: signal.name, actionId: action?.id ?? null, draft: action ? signalActionDraftOf(action) : emptySignalActionDraft() };
  }

  function cancelEdit() {
    editing = null;
    editError = null;
    requestInputFocus();
  }

  async function act(action: () => Promise<void>, failure: string) {
    if (isBusy) return;
    isBusy = true;
    try {
      await action();
    } catch (cause) {
      toasts.error(failure, { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      isBusy = false;
    }
  }

  function saveEdit() {
    const current = editing;
    if (!current) return;
    const result = signalActionOf(current.draft);
    if (!result.ok) {
      editError = result.error;
      return;
    }
    editError = null;
    void act(async () => {
      await appsStore.saveSignalAction(serverId, app.id, current.signal, result.value, current.draft.enabled, current.actionId ?? undefined);
      editing = null;
      requestInputFocus();
    }, "The signal action was not saved");
  }

  function setEnabled(view: AppSignalActionView, enabled: boolean) {
    void act(() => appsStore.saveSignalAction(serverId, app.id, view.signal, view.action, enabled, view.id), enabled ? "The signal action was not turned on" : "The signal action was not turned off");
  }

  function remove(view: AppSignalActionView) {
    if (!confirm(`Delete this signal action? ${signalActionSummary(view.action, automationName)}.`)) return;
    void act(async () => {
      await appsStore.deleteSignalAction(serverId, app.id, view.id);
      if (editing?.actionId === view.id) editing = null;
      requestInputFocus();
    }, "The signal action was not deleted");
  }
</script>

<ManageHeading title="Signals" description="A signal is a typed event that the app emits. It does nothing by itself: its signal actions decide what one does." />

<ManageSectionState
  count={signals?.length}
  error={appsStore.signals.errorFor(serverId, app.id)}
  empty="This app declares no signal."
  onRetry={() => void appsStore.signals.load(serverId, app.id)}
>
  <ul class="m-0 flex list-none flex-col gap-3 p-0" data-testid="app-signals">
    {#each signals ?? [] as signal (signal.name)}
      {@const newest = occurrences ? occurrencesOf(occurrences, signal.name, OCCURRENCES_SHOWN) : undefined}
      <li class="flex min-w-0 flex-col gap-3 rounded-xl border border-border/50 px-3 py-3">
        <div class="flex min-w-0 flex-col gap-1">
          <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <code class="min-w-0 truncate font-mono text-sm text-(--solus-text-primary)">{signal.name}</code>
            <span class="min-w-0 flex-1"></span>
            <span class="shrink-0 text-xs text-muted-foreground">
              {signal.count24h === 1 ? "1 occurrence" : `${signal.count24h} occurrences`} in 24 hours{signal.lastEmittedAt === null ? "" : ` · last ${appTime(signal.lastEmittedAt)}`}
            </span>
          </div>
          {#if signal.description}
            <p class="m-0 text-xs text-muted-foreground text-pretty">{signal.description}</p>
          {/if}
          {#if hasSchema(signal.payload)}
            <details class="min-w-0 text-xs">
              <summary class="cursor-pointer text-muted-foreground">Payload schema</summary>
              <pre class="mt-1 mb-0 max-h-56 overflow-auto rounded-md bg-muted/50 p-2 font-mono whitespace-pre">{jsonText(signal.payload)}</pre>
            </details>
          {/if}
        </div>

        <section class="flex min-w-0 flex-col gap-2" aria-label="Signal actions of {signal.name}">
          <h4 class="m-0 text-xs font-medium text-muted-foreground">Signal actions</h4>
          {#if signal.actions.length === 0}
            <p class="m-0 text-xs text-muted-foreground">This signal has no action: an occurrence is kept and does nothing.</p>
          {/if}
          {#each signal.actions as action (action.id)}
            {#if editing?.signal === signal.name && editing.actionId === action.id}
              <SignalActionEditor bind:draft={editing.draft} {automations} error={editError} disabled={isBusy} saveLabel="Save" onSave={saveEdit} onCancel={cancelEdit} />
            {:else}
              <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5" data-testid="app-signal-action">
                <!-- The switch shows what the host holds: a change that the host refused does not stay on screen. -->
                <Switch
                  bind:checked={() => action.enabled, (enabled) => setEnabled(action, enabled)}
                  disabled={isBusy}
                  aria-label="{signalActionSummary(action.action, automationName)}, on"
                />
                <span class="min-w-40 flex-1 truncate text-sm {action.enabled ? '' : 'text-muted-foreground'}">{signalActionSummary(action.action, automationName)}</span>
                <Button size="xs" variant="outline" disabled={isBusy} onclick={() => startEdit(signal, action)}>Change</Button>
                <Button size="xs" variant="outline" disabled={isBusy} onclick={() => remove(action)}>Delete</Button>
              </div>
            {/if}
          {/each}
          {#if editing?.signal === signal.name && editing.actionId === null}
            <SignalActionEditor bind:draft={editing.draft} {automations} error={editError} disabled={isBusy} saveLabel="Add" onSave={saveEdit} onCancel={cancelEdit} />
          {:else}
            <Button size="xs" variant="ghost" class="self-start" disabled={isBusy} onclick={() => startEdit(signal, null)}>
              <AddIcon size={14} /> Add an action
            </Button>
          {/if}
        </section>

        <section class="flex min-w-0 flex-col gap-2" aria-label="Occurrences of {signal.name}">
          <h4 class="m-0 text-xs font-medium text-muted-foreground">Newest occurrences</h4>
          {#if newest === undefined}
            {@const occurrencesError = appsStore.occurrences.errorFor(serverId, app.id)}
            {#if occurrencesError}
              <div class="flex flex-wrap items-center gap-2" role="alert">
                <span class="text-xs text-destructive">{occurrencesError}</span>
                <Button size="xs" variant="outline" onclick={() => void appsStore.occurrences.load(serverId, app.id)}>Try again</Button>
              </div>
            {:else}
              <p class="m-0 text-xs text-muted-foreground" role="status" aria-busy="true">Loading…</p>
            {/if}
          {:else if newest.length === 0}
            <p class="m-0 text-xs text-muted-foreground">The app did not emit this signal yet.</p>
          {:else}
            <ul class="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="app-signal-occurrences">
              {#each newest as occurrence (occurrence.id)}
                <li class="flex min-w-0 flex-col gap-1 rounded-lg bg-[var(--wash-1)] px-3 py-2 text-xs">
                  <span class="text-muted-foreground" title={new Date(occurrence.emittedAt).toLocaleString()}>Emitted {appTime(occurrence.emittedAt)}</span>
                  <details class="min-w-0">
                    <summary class="cursor-pointer text-muted-foreground">Payload</summary>
                    <pre class="mt-1 mb-0 max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono whitespace-pre">{prettyJson(occurrence.payload)}</pre>
                  </details>
                  {#if occurrence.deliveries.length === 0}
                    <span class="text-muted-foreground">No action was on.</span>
                  {/if}
                  {#each occurrence.deliveries as delivery (delivery.actionId)}
                    <div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span class={delivery.status === "delivered" ? "" : "text-destructive"}>{deliveryText(delivery)}</span>
                      {#if delivery.detail}
                        <span class="min-w-0 flex-1 truncate text-muted-foreground" title={delivery.detail}>{delivery.detail}</span>
                      {/if}
                      {#if delivery.sessionId}
                        {@const sessionId = delivery.sessionId}
                        <Button size="xs" variant="link" class="h-auto px-0" onclick={() => shell.openResource({ kind: "session", sessionId, serverId })}>Open the session</Button>
                      {/if}
                    </div>
                  {/each}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      </li>
    {/each}
  </ul>
</ManageSectionState>
