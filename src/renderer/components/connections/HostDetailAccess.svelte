<script lang="ts">
  /** Who else can reach this host. Only rendered for the host this client is
   *  actually connected to — `connectionsStore` describes that server and no
   *  other, so on any other host these devices would be listed under the
   *  wrong name. */
  import { MonitorIcon, TrashIcon } from "phosphor-svelte";
  import { connectionsStore } from "../../contexts";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import PairCodePanel from "./PairCodePanel.svelte";

  const connections = connectionsStore;
</script>

<SettingsSection label="Pairing">
  <PairCodePanel />
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
    <p class="px-4 py-6 text-center text-[0.75rem] text-(--solus-text-tertiary)">
      No devices are connected to this host.
    </p>
  {:else}
    {#each connections.sessions as session (session.id)}
      <div
        class="group flex items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0"
      >
        <div
          class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover)"
        >
          <MonitorIcon size={14} class="text-(--solus-text-tertiary)" />
        </div>
        <div class="min-w-0 flex-1">
          <p class="truncate text-[0.8125rem] font-medium text-(--solus-text-primary)">
            {session.deviceLabel}
          </p>
          <p class="text-[0.6875rem] text-(--solus-text-tertiary)">
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
            onclick={() => void connections.revokeDevice(session.deviceId!)}
            class="text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-(--solus-status-error)"
          >
            <TrashIcon size={13} />
            Revoke
          </Button>
        {/if}
      </div>
    {/each}
  {/if}
</SettingsSection>
