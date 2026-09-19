<script lang="ts">
  import { serversStore, sharesStore } from "../../contexts";
  import SeatsSettings from "../seats/SeatsSettings.svelte";
  import CloudConnectionsPointer from "../seats/CloudConnectionsPointer.svelte";
  import { cloudConnectionsPointerUrl } from "../seats/lib/cloud-connections";
  import GitHubConnect from "../connections/GitHubConnect.svelte";
  import CloudflareProviderSettings from "../cloudflare/CloudflareProviderSettings.svelte";
  import AtlassianProviderSettings from "../atlassian/AtlassianProviderSettings.svelte";
  import GoogleProviderSettings from "../google/GoogleProviderSettings.svelte";
  import SettingsSection from "./SettingsSection.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  // A member admitted through an organization keeps their GitHub, Google, and
  // Atlassian connections in Solus cloud, not on the runner; the row points there.
  const isCloudHost = $derived(serversStore.isCloudHost(serverId));
  $effect(() => {
    void sharesStore.identityFor(serverId).catch(() => {});
  });
  const cloudConnectionsUrl = $derived(
    cloudConnectionsPointerUrl({
      isCloudHost,
      identity: sharesStore.identities.get(serverId),
      directoryUrl: serversStore.servers.find((server) => server.id === serverId)?.uplink?.directoryUrl,
    }),
  );
</script>

<!-- Ordered by what the account is for: the member's own agent logins on a shared
     host first, then the code and issue providers, then the document providers,
     then the deployment target. -->
<SeatsSettings {serverId} />
{#if cloudConnectionsUrl}
  <SettingsSection label="Connections">
    <CloudConnectionsPointer
      url={cloudConnectionsUrl}
      label="Your GitHub, Google, and Atlassian connections live in Solus cloud"
      description="Every runner of your organization uses them for your own turns only."
      testId="connections-row-cloud"
    />
  </SettingsSection>
{:else}
  <GitHubConnect {serverId} />
  <AtlassianProviderSettings {serverId} />
  <GoogleProviderSettings {serverId} />
{/if}
{#if !isCloudHost}
  <CloudflareProviderSettings {serverId} />
{/if}
