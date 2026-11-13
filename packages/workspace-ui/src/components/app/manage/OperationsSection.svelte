<script lang="ts">
  import type { AppState, AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import { Switch } from "../../ui/switch";
  import ManageHeading from "./ManageHeading.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import OperationRunner from "./OperationRunner.svelte";
  import { hasSchema, jsonText } from "./lib/operations";

  /**
   * The operations the active version declares (docs/plans/apps.md §9.2): each
   * one with its schemas and a form to run it. Agent access decides whether
   * they are tools for agents. The app's instructions are what it tells those agents.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state. */
    state: AppState | undefined;
  }
  let { serverId, app, state: appState }: Props = $props();

  const operations = $derived(appState?.descriptor?.operations);
  const instructions = $derived(appState?.descriptor?.instructions ?? "");
  const refusal = $derived(app.stopped ? "The app is stopped." : null);

  /** The operation whose form shows. */
  let openOperation = $state<string | null>(null);
  let isBusy = $state(false);

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
</script>

<ManageHeading title="Operations" description="The typed queries and mutations of the app. Its UI, an agent, a schedule, a webhook, and a workflow call the same ones." />

<div class="flex flex-col gap-6">
  <section class="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2 rounded-xl border border-border/50 px-3 py-3" aria-label="Agent access">
    <div class="flex min-w-40 flex-1 flex-col gap-0.5">
      <span id="app-agent-access-label" class="text-sm font-medium">Agent access</span>
      <span class="text-xs text-muted-foreground text-pretty">
        {app.agentAccess ? "Each operation of this app is a tool for agents on this host." : "Agents on this host cannot call the operations of this app."}
      </span>
    </div>
    <!-- The switch shows what the host holds: a change that the host refused does not stay on screen. -->
    <Switch bind:checked={() => app.agentAccess, (enabled) => void setAgentAccess(enabled)} disabled={isBusy} aria-labelledby="app-agent-access-label" data-testid="app-agent-access" />
  </section>

  {#if instructions}
    <section class="flex min-w-0 flex-col gap-1.5" aria-label="Instructions">
      <h3 class="m-0 text-sm font-medium">Instructions</h3>
      <p class="m-0 text-xs text-muted-foreground">What the app tells the agents that use it.</p>
      <p class="m-0 rounded-lg bg-[var(--wash-1)] px-3 py-2 text-sm whitespace-pre-wrap text-pretty" data-testid="app-instructions">{instructions}</p>
    </section>
  {/if}

  <section class="flex min-w-0 flex-col gap-2" aria-label="Operations">
    <h3 class="m-0 text-sm font-medium">Operations</h3>
    {#if app.activeVersion === null}
      <p class="m-0 text-sm text-muted-foreground">No version of this app is active, so it has no operation.</p>
    {:else}
      <ManageSectionState
        count={operations?.length}
        error={appsStore.stateErrorFor(serverId, app.id)}
        empty="This app declares no operation."
        onRetry={() => void appsStore.loadState(serverId, app.id)}
      >
        <ul class="m-0 flex list-none flex-col gap-2 p-0" data-testid="app-operations">
          {#each operations ?? [] as operation (operation.name)}
            {@const isOpen = openOperation === operation.name}
            <li class="flex min-w-0 flex-col gap-2 rounded-xl border border-border/50 px-3 py-2.5">
              <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <code class="min-w-0 truncate font-mono text-sm text-(--solus-text-primary)">{operation.name}</code>
                <span class="shrink-0 text-xs text-muted-foreground">{operation.kind === "query" ? "Query" : "Mutation"}</span>
                {#if operation.timeoutSeconds}
                  <span class="shrink-0 text-xs text-muted-foreground">at most {operation.timeoutSeconds} s</span>
                {/if}
                <span class="min-w-0 flex-1"></span>
                <Button size="xs" variant="outline" aria-expanded={isOpen} onclick={() => (openOperation = isOpen ? null : operation.name)}>
                  {isOpen ? "Close" : "Run…"}
                </Button>
              </div>
              {#if operation.description}
                <p class="m-0 text-xs text-muted-foreground text-pretty">{operation.description}</p>
              {/if}
              {#if hasSchema(operation.input)}
                <details class="min-w-0 text-xs">
                  <summary class="cursor-pointer text-muted-foreground">Input schema</summary>
                  <pre class="mt-1 mb-0 max-h-56 overflow-auto rounded-md bg-muted/50 p-2 font-mono whitespace-pre">{jsonText(operation.input)}</pre>
                </details>
              {/if}
              {#if hasSchema(operation.output)}
                <details class="min-w-0 text-xs">
                  <summary class="cursor-pointer text-muted-foreground">Output schema</summary>
                  <pre class="mt-1 mb-0 max-h-56 overflow-auto rounded-md bg-muted/50 p-2 font-mono whitespace-pre">{jsonText(operation.output)}</pre>
                </details>
              {/if}
              {#if isOpen}
                <OperationRunner {serverId} appId={app.id} {operation} {refusal} />
              {/if}
            </li>
          {/each}
        </ul>
      </ManageSectionState>
    {/if}
  </section>
</div>
