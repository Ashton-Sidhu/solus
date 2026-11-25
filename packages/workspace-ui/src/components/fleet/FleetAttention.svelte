<script lang="ts">
  import { Bot } from "@lucide/svelte";
  import { HOST_READINESS_ACTION_LABELS } from "@solus/client-core/host-readiness";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { Button } from "../ui/button";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { fleetStore } from "./fleet.store.svelte";
  import { attentionRows, type AttentionRow, type FleetMachine } from "./lib/fleet-model";

  /** What wants the person: a host that is down, an agent to sign in, an update.
   *  Each row has its own fix, and a session about its hosts. */
  interface Props {
    machines: FleetMachine[];
    onOpen: (serverId: string) => void;
    onAsk: (row: AttentionRow) => void;
    /** Pairs this device with a host that refuses it again. */
    onPairAgain: (serverId: string) => void;
  }

  let { machines, onOpen, onAsk, onPairAgain }: Props = $props();

  const rows = $derived(attentionRows(machines));

  function act(row: AttentionRow) {
    if (row.fix === "pair-again") onPairAgain(row.serverIds[0]!);
    else if (row.fix === "start") fleetStore.startHosts(row.serverIds);
    else if (row.kind === "unreachable") fleetStore.retryHosts(row.serverIds);
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
      <!-- No button fixes a connection that drops again and again: the session is its fix. -->
      {#if row.kind !== "reconnecting"}
        <Button variant="ghost" size="sm" onclick={() => act(row)}>
          {row.fix && row.fix !== "retry" ? HOST_READINESS_ACTION_LABELS[row.fix]
            : row.kind === "unreachable" ? (row.serverIds.length > 1 ? "Retry all" : "Retry")
            : row.kind === "update" ? (row.serverIds.length > 1 ? "Update all" : "Update")
              : "Sign in"}
        </Button>
      {/if}
      <Button variant="ghost" size="sm" onclick={() => onAsk(row)}><Bot size={14} />Ask an agent</Button>
    </div>
  {/each}
</SettingsSection>
