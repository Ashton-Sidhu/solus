<script lang="ts">
  import { Laptop as LaptopIcon } from "@lucide/svelte";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import { hostIsManaged } from "../servers/lib/managed-host";

  let { serverId, lastRun = false }: { serverId?: string | null; lastRun?: boolean } = $props();
  const host = $derived(serversStore.hostFor(serverId));
  const label = $derived(host?.local || !host ? "Local" : host.label);
</script>

<span class="flex min-w-0 max-w-[45%] items-center gap-1 text-chrome-dense text-muted-foreground" title={lastRun ? `Last ran on ${label}` : label}>
  {#if host && !host.local}
    <HostOperatingSystemIcon os={"os" in host ? host.os : undefined} managed={hostIsManaged(host)} size={12} class="size-3 shrink-0" />
  {:else}
    <LaptopIcon size={12} class="size-3 shrink-0" />
  {/if}
  <span class="min-w-0 truncate">{label}</span>
</span>
