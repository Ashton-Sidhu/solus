<script lang="ts">
  import { hostDiagnosticRows } from "@solus/client-core/host-diagnostics";
  import { diagnoseHostConnection, hostDiagnosticsText } from "@solus/client-core/host-connection-diagnosis";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import HostConnectionStages from "../connections/HostConnectionStages.svelte";
  import { copyText } from "../../lib/toasts";
  import { Button } from "../ui/button";

  /** A failed host's details. Its own chunk: most launches never open it. */
  interface Props {
    serverId: string;
    now: number;
    onOpenHostSettings: () => void;
  }

  let { serverId, now, onOpenHostSettings }: Props = $props();

  const rows = $derived(hostDiagnosticRows(serversStore.diagnosticsFor(serverId), now));
  const diagnosis = $derived(diagnoseHostConnection(serversStore.diagnosticsFor(serverId)));

  let copied = $state(false);
  async function copyDetails() {
    await copyText(hostDiagnosticsText(serversStore.diagnosticsFor(serverId)));
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<div id="host-details-{serverId}" class="mt-4 flex w-full flex-col gap-3 text-left">
  {#if diagnosis}
    <p class="text-workspace-chrome font-medium text-(--solus-text-primary)">
      {diagnosis.isChecking && !diagnosis.checkedAt ? "Checking the connection…" : diagnosis.headline}
    </p>
    <HostConnectionStages stages={diagnosis.stages} />
    {#if diagnosis.steps.length > 0}
      <ol class="list-decimal pl-5 text-chrome-dense text-(--solus-text-secondary) select-text">
        {#each diagnosis.steps as step (step)}
          <li>{step}</li>
        {/each}
      </ol>
    {/if}
  {/if}
  <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-chrome-dense">
    {#each rows as row (row.label)}
      <dt class="font-medium text-(--solus-text-primary)">{row.label}</dt>
      <dd class="min-w-0 break-words text-(--solus-text-secondary) select-text" class:font-mono={row.isCode}>{row.value}</dd>
    {/each}
  </dl>
  <div class="flex justify-center gap-1">
    <Button
      variant="ghost"
      size="sm"
      class="text-(--solus-text-secondary)"
      disabled={diagnosis?.isChecking}
      onclick={() => serversStore.checkConnection(serverId)}
    >
      {diagnosis?.isChecking ? "Checking…" : "Check again"}
    </Button>
    <Button variant="ghost" size="sm" class="text-(--solus-text-secondary)" onclick={copyDetails}>{copied ? "Copied" : "Copy details"}</Button>
    <Button variant="ghost" size="sm" class="text-(--solus-text-secondary)" onclick={onOpenHostSettings}>Host settings</Button>
  </div>
</div>
