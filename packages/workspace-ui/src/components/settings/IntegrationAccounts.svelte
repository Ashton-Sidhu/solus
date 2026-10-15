<script lang="ts">
  import { untrack } from "svelte";
  import { serversStore, sharesStore, accountStore } from "../../contexts";
  import AccountConnectionRow from "../seats/AccountConnectionRow.svelte";
  import { accountVaultStore } from "../seats/account-vault.store.svelte";
  import { cloudConnectionsPointerUrl } from "../seats/lib/cloud-connections";
  import AtlassianProviderSettings from "../atlassian/AtlassianProviderSettings.svelte";
  import GoogleProviderSettings from "../google/GoogleProviderSettings.svelte";
  import SettingsSection from "./SettingsSection.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  // A signed-in person keeps their Google and Atlassian connections in their
  // Solus account, not on the host; each row shows the account's status and
  // points there. GitHub is on the Source Control page.
  $effect(() => {
    void accountStore.state;
    const targetServerId = serverId;
    untrack(() => {
      void sharesStore.identityFor(targetServerId, true).catch(() => {});
      void accountVaultStore.load();
    });
  });
  $effect(() => accountVaultStore.watch());
  const cloudConnectionsUrl = $derived(
    cloudConnectionsPointerUrl({
      identity: sharesStore.identities.get(serverId),
      directoryUrl: serversStore.servers.find((server) => server.id === serverId)?.uplink?.directoryUrl,
    }),
  );
</script>

<!-- The Integrations page: the accounts Solus acts on your behalf with. -->
{#if cloudConnectionsUrl}
  <SettingsSection label="Connections">
    <AccountConnectionRow
      url={cloudConnectionsUrl}
      label="Google"
      status={accountVaultStore.providerStatus("google")}
      testId="connections-row-google-account"
    />
    <AccountConnectionRow
      url={cloudConnectionsUrl}
      label="Atlassian"
      status={accountVaultStore.providerStatus("atlassian")}
      testId="connections-row-atlassian-account"
    />
  </SettingsSection>
{:else}
  <AtlassianProviderSettings {serverId} />
  <GoogleProviderSettings {serverId} />
{/if}
