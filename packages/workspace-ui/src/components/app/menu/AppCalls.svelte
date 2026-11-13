<script lang="ts">
  import { untrack } from "svelte";
  import type { AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import AppSectionState from "./AppSectionState.svelte";
  import { appTime, callOutcomeLabel, callerText } from "../lib/app-view";

  /** The call log: the operation, who called it, when, and how it ended. Never an input or a result. */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  // A mutation that changed the data is a new row, so the log reads again with the data.
  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    void appsStore.dataVersion(hostId, appId);
    untrack(() => {
      void appsStore.calls.load(hostId, appId);
      // A webhook caller goes by its declared name.
      if (!appsStore.webhooks.get(hostId, appId)) void appsStore.webhooks.load(hostId, appId);
    });
  });
  const calls = $derived(appsStore.calls.get(serverId, app.id));
  const webhooks = $derived(appsStore.webhooks.get(serverId, app.id) ?? []);
</script>

<AppSectionState
  count={calls?.length}
  error={appsStore.calls.errorFor(serverId, app.id)}
  empty="No operation of this app ran yet."
  onRetry={() => void appsStore.calls.load(serverId, app.id)}
>
  <ul class="m-0 flex list-none flex-col p-0" data-testid="app-calls">
    {#each calls ?? [] as call (call.id)}
      <li class="flex min-w-0 flex-col gap-0.5 border-b border-border/40 py-1.5 last:border-b-0">
        <div class="flex min-w-0 items-baseline gap-2">
          <code class="min-w-0 shrink truncate font-mono text-xs text-(--solus-text-primary)">{call.operation}</code>
          <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{callerText(call.caller, webhooks)} · v{call.version}</span>
          <span class="shrink-0 text-xs {call.outcome === 'failed' ? 'text-destructive' : 'text-muted-foreground'}">{callOutcomeLabel(call.outcome)}</span>
          <span class="shrink-0 text-xs tabular-nums text-muted-foreground" title={new Date(call.startedAt).toLocaleString()}>{appTime(call.startedAt)}</span>
        </div>
        {#if call.error}
          <p class="m-0 text-xs text-destructive text-pretty">{call.error}</p>
        {/if}
      </li>
    {/each}
  </ul>
</AppSectionState>
