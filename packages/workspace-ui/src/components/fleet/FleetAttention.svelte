<script lang="ts">
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { Button } from "../ui/button";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { fleetStore } from "./fleet.store.svelte";
  import { attentionRows, type AttentionRow, type FleetMachine } from "./lib/fleet-model";

  /** What wants the person (D4): a host that is down, an agent to sign in, an update. */
  interface Props {
    machines: FleetMachine[];
    onOpen: (serverId: string) => void;
  }

  let { machines, onOpen }: Props = $props();

  const rows = $derived(attentionRows(machines));

  function act(row: AttentionRow) {
    if (row.kind === "unreachable") fleetStore.retryHosts(row.serverIds);
    else if (row.kind === "update") fleetStore.updateHosts(row.serverIds);
    else onOpen(row.serverIds[0]!);
  }
</script>

<SettingsSection label="Needs attention" visible={rows.length > 0}>
  {#each rows as row (row.kind + row.serverIds[0])}
    <div class="flex items-center gap-3 px-4 py-3">
      <span class="flex w-4 shrink-0 justify-center"><HostStateIcon state={row.kind} size={14} /></span>
      <button type="button" class="min-w-0 flex-1 truncate text-left text-workspace-chrome hover:underline" onclick={() => onOpen(row.serverIds[0]!)}>
        <span class="font-medium">{row.title}</span><span class="text-muted-foreground"> — {row.note}</span>
      </button>
      <Button variant="ghost" size="sm" onclick={() => act(row)}>
        {row.kind === "unreachable" ? (row.serverIds.length > 1 ? "Retry all" : "Retry")
          : row.kind === "update" ? (row.serverIds.length > 1 ? "Update all" : "Update")
            : row.kind === "signin" ? "Sign in" : "Diagnose"}
      </Button>
    </div>
  {/each}
</SettingsSection>
