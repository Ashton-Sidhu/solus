<script lang="ts">
  import { untrack } from "svelte";
  import type { AppState, AppSummary } from "@solus/contracts/apps";
  import { operationCallersText } from "@solus/client-core/app-operations";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import { Switch } from "../../ui/switch";
  import ManageSectionState from "./ManageSectionState.svelte";
  import { OPERATIONS_EMPTY } from "./lib/section-empty";
  import OperationRow from "./OperationRow.svelte";
  import OperationRunner from "./OperationRunner.svelte";
  import { isLongText, operationGroups } from "./lib/operations";

  /**
   * The operations the active version declares (docs/plans/apps.md §9.2): a
   * plain list of the reads and the writes, each with its calls of the last
   * 24 hours, and beside it one card, the console that runs the chosen one.
   * The line on top turns agent access on and off: with it on, each
   * operation is a tool for agents, and the instructions are what the app
   * tells them.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state. */
    state: AppState | undefined;
    /** Shows the Activity section; absent where the page has none to show. */
    onOpenActivity?: () => void;
  }
  let { serverId, app, state: appState, onOpenActivity }: Props = $props();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    return untrack(() => appsStore.metrics.watch(hostId, appId));
  });

  const descriptor = $derived(appState?.descriptor);
  const operations = $derived(descriptor?.operations);
  const groups = $derived(operationGroups(operations ?? []));
  const instructions = $derived(descriptor?.instructions ?? "");
  const metricsByOperation = $derived(new Map((appsStore.metrics.get(serverId, app.id)?.operations ?? []).map((entry) => [entry.operation, entry])));
  // The switch says what agents can do; the line beside it names the app's other callers.
  const callersText = $derived(
    descriptor
      ? operationCallersText({ hasUi: app.hasUi, schedules: descriptor.schedules.length, webhooks: descriptor.webhooks.length, workflows: descriptor.workflows.length, agentAccess: false })
      : null,
  );
  const refusal = $derived(app.stopped ? "The app is stopped. Start it to run an operation." : null);

  let chosenName = $state<string | null>(null);
  const chosen = $derived(operations?.find((operation) => operation.name === chosenName) ?? groups[0]?.operations[0]);
  let isBusy = $state(false);
  let showsInstructions = $state(false);
  let showsAllInstructions = $state(false);

  async function setAgentAccess(enabled: boolean) {
    if (isBusy) return;
    isBusy = true;
    try {
      await appsStore.setAgentAccess(serverId, app.id, enabled);
    } catch (cause) {
      toasts.error(enabled ? "Agent access was not turned on" : "Agent access was not turned off", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      isBusy = false;
    }
  }

  /** The arrow keys move along the list, across its groups. */
  function onRowKey(event: KeyboardEvent & { currentTarget: HTMLButtonElement }) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(event.currentTarget.closest("[data-operation-list]")?.querySelectorAll<HTMLButtonElement>("[data-operation-row]") ?? [])];
    const next = rows[rows.indexOf(event.currentTarget) + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
  }

  function openActivity(operation: string) {
    // A read without a kind opens the Activity section on its filter.
    void appsStore.calls.load(serverId, app.id, { operation });
    onOpenActivity?.();
  }
</script>

<div class="flex min-w-0 flex-col gap-6" data-testid="app-operations-section">
  <div class="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-sm" data-testid="app-agent-access-row">
    <label class="flex items-center gap-3 text-foreground">
      <!-- The switch shows what the host holds: a change that the host refused does not stay on screen. -->
      <Switch bind:checked={() => app.agentAccess, (enabled) => void setAgentAccess(enabled)} disabled={isBusy} aria-label="Agent access" data-testid="app-agent-access" />
      {app.agentAccess ? "Agents can call these operations as tools" : "Agents cannot call these operations"}
    </label>
    {#if callersText}
      <span class="min-w-0 text-[13px] text-(--solus-text-secondary)">{callersText}</span>
    {/if}
    {#if instructions}
      <Button size="xs" variant="link" class="ml-auto px-0 text-foreground underline underline-offset-4" aria-expanded={showsInstructions} onclick={() => (showsInstructions = !showsInstructions)}>
        Agent instructions
      </Button>
    {/if}
  </div>

  {#if showsInstructions && instructions}
    <section class="flex max-w-[44rem] min-w-0 flex-col items-start gap-1.5" aria-label="Agent instructions">
      <p class="m-0 text-[13px] text-(--solus-text-secondary)">What the app tells an agent before it calls an operation.</p>
      <p class="m-0 text-[13px] leading-[1.55] whitespace-pre-wrap text-pretty text-foreground/85 {showsAllInstructions ? '' : 'line-clamp-4'}" data-testid="app-instructions">{instructions}</p>
      {#if isLongText(instructions)}
        <Button size="xs" variant="ghost" class="-ml-2 text-(--solus-text-secondary)" aria-expanded={showsAllInstructions} onclick={() => (showsAllInstructions = !showsAllInstructions)}>
          {showsAllInstructions ? "Show less" : "Show all"}
        </Button>
      {/if}
    </section>
  {/if}

  {#if app.activeVersion === null}
    <p class="m-0 text-sm text-muted-foreground">No version of this app is active, so it has no operation.</p>
  {:else}
    <ManageSectionState
      count={operations?.length}
      error={appsStore.stateErrorFor(serverId, app.id)}
      {serverId}
      {app}
      empty={OPERATIONS_EMPTY}
      onRetry={() => void appsStore.loadState(serverId, app.id)}
    >
      <div class="grid min-w-0 grid-cols-1 items-start gap-x-6 gap-y-6 @min-[48rem]/pane:grid-cols-[14.5rem_minmax(0,1fr)]">
        <nav class="flex min-w-0 flex-col gap-3.5" aria-label="Operations" data-operation-list data-testid="app-operations">
          {#each groups as group (group.label)}
            <div class="flex min-w-0 flex-col gap-0.5">
              <h3 class="m-0 px-2.5 pt-1 pb-1.5 text-xs font-normal text-(--solus-text-tertiary)">{group.label}</h3>
              {#each group.operations as operation (operation.name)}
                <OperationRow
                  {operation}
                  metrics={metricsByOperation.get(operation.name)}
                  isChosen={chosen?.name === operation.name}
                  onChoose={() => (chosenName = operation.name)}
                  onKeydown={onRowKey}
                />
              {/each}
            </div>
          {/each}
          <p class="m-0 px-2.5 text-xs text-(--solus-text-tertiary)">Calls in the last 24 hours</p>
        </nav>

        {#if chosen}
          {#key `${app.activeVersion}:${chosen.name}`}
            <OperationRunner {serverId} appId={app.id} operation={chosen} {refusal} onOpenActivity={onOpenActivity ? () => openActivity(chosen.name) : undefined} />
          {/key}
        {/if}
      </div>
    </ManageSectionState>
  {/if}
</div>
