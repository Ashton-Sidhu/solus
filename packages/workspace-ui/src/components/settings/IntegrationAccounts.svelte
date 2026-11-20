<script lang="ts">
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { untrack } from "svelte";
  import Icon from "@iconify/svelte";
  import { serversStore, sharesStore, accountStore } from "../../contexts";
  import AccountConnectionRow from "../seats/AccountConnectionRow.svelte";
  import { accountVaultStore } from "../seats/account-vault.store.svelte";
  import { cloudConnectionsPointerUrl } from "../seats/lib/cloud-connections";
  import AtlassianProviderSettings from "../atlassian/AtlassianProviderSettings.svelte";
  import GoogleProviderSettings from "../google/GoogleProviderSettings.svelte";
  import GitHubConnect from "../connections/GitHubConnect.svelte";
  import LinearConnection from "./LinearConnection.svelte";
  import { ensureIconCollections } from "../../lib/iconify";
  import SettingsSection from "./SettingsSection.svelte";
  import { PROVIDER_LOGOS } from "./lib/provider-logos";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  ensureIconCollections();

  // A signed-in person keeps their GitHub, Google, and Atlassian connections in
  // their Solus account, not on the host; each row shows the account's status
  // and points there. GitHub is on the Source Control page too.
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

<!-- The Integrations page: the accounts Solus acts on your behalf with, in one card. -->
<SettingsSection
  {...settingsDefinitions["integrations.section-connections"]}
  description={cloudConnectionsUrl
    ? "These live in your Solus account, so every host you work on can use them."
    : "These connect on this host. Sign in to Solus to keep them in your account for every host."}
>
  {#if cloudConnectionsUrl}
    <AccountConnectionRow
      url={cloudConnectionsUrl}
      {...settingsDefinitions["integrations.github"]}
      purpose="Read repositories, issues, Projects, and pull requests."
      status={accountVaultStore.providerStatus("github")}
      icon={githubLogo}
      testId="connections-row-github-account"
    />
    <AccountConnectionRow
      url={cloudConnectionsUrl}
      {...settingsDefinitions["integrations.google-drive"]}
      purpose="Publish and update Google Docs from works and plans."
      status={accountVaultStore.providerStatus("google")}
      icon={googleLogo}
      testId="connections-row-google-account"
    />
    <AccountConnectionRow
      url={cloudConnectionsUrl}
      {...settingsDefinitions["integrations.atlassian"]}
      purpose="Read and write Confluence pages and Jira issues."
      status={accountVaultStore.providerStatus("atlassian")}
      icon={atlassianLogo}
      testId="connections-row-atlassian-account"
    />
  {:else}
    <GitHubConnect {serverId} />
    <GoogleProviderSettings {serverId} />
    <AtlassianProviderSettings {serverId} />
  {/if}
  <LinearConnection {serverId} />
</SettingsSection>

{#snippet githubLogo()}
  <Icon icon={PROVIDER_LOGOS.github} width={16} height={16} />
{/snippet}

{#snippet googleLogo()}
  <Icon icon={PROVIDER_LOGOS.google} width={16} height={16} />
{/snippet}

{#snippet atlassianLogo()}
  <Icon icon={PROVIDER_LOGOS.atlassian} width={16} height={16} />
{/snippet}
