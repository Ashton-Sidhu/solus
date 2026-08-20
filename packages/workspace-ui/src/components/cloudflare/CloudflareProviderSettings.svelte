<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { ExternalLink as ArrowSquareOutIcon, LogOut as SignOutIcon } from "@lucide/svelte";
  import {
    cloudflareStore,
    CLOUDFLARE_TOKEN_URL,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { Button } from "../ui/button";
  import CloudflareConnectForm from "./CloudflareConnectForm.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  $effect(() => {
    void cloudflareStore.ensureStatus(serverId);
  });

  const accountDescription = $derived.by(() => {
    if (!cloudflareStore.statusLoaded) return "Checking…";
    if (!cloudflareStore.connected)
      return "Deploy sites, Workers, D1, KV and R2 to your own Cloudflare account.";
    if (cloudflareStore.isEnvManaged)
      return "Configured via CLOUDFLARE_API_TOKEN";
    return cloudflareStore.accountName
      ? `Connected as ${cloudflareStore.accountName}`
      : "Connected";
  });

  async function disconnect() {
    await cloudflareStore.disconnect(serverId);
    requestInputFocus();
  }
</script>

{#snippet connectForm()}
  <CloudflareConnectForm {serverId} onconnected={() => requestInputFocus()} />
{/snippet}

<SettingsSection label="Cloudflare">
  <SettingsRow
    label="Cloudflare account"
    description={accountDescription}
    body={cloudflareStore.statusLoaded && !cloudflareStore.connected
      ? connectForm
      : undefined}
  >
    {#snippet control()}
      {#if cloudflareStore.isEnvManaged}
        <!-- The environment owns this credential; the app has nothing to revoke. -->
        <span class="text-xs text-muted-foreground">Read-only</span>
      {:else if cloudflareStore.connected}
        <Button variant="outline" size="sm" onclick={() => void disconnect()}>
          <SignOutIcon size={13} />
          Disconnect
        </Button>
      {:else}
        <Button
          size="sm"
          onclick={() => void localApi.openExternal(CLOUDFLARE_TOKEN_URL)}
        >
          Create API token
          <ArrowSquareOutIcon size={13} />
        </Button>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>
