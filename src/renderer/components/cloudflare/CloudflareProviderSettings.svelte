<script lang="ts">
  import { ArrowSquareOutIcon, SignOutIcon } from "phosphor-svelte";
  import { onMount } from "svelte";
  import {
    cloudflareStore,
    CLOUDFLARE_TOKEN_URL,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { Button } from "../ui/button";
  import CloudflareConnectForm from "./CloudflareConnectForm.svelte";

  onMount(() => {
    void cloudflareStore.ensureStatus();
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
    await cloudflareStore.disconnect();
    requestInputFocus();
  }
</script>

{#snippet connectForm()}
  <CloudflareConnectForm onconnected={() => requestInputFocus()} />
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
        <span class="text-[0.75rem] text-muted-foreground">Read-only</span>
      {:else if cloudflareStore.connected}
        <Button variant="outline" size="sm" onclick={() => void disconnect()}>
          <SignOutIcon size={13} />
          Disconnect
        </Button>
      {:else}
        <Button
          size="sm"
          onclick={() => void window.solus.openExternal(CLOUDFLARE_TOKEN_URL)}
        >
          Create API token
          <ArrowSquareOutIcon size={13} />
        </Button>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>
