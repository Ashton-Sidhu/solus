<script lang="ts">
  /** The machines this host reaches through a forward it holds, over SSH or
   *  into one of its WSL distros (docs/plans/host-routes.md D7, D9;
   *  docs/plans/windows.md §13.6), as rows of the host's pairing card: the
   *  state of each forward, and Remove and Link with account, and the password
   *  of a forward that waits for one. State lives in `forwardedHostsStore`; the
   *  host page watches it, because the card shows only once the forwards are read. */
  import { Plus as PlusIcon } from "@lucide/svelte";
  import { hosts, serversStore, uplinkStore } from "../../contexts";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { addOverSshStore } from "../servers/add-over-ssh.store.svelte";
  import { isWindowsHost } from "../servers/add-wsl-distro.store.svelte";
  import WslDistroRows from "../servers/WslDistroRows.svelte";
  import { forwardedReachNote, forwardedRowStatus } from "../servers/lib/add-over-ssh";
  import ForwardedHostUnlock from "./ForwardedHostUnlock.svelte";
  import { forwardedHostsStore as store } from "./forwarded-hosts.store.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const forwarded = $derived(store.hostsFor(serverId));
  const holderName = $derived(serversStore.hostFor(serverId)?.label ?? "this host");
  const viewerHoldsForward = $derived(serverId === hosts.device?.id);
  const holderRunsWindows = $derived(isWindowsHost(serverId));

  /** The row whose Remove waits on a confirm, and whether it also stops Solus there. Ephemeral. */
  let confirmingRemoveId = $state<string | null>(null);
  let stopRemote = $state(true);

  function askRemove(installationId: string) {
    confirmingRemoveId = installationId;
    stopRemote = true;
  }

  async function confirmRemove(installationId: string, startedBySolus: boolean) {
    if (await store.remove(serverId, installationId, startedBySolus && stopRemote)) confirmingRemoveId = null;
  }
</script>

{#if forwarded}
  <SettingsRow
    label={holderRunsWindows ? "Machines reached over SSH or WSL" : "Machines reached over SSH"}
    description={forwarded.length === 0
      ? `${holderName} holds no forwards. Add a machine to reach it through a forward that ${holderName} holds.`
      : `Machines that ${holderName} reaches through a forward it holds.`}
  >
    {#snippet control()}
      <Button variant="outline" size="sm" class="pointer-coarse:min-h-11" onclick={() => addOverSshStore.open(serverId)}>
        <PlusIcon size={14} />
        Add machine over SSH
      </Button>
    {/snippet}
  </SettingsRow>

  {#each forwarded as host (host.installationId)}
    {@const status = forwardedRowStatus(host)}
    {@const reachNote = forwardedReachNote(host, viewerHoldsForward, holderName)}
    {@const isBusy = store.busyInstallationId === host.installationId}
    {@const actionError = store.errorByInstallation.get(host.installationId)}
    <div class="flex flex-col gap-2 px-4 py-3">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <p class="truncate text-workspace-chrome font-medium text-(--solus-text-primary)">{host.label}</p>
          <p class="mt-0.5 truncate text-chrome-dense text-(--solus-text-tertiary)">
            {host.sshTarget}{reachNote ? ` · ${reachNote}` : ""}
          </p>
          <p
            class="mt-0.5 text-pretty text-chrome-dense {status.tone === 'error'
              ? 'text-destructive'
              : status.tone === 'ok'
                ? 'text-(--solus-text-secondary)'
                : 'text-(--solus-text-tertiary)'}"
          >
            {status.text}
          </p>
        </div>
        <!-- A link runs over SSH too: a forward that waits for its password cannot link yet. -->
        {#if uplinkStore.canLink && !host.isLinked && host.state !== "needs-auth"}
          <Button
            variant="outline"
            size="sm"
            class="shrink-0 pointer-coarse:min-h-11"
            disabled={!!store.busyInstallationId}
            onclick={() => void store.link(serverId, host.installationId)}
          >
            {isBusy && confirmingRemoveId !== host.installationId ? "Linking…" : "Link to my account"}
          </Button>
        {/if}
        {#if confirmingRemoveId !== host.installationId}
          <Button
            variant="destructive"
            size="sm"
            class="shrink-0 pointer-coarse:min-h-11"
            disabled={!!store.busyInstallationId}
            onclick={() => askRemove(host.installationId)}
          >
            Remove
          </Button>
        {/if}
      </div>

      {#if host.state === "needs-auth"}
        <ForwardedHostUnlock {serverId} installationId={host.installationId} sshTarget={host.sshTarget} {holderName} />
      {/if}

      {#if confirmingRemoveId === host.installationId}
        <div class="flex flex-wrap items-center justify-end gap-2">
          {#if host.startedBySolus}
            <label class="mr-auto flex items-center gap-2 text-chrome-dense text-(--solus-text-secondary)">
              <Switch bind:checked={stopRemote} size="sm" disabled={isBusy} aria-label="Also stop Solus there" />
              Also stop Solus there
            </label>
          {/if}
          <Button variant="ghost" size="sm" class="text-muted-foreground pointer-coarse:min-h-11" disabled={isBusy} onclick={() => (confirmingRemoveId = null)}>Cancel</Button>
          <Button
            variant="destructive"
            size="sm"
            class="pointer-coarse:min-h-11"
            disabled={isBusy}
            onclick={() => void confirmRemove(host.installationId, host.startedBySolus)}
          >
            {isBusy ? "Removing…" : "Remove"}
          </Button>
        </div>
      {/if}

      {#if actionError}
        <p class="cursor-text select-text text-pretty text-chrome-dense text-destructive" role="alert">{actionError}</p>
      {/if}
    </div>
  {/each}
  {#if holderRunsWindows}
    <!-- The host's own page says why it offers no distro: no WSL, no distro, or WSL did not answer. -->
    <WslDistroRows hostId={serverId} reportsUnavailable />
  {/if}
{/if}
