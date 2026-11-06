<script lang="ts">
  /** The password field of a forward in `needs-auth` (docs/plans/ssh-forward-password.md).
   *  The host keeps the password in memory; here it leaves the draft when it is sent. */
  import { serverConnections } from "@solus/client-core/server-connections";
  import { unencryptedPasswordMessage } from "@solus/client-core/ssh-password";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { forwardedHostsStore as store } from "./forwarded-hosts.store.svelte";

  interface Props {
    serverId: string;
    installationId: string;
    sshTarget: string;
    holderName: string;
  }

  let { serverId, installationId, sshTarget, holderName }: Props = $props();

  let password = $state("");
  const isBusy = $derived(store.busyInstallationId === installationId);
  const isEncrypted = $derived(serverConnections.hasEncryptedConnection(serverId));

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const authSecret = password;
    if (!authSecret) return;
    password = "";
    void store.unlock(serverId, installationId, authSecret, holderName);
  }
</script>

{#if isEncrypted}
  <form class="flex flex-col gap-1" onsubmit={submit}>
    <div class="flex items-center gap-2">
      <Input
        bind:value={password}
        type="password"
        autocomplete="current-password"
        aria-label="Password or key passphrase for {sshTarget}"
        placeholder="Password or key passphrase"
        dictation={false}
        disabled={isBusy}
      />
      <Button type="submit" variant="outline" size="sm" class="shrink-0" disabled={isBusy || !password}>
        {isBusy ? "Connecting…" : "Connect"}
      </Button>
    </div>
    <span class="text-pretty text-chrome-dense text-(--solus-text-tertiary)">
      Kept in memory on {holderName} until it restarts. Never stored on disk.
    </span>
  </form>
{:else}
  <p class="text-pretty text-chrome-dense text-(--solus-text-tertiary)">{unencryptedPasswordMessage(holderName)}</p>
{/if}
