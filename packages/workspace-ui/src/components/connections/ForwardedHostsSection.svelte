<script lang="ts">
  /** The machines this host reaches through an SSH forward it holds
   *  (docs/plans/host-routes.md D7, D9): the state of each forward, and Remove
   *  and Link with account. State lives in `forwardedHostsStore`. */
  import { Plus as PlusIcon } from "@lucide/svelte";
  import { hosts, serversStore, uplinkStore } from "../../contexts";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { addOverSshStore } from "../servers/add-over-ssh.store.svelte";
  import { forwardedReachNote, forwardedRowStatus } from "../servers/lib/add-over-ssh";
  import { forwardedHostsStore as store } from "./forwarded-hosts.store.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  $effect(() => store.watch(serverId));

  const forwarded = $derived(store.hostsFor(serverId));
  const holderName = $derived(serversStore.hostFor(serverId)?.label ?? "this host");
  const viewerHoldsForward = $derived(serverId === hosts.device?.id);

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
  <SettingsSection label="Machines reached over SSH">
    {#snippet action()}
      <Button
        variant="ghost"
        size="sm"
        class="-my-1 text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
        onclick={() => addOverSshStore.open(serverId)}
      >
        <PlusIcon size={13} />
        Add machine over SSH
      </Button>
    {/snippet}

    {#if forwarded.length === 0}
      <p class="px-4 py-6 text-center text-chrome-dense text-(--solus-text-tertiary)">
        {holderName} holds no SSH forwards.
      </p>
    {:else}
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
            {#if uplinkStore.canLink && !host.isLinked}
              <Button
                variant="outline"
                size="sm"
                class="shrink-0"
                disabled={!!store.busyInstallationId}
                onclick={() => void store.link(serverId, host.installationId)}
              >
                {isBusy && confirmingRemoveId !== host.installationId ? "Linking…" : "Link to my account"}
              </Button>
            {/if}
            {#if confirmingRemoveId !== host.installationId}
              <Button
                variant="ghost"
                size="sm"
                class="shrink-0 text-(--solus-text-tertiary) hover:text-(--solus-status-error)"
                disabled={!!store.busyInstallationId}
                onclick={() => askRemove(host.installationId)}
              >
                Remove
              </Button>
            {/if}
          </div>

          {#if confirmingRemoveId === host.installationId}
            <div class="flex flex-wrap items-center justify-end gap-3">
              {#if host.startedBySolus}
                <label class="mr-auto flex items-center gap-2 text-chrome-dense text-(--solus-text-secondary)">
                  <Switch bind:checked={stopRemote} size="sm" disabled={isBusy} aria-label="Also stop Solus there" />
                  Also stop Solus there
                </label>
              {/if}
              <Button variant="ghost" size="sm" disabled={isBusy} onclick={() => (confirmingRemoveId = null)}>Cancel</Button>
              <Button
                variant="destructive"
                size="sm"
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
    {/if}
  </SettingsSection>
{/if}
