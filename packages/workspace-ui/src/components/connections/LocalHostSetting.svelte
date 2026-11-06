<script lang="ts">
  import { tick } from "svelte";
  import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
  import { isSessionBusyStatus } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import { localHostStore } from "../../contexts/connections/local-host.store.svelte";
  import { runHost } from "../../contexts/workspace/run-location";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";

  /** Turns this computer's host on or off (docs/plans/desktop-remote-only.md).
   *  Only the desktop app has one. */
  const session = getWorkspaceContext();

  let isConfirmingOff = $state(false);
  let switchEl = $state<HTMLButtonElement | null>(null);

  const isHostOn = $derived(!localHostStore.isOff);
  const busySessionCount = $derived(
    Object.values(session.sessions.byId).filter(
      (item) => runHost(item.run) === LOCAL_SERVER_ID && isSessionBusyStatus(item.status),
    ).length,
  );

  function requestChange(isOn: boolean) {
    if (isOn) void localHostStore.setEnabled(true);
    else isConfirmingOff = true;
  }

  async function cancel() {
    isConfirmingOff = false;
    await tick();
    switchEl?.focus();
  }
</script>

<SettingsSection label="This computer">
  <SettingsRow
    label="Local host"
    description={isHostOn
      ? "Agents run on this computer, and other devices can connect to it."
      : "Off. Solus connects only to your saved hosts. Your local data is kept."}
    bodyVisible={isConfirmingOff}
  >
    {#snippet control()}
      <Switch
        bind:ref={switchEl}
        bind:checked={() => isHostOn && !isConfirmingOff, requestChange}
        disabled={localHostStore.isSwitching}
        aria-label="Local host"
      />
    {/snippet}
    {#snippet body()}
      <div class="flex flex-col gap-2">
        <p class="text-pretty text-chrome-dense text-(--solus-text-secondary)">
          Solus restarts with no local host. Agents and automations on this computer stop, and other devices
          cannot connect to it. Your local data is kept, and you can turn it on again here.
          {#if busySessionCount > 0}
            {busySessionCount === 1 ? "1 session is running here now." : `${busySessionCount} sessions are running here now.`}
          {/if}
        </p>
        <div class="flex flex-wrap gap-2">
          <Button
            variant="destructive"
            size="sm"
            disabled={localHostStore.isSwitching}
            onclick={() => void localHostStore.setEnabled(false)}
          >
            {localHostStore.isSwitching ? "Restarting…" : "Turn off and restart"}
          </Button>
          <Button variant="outline" size="sm" disabled={localHostStore.isSwitching} onclick={cancel}>Cancel</Button>
        </div>
      </div>
    {/snippet}
  </SettingsRow>
</SettingsSection>
