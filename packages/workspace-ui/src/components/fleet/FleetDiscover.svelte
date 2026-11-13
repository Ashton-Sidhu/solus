<script lang="ts">
  import { RefreshCw } from "@lucide/svelte";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import { Button } from "../ui/button";
  import FoundMachineRow from "./FoundMachineRow.svelte";
  import { discoverStore } from "./discover.store.svelte";

  /** Discover (D7): what this device can see but has not added, each with its action. */
</script>

<SettingsSection
  label="Discover"
  description="Machines this device can see but has not added. Solus looks on your network, on Tailscale, on your Windows machines, and in your SSH config."
>
  {#snippet action()}
    <Button variant="ghost" size="sm" disabled={discoverStore.isScanning} onclick={() => void discoverStore.scan()}>
      <RefreshCw size={13} class={discoverStore.isScanning ? "animate-spin motion-reduce:animate-none" : ""} />
      {discoverStore.isScanning ? "Scanning…" : "Scan again"}
    </Button>
  {/snippet}
  {#each discoverStore.found as machine (machine.key)}
    <FoundMachineRow {machine} />
  {/each}
  <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
    <p class="text-[0.8125rem] text-(--solus-text-secondary)">
      {discoverStore.found.length ? "Not here?" : discoverStore.isScanning ? "Looking…" : "Nothing found yet."}
      Link any machine to your account with one command.
    </p>
    <Button variant="outline" size="sm" onclick={() => connectionsNav.openAdd("link")}>Link a machine</Button>
  </div>
</SettingsSection>
