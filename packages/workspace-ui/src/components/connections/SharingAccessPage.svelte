<script lang="ts">
  /** Settings → Sharing & access, as in T3 Code: the access of one host (its
   *  outside apps, paired devices, and pair codes), for the host chosen in the
   *  page's host picker. The host page has no copy of it. */
  import { untrack } from "svelte";
  import { connectionsStore } from "../../contexts";
  import HostDetailAccess from "./HostDetailAccess.svelte";

  let { serverId }: { serverId: string } = $props();

  $effect(() => {
    const targetServerId = serverId;
    return untrack(() => connectionsStore.watchServerMetadata(targetServerId));
  });
</script>

<HostDetailAccess {serverId} />
