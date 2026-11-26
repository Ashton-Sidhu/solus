<script lang="ts">
  /** Settings → Sharing & access, as in T3 Code: the Access tab of one host,
   *  for the host chosen in the page's host picker. It is the same content as
   *  Settings → Hosts → the host → Access, so the two never differ. */
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
