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
  <!-- The ladder, in the sidebar list's container: the mark holds at every
       width, the name joins it from 20rem up. It leaves before the status
       word does (18rem), because below that the title needs the room more
       than the host does; the title attribute still names it. Hidden, never
       unmounted, so a resize costs no remount. -->
  <span class="min-w-0 truncate @max-[20rem]:hidden">{label}</span>
</span>
