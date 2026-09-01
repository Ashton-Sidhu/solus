<script lang="ts">
  import Icon from "@iconify/svelte";
  import { LogOut as SignOutIcon } from "@lucide/svelte";
  import { atlassianStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { ensureIconCollections } from "../diagram/iconify";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import ProviderConnectedCheck from "../settings/ProviderConnectedCheck.svelte";
  import { PROVIDER_LOGOS } from "../settings/lib/provider-logos";
  import { Button } from "../ui/button";
  import AtlassianConnectForm from "./AtlassianConnectForm.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  ensureIconCollections();

  $effect(() => {
    void atlassianStore.ensureStatus(serverId);
  });

  const siteDescription = $derived.by(() => {
    if (!atlassianStore.statusLoaded(serverId)) return "Checking…";
    if (atlassianStore.connected(serverId))
      return `${atlassianStore.siteName(serverId)} · ${atlassianStore.productSummary(serverId)}`;
    if (!atlassianStore.oauthAvailable(serverId))
      return "Unavailable in this build of Solus.";
    return "Read and write Confluence pages and Jira issues on one Atlassian site.";
  });

  async function disconnect() {
    await atlassianStore.disconnect(serverId);
    requestInputFocus();
  }
</script>

{#snippet connectForm()}
  <AtlassianConnectForm {serverId} onconnected={() => requestInputFocus()} />
{/snippet}

<SettingsSection label="Atlassian">
  {#snippet icon()}
    <Icon icon={PROVIDER_LOGOS.atlassian} width={13} height={13} />
  {/snippet}

  <SettingsRow
    label="Atlassian site"
    description={siteDescription}
    body={atlassianStore.statusLoaded(serverId) && !atlassianStore.connected(serverId)
      ? connectForm
      : undefined}
  >
    {#snippet labelExtra()}
      <ProviderConnectedCheck
        connected={atlassianStore.statusLoaded(serverId) && atlassianStore.connected(serverId)}
        provider="Atlassian"
      />
    {/snippet}
    {#snippet control()}
      {#if atlassianStore.connected(serverId)}
        <!-- Disconnect drops Solus's copy of the grant. Revoking it at
             Atlassian is a separate, deliberate act in the user's account. -->
        <Button variant="outline" size="sm" onclick={() => void disconnect()}>
          <SignOutIcon size={13} />
          Disconnect
        </Button>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>
