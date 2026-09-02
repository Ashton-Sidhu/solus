<script lang="ts">
  /** Who else can reach this host. Only rendered for the host this client is
   *  actually connected to — `connectionsStore` describes that server and no
   *  other, so on any other host these devices would be listed under the
   *  wrong name. */
  import { Monitor as MonitorIcon, Trash2 as TrashIcon } from "@lucide/svelte";
  import { connectionsStore } from "../../contexts";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import PairCodePanel from "./PairCodePanel.svelte";
  import UplinkSection from "./UplinkSection.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const connections = connectionsStore;
</script>

<UplinkSection {serverId} />

<SettingsSection label="Pairing">
  <PairCodePanel {serverId} />
  <SettingsRow
    label="Approve new devices"
    description="Ask before a paired device is allowed to connect."
    comingSoon
  >
    {#snippet control()}
      <Switch checked={false} size="default" aria-label="Approve new devices" />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection label="Devices with access">
  {#if connections.sessions.length === 0}
    <p class="px-4 py-6 text-center text-[0.875em] text-(--solus-text-tertiary) [.is-laptop-display_&]:py-5">
      No devices are connected to this host.
    </p>
  {:else}
    {#each connections.sessions as session (session.id)}
      <div
        class="group flex items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0 [.is-laptop-display_&]:gap-2.5 [.is-laptop-display_&]:px-3.5 [.is-laptop-display_&]:py-2"
      >
        <div
          class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) [.is-laptop-display_&]:size-7 [.is-laptop-display_&]:rounded-md"
        >
          <MonitorIcon size={14} class="text-(--solus-text-tertiary)" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-workspace-chrome font-medium text-(--solus-text-primary)">
            {session.deviceLabel}
          </p>
          <p class="text-[0.875em] text-(--solus-text-tertiary)">
            {relativeTime(session.connectedAt)}
            {#if session.connectionCount > 1}
              &middot; {session.connectionCount} connections
            {/if}
          </p>
        </div>
        {#if session.deviceId}
          <Button
            variant="ghost"
            size="sm"
            onclick={() => void connections.revokeDevice(serverId, session.deviceId!)}
            class="text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-(--solus-status-error)"
          >
            <TrashIcon size={13} />
            Revoke
          </Button>
        {/if}
      </div>
    {/each}
  {/if}
</SettingsSection>
