<script lang="ts">
  /** The hosts this host paired with, so its agents can start sessions there
   *  without a Solus account (docs/plans/cross-host-sessions.md §10). Pairing
   *  takes the other host's address and the code it shows under Pair a device.
   *  Forget removes the token here; the other host still lists this one under
   *  its devices until it is revoked there. */
  import { untrack } from "svelte";
  import { Server as ServerIcon, Trash2 as TrashIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import { pairedHostsStore as store } from "./paired-hosts.store.svelte";

  let { serverId }: { serverId: string } = $props();

  const paired = $derived(store.states.get(serverId));
  let address = $state("");
  let code = $state("");
  let addressInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    const hostId = serverId;
    untrack(() => void store.load(hostId));
  });

  async function pair(event: SubmitEvent) {
    event.preventDefault();
    if (!address.trim() || !code.trim() || paired?.pairing) return;
    if (await store.pair(serverId, address.trim(), code.trim())) {
      address = "";
      code = "";
      addressInput?.focus();
    }
  }
</script>

<SettingsSection
  label="Paired hosts"
  description="Agents on this host can start sessions on these hosts. On the other host, open Pair a device and enter its address and code here."
>
  {#if paired?.loaded && paired.hosts.length === 0}
    <p class="px-4 py-6 text-center text-[0.875em] text-(--solus-text-tertiary)">
      This host is not paired with another host.
    </p>
  {/if}
  {#each paired?.hosts ?? [] as host (host.installationId)}
    <div class="group flex items-center gap-3 px-4 py-2.5">
      <div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover)">
        <ServerIcon size={14} class="text-(--solus-text-tertiary)" />
      </div>
      <div class="min-w-0 flex-1">
        <p class="truncate text-workspace-chrome font-medium text-(--solus-text-primary)">{host.label}</p>
        <p class="truncate text-[0.875em] text-(--solus-text-tertiary)">
          {host.url} &middot; paired {relativeTime(host.pairedAt)}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onclick={() => void store.forget(serverId, host.installationId)}
        class="text-(--solus-text-tertiary) opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-(--solus-status-error)"
      >
        <TrashIcon size={13} />
        Forget
      </Button>
    </div>
  {/each}
  <form class="flex flex-wrap items-center gap-2 px-4 py-3" onsubmit={pair}>
    <Input
      bind:ref={addressInput}
      bind:value={address}
      placeholder="Address, for example http://100.64.0.2:7777"
      aria-label="Address of the host to pair with"
      autocomplete="off"
      class="min-w-48 flex-1"
    />
    <Input
      bind:value={code}
      placeholder="Code"
      aria-label="Pairing code from the other host"
      inputmode="numeric"
      autocomplete="one-time-code"
      class="w-28 tabular-nums"
    />
    <Button type="submit" size="sm" disabled={!address.trim() || !code.trim() || paired?.pairing}>
      {paired?.pairing ? "Pairing…" : "Pair"}
    </Button>
  </form>
  {#if paired?.error}
    <p role="alert" class="px-4 pb-3 text-[0.875em] text-(--solus-status-error)">{paired.error}</p>
  {/if}
</SettingsSection>
