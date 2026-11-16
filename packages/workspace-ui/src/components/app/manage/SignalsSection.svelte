<script lang="ts">
  import { untrack } from "svelte";
  import type { AppSignalActionView, AppSignalView, AppSummary } from "@solus/contracts/apps";
  import { getClientShellContext, getWorkspaceContext } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import * as Tabs from "../../ui/tabs";
  import ManageSectionState from "./ManageSectionState.svelte";
  import SignalActionEditor from "./SignalActionEditor.svelte";
  import SignalFlowCanvas from "./SignalFlowCanvas.svelte";
  import {
    emptySignalActionDraft,
    signalActionDraftOf,
    signalActionOf,
    signalActionSummary,
    type SignalActionDraft,
  } from "./lib/signal-actions";
  import { actionColumnLabel, payloadSummary, tailCell, tailTime } from "./lib/signal-flow";

  /**
   * The signals the active version declares (docs/plans/apps.md §8.4, §9.2).
   * One signal at a time: its flow (what emits it, the signal, and the
   * owner's actions, each with its own switch), and under it the live tail of
   * its occurrences with how each action ended.
   */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  const session = getWorkspaceContext();
  const shell = getClientShellContext();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    return untrack(() => {
      const releaseSignals = appsStore.signals.watch(hostId, appId);
      // The automations of the app's host, for `run_automation`.
      const releaseAutomations = session.automationsStore.watchHost(hostId);
      return () => {
        releaseSignals();
        releaseAutomations();
      };
    });
  });
  const signals = $derived(appsStore.signals.get(serverId, app.id));
  const automations = $derived(session.automationsStore.itemsForHost(serverId));
  const automationName = (automationId: string) => automations.find((automation) => automation.id === automationId)?.name;

  let chosenSignal = $state<string | null>(null);
  const signal = $derived(signals?.find((entry) => entry.name === chosenSignal) ?? signals?.[0]);

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    const name = signal?.name;
    if (!name) return;
    return untrack(() => appsStore.signalTails.watch(hostId, appId, name));
  });
  const tail = $derived(signal ? appsStore.signalTails.get(serverId, app.id, signal.name) : undefined);

  /** The action the owner makes or changes now: one editor is open at a time. `actionId` is null for a new action. */
  let editing = $state<{ signal: string; actionId: string | null; draft: SignalActionDraft } | null>(null);
  let editError = $state<string | null>(null);
  let isBusy = $state(false);

  function startEdit(current: AppSignalView, action: AppSignalActionView | null) {
    editError = null;
    editing = { signal: current.name, actionId: action?.id ?? null, draft: action ? signalActionDraftOf(action) : emptySignalActionDraft() };
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

  function choose(name: string) {
    chosenSignal = name;
    if (editing && editing.signal !== name) editing = null;
  }
</script>

<ManageSectionState
  count={signals?.length}
  error={appsStore.signals.errorFor(serverId, app.id)}
  empty="This app declares no signal."
  onRetry={() => void appsStore.signals.load(serverId, app.id)}
>
  {#if signals && signal}
    {@const editedAction = editing?.signal === signal.name && editing.actionId ? signal.actions.find((action) => action.id === editing?.actionId) : undefined}
    <div class="flex min-w-0 flex-col gap-4" data-testid="app-signals">
      <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
        <Tabs.Root bind:value={() => signal.name, choose}>
          <Tabs.List class="h-auto max-w-full flex-wrap justify-start rounded-[10px] bg-(--wash-2) group-data-horizontal/tabs:h-auto">
            {#each signals as entry (entry.name)}
              <Tabs.Trigger value={entry.name} class="h-7.5 flex-none gap-1.5 px-3 text-sm">
                {entry.name}
                <span class="text-xs font-normal tabular-nums text-muted-foreground">{entry.count7d}</span>
              </Tabs.Trigger>
            {/each}
          </Tabs.List>
        </Tabs.Root>
        {#if signal.description}
          <p class="m-0 min-w-0 text-[13px] text-muted-foreground text-pretty">{signal.description}</p>
        {/if}
      </div>

      <SignalFlowCanvas
        {signal}
        {isBusy}
        editingActionId={editing?.signal === signal.name ? editing.actionId : null}
        summaryOf={(action) => signalActionSummary(action.action, automationName)}
        onEdit={(action) => startEdit(signal, action)}
        onSetEnabled={setEnabled}
      />

      {#if editing && editing.signal === signal.name}
        <section class="flex max-w-xl min-w-0 flex-col gap-3 px-1" aria-label={editing.actionId ? "Change the action" : "Add an action"}>
          <h4 class="m-0 text-[15px] font-semibold text-foreground">{editing.actionId ? "Change the action" : "Add an action"}</h4>
          <SignalActionEditor
            bind:draft={editing.draft}
            {automations}
            error={editError}
            disabled={isBusy}
            saveLabel={editing.actionId ? "Save" : "Add"}
            onSave={saveEdit}
            onCancel={cancelEdit}
            onDelete={editedAction ? () => remove(editedAction) : undefined}
          />
        </section>
      {/if}

      <section class="flex min-w-0 flex-col pt-1.5" aria-label="Live tail of {signal.name}" data-testid="app-signal-tail">
        <div class="flex items-center justify-between px-1 pb-2.5">
          <h4 class="m-0 text-[15px] leading-4.5 font-semibold text-foreground">Live tail</h4>
          {#if tail}
            {@const isPaused = tail.isPaused}
            <Button size="xs" variant="ghost" class="text-[13px] text-muted-foreground" aria-pressed={isPaused} onclick={() => appsStore.signalTails.setPaused(serverId, app.id, signal.name, !isPaused)}>
              {isPaused ? "Go on" : "Pause"}
            </Button>
          {/if}
        </div>
        {#if !tail || !tail.isLoaded}
          <p class="m-0 px-1 text-[13px] text-muted-foreground" role="status" aria-busy="true">Loading…</p>
        {:else if tail.error && tail.occurrences.length === 0}
          <p class="m-0 px-1 text-[13px] text-destructive" role="alert">{tail.error}</p>
        {:else if tail.occurrences.length === 0}
          <p class="m-0 px-1 text-[13px] text-muted-foreground">The app did not emit this signal yet. Each occurrence shows here as it comes.</p>
        {:else}
          <div class="min-w-0 overflow-x-auto">
            <table class="w-full min-w-120 border-collapse text-left">
              <thead>
                <tr class="border-y border-(--hairline)">
                  <th scope="col" class="h-9.5 w-24 px-1 text-xs font-normal tracking-[0.06em] text-muted-foreground uppercase">Time</th>
                  <th scope="col" class="h-9.5 px-1 text-xs font-normal tracking-[0.06em] text-muted-foreground uppercase">Payload</th>
                  {#each signal.actions as action (action.id)}
                    <th scope="col" class="h-9.5 w-40 px-1 text-xs font-normal tracking-[0.06em] text-muted-foreground uppercase" title={signalActionSummary(action.action, automationName)}>{actionColumnLabel(action.action)}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each tail.occurrences as occurrence (occurrence.id)}
                  <tr class="border-b border-(--hairline)">
                    <td class="h-11 px-1 text-sm whitespace-nowrap text-(--solus-text-secondary) tabular-nums" title={new Date(occurrence.emittedAt).toLocaleString()}>{tailTime(occurrence.emittedAt)}</td>
                    <td class="h-11 max-w-0 truncate px-1 text-sm text-foreground" title={occurrence.payload}>{payloadSummary(occurrence.payload)}</td>
                    {#each signal.actions as action (action.id)}
                      {@const cell = tailCell(occurrence, action.id)}
                      <td class="h-11 max-w-0 truncate px-1 text-sm {cell.isFailed ? 'text-(--failure)' : 'text-muted-foreground'}" title={cell.text}>
                        {#if cell.sessionId}
                          {@const sessionId = cell.sessionId}
                          <Button size="xs" variant="link" class="h-auto px-0 text-sm text-muted-foreground" onclick={() => shell.openResource({ kind: "session", sessionId, serverId })}>{cell.text}</Button>
                        {:else}
                          {cell.text}
                        {/if}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    </div>
  {/if}
</ManageSectionState>
