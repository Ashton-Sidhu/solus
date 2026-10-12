<script lang="ts">
  import { untrack } from "svelte";
  import { serversStore, sharesStore, accountStore } from "../../contexts";
  import SeatsSettings from "../seats/SeatsSettings.svelte";
  import CloudConnectionsPointer from "../seats/CloudConnectionsPointer.svelte";
  import { cloudConnectionsPointerUrl } from "../seats/lib/cloud-connections";
  import CloudflareProviderSettings from "../cloudflare/CloudflareProviderSettings.svelte";
  import AtlassianProviderSettings from "../atlassian/AtlassianProviderSettings.svelte";
  import GoogleProviderSettings from "../google/GoogleProviderSettings.svelte";
  import SettingsSection from "./SettingsSection.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  // A member admitted through an organization keeps their Google and Atlassian
  // connections in Solus cloud, not on the runner; the row points there.
  // GitHub is on the Source Control page.
  $effect(() => {
    void accountStore.state;
    const targetServerId = serverId;
    untrack(() => void sharesStore.identityFor(targetServerId, true).catch(() => {}));
  });
  const cloudConnectionsUrl = $derived(
    cloudConnectionsPointerUrl({
      identity: sharesStore.identities.get(serverId),
      directoryUrl: serversStore.servers.find((server) => server.id === serverId)?.uplink?.directoryUrl,
    }),
  );
</script>

<!-- Ordered by what the account is for: the member's own agent logins on a shared
     host first, then the issue and document providers, then the deployment
     target. -->
<SeatsSettings {serverId} />
{#if cloudConnectionsUrl}
  <SettingsSection label="Connections">
    <CloudConnectionsPointer
      url={cloudConnectionsUrl}
      label="Your Google and Atlassian connections live in Solus cloud"
      description="Solus uses your own accounts for integration actions."
      testId="connections-row-cloud"
    />
  </SettingsSection>
{:else}
  <AtlassianProviderSettings {serverId} />
  <GoogleProviderSettings {serverId} />
{/if}
<CloudflareProviderSettings {serverId} />
