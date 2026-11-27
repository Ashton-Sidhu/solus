<script lang="ts">
  /** Settings → Sharing & access, as in T3 Code: for the host chosen in the
   *  page's host picker, the outside apps that use Solus as the person
   *  (plans/035 §10), where those apps reach the host, the devices that use it,
   *  and then how the host is reached. The host page has no copy of it. Its
   *  Solus Cloud link is on Settings → Solus Cloud. */
  import { untrack } from "svelte";
  import { connectionsStore } from "../../contexts";
  import { hosts } from "../../contexts/hosts/hosts.svelte";
  import { sharingAccessRights } from "./lib/sharing-access";
  import OutsideAppsDirectory from "./outside-apps/OutsideAppsDirectory.svelte";
  import HostDetailAccess from "./HostDetailAccess.svelte";
  import SharingDevices from "./SharingDevices.svelte";

  let { serverId }: { serverId: string } = $props();

  const rights = $derived(sharingAccessRights(connectionsStore.serverInfo, (permission) => !!hosts.get(serverId)?.me.may(permission)));

  $effect(() => {
    const targetServerId = serverId;
    return untrack(() => connectionsStore.watchServerMetadata(targetServerId));
  });
</script>

{#if rights.showsOutsideApps}
  <OutsideAppsDirectory {serverId} readsGrants={rights.showsPairedDevices} />
{/if}
<SharingDevices {serverId} showsPairCode={rights.showsPairCode} showsApprovals={rights.showsApprovals} showsPairedDevices={rights.showsPairedDevices} />
<HostDetailAccess {serverId} hasPairing={rights.hasPairing} canChangeNetwork={rights.canChangeNetwork} />
