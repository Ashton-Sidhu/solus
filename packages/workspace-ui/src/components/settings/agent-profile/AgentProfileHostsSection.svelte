<script lang="ts">
  /**
   * Settings → Account & sync → Hosts: every connected host the profile applies
   * to — the person's seats on a shared host, or the homes of a host they own —
   * with what each one holds.
   */
  import { serverConnections } from "@solus/client-core/server-connections";
  import { accountSyncStore, agentProfileStore, serversStore } from "../../../contexts";
  import SettingsSection from "../SettingsSection.svelte";
  import AgentProfileHostRow from "./AgentProfileHostRow.svelte";
  import { isSyncOn } from "../../../contexts/account/account-sync.store.svelte";

  const hostRows = $derived.by(() => {
    void serversStore.servers;
    const rows: Array<{ serverId: string; label: string }> = [];
    for (const [serverId, applies] of agentProfileStore.applies) {
      if (!applies) continue;
      rows.push({
        serverId,
        label: serversStore.hostFor(serverId)?.label ?? serverConnections.connectionFor(serverId)?.target.label ?? serverId,
      });
    }
    return rows;
  });
</script>

<SettingsSection
  label="Hosts"
  description={isSyncOn(accountSyncStore.profile.state)
    ? "Each host pulls the profile from your account, and again after you change it here."
    : agentProfileStore.canCopy
      ? "Solus on this computer copies the profile to each host. A file a host already had is kept."
      : "What each host holds. Sign in to Solus to sync, or copy from the computer you work on."}
>
  {#if hostRows.length === 0}
    <p class="p-8 text-center text-workspace-chrome text-muted-foreground">No host holds your profile yet. It applies to your seats on a shared host, and to a host you own.</p>
  {/if}
  {#each hostRows as host (host.serverId)}
    <AgentProfileHostRow serverId={host.serverId} label={host.label} syncOn={isSyncOn(accountSyncStore.profile.state)} />
  {/each}
</SettingsSection>
