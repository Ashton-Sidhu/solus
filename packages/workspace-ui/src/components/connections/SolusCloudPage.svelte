<script lang="ts">
  /** Settings → Solus Cloud: the host chosen in the page's host picker and Solus
   *  Cloud — its registration, its link to the internet, and where it stands in
   *  each organization. The nav shows the page only to a signed-in person; a link
   *  that opens it signed out sends the person to Account & sync to sign in. */
  import UplinkSection from "./UplinkSection.svelte";
  import OrganizationsSection from "./OrganizationsSection.svelte";

  let { serverId }: { serverId: string } = $props();
</script>

<UplinkSection {serverId} />

<!-- Where this host stands in each organization, and its Insights choice
     (organization-scope §6.1). The page is keyed by host, so another host is read afresh. -->
<OrganizationsSection {serverId} />
