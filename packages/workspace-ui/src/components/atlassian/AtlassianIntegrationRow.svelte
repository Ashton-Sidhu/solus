<script lang="ts">
  /** Atlassian on the Integrations page. Connect opens the sign-in in a
   *  dialog, so the page stays a list of rows; the page reads the status. */
  import { Ellipsis } from "@lucide/svelte";
  import { atlassianStore } from "../../contexts/atlassian/atlassian.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import IntegrationDialog from "../settings/IntegrationDialog.svelte";
  import IntegrationRow from "../settings/IntegrationRow.svelte";
  import { PROVIDER_LOGOS } from "../settings/lib/provider-logos";
  import AtlassianConnectForm from "./AtlassianConnectForm.svelte";

  let { serverId }: { serverId: string } = $props();

  let isDialogOpen = $state(false);
  const isConnected = $derived(atlassianStore.connected(serverId));
  const description = $derived(
    isConnected
      ? `${atlassianStore.siteName(serverId)} · ${atlassianStore.productSummary(serverId)}${atlassianStore.connectedWithApiToken(serverId) ? " · API token" : ""}`
      : "Confluence pages and Jira issues on one site.",
  );

  // A browser sign-in in flight holds a loopback port on the host, so closing
  // the dialog releases it.
  function dialogClosed() {
    if (atlassianStore.awaitingBrowser(serverId)) void atlassianStore.cancelBrowserWait(serverId);
    atlassianStore.clearFailure(serverId);
  }

  // Disconnect drops Solus's copy of the grant. Revoking it at Atlassian is a
  // separate, deliberate act in the user's account.
  async function disconnect() {
    await atlassianStore.disconnect(serverId);
    requestInputFocus();
  }
</script>

<IntegrationRow name="Atlassian" logo={PROVIDER_LOGOS.atlassian} {description} {isConnected} testId="connections-row-atlassian">
  {#snippet action()}
    {#if isConnected}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="ghost" size="icon-sm" class="text-muted-foreground pointer-coarse:tap-area" aria-label="More actions for Atlassian"><Ellipsis size={16} /></Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[min(16rem,calc(100vw-2rem))]">
          <DropdownMenu.Item variant="destructive" onSelect={() => void disconnect()}>Disconnect</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {:else}
      <Button variant="outline" size="sm" class="pointer-coarse:min-h-11"
        onclick={() => (isDialogOpen = true)} aria-label="Connect Atlassian">Connect</Button>
    {/if}
  {/snippet}
</IntegrationRow>

<IntegrationDialog
  bind:isOpen={isDialogOpen}
  title="Connect Atlassian"
  description="Read and write Confluence pages and Jira issues on one Atlassian site, acting as you."
  logo={PROVIDER_LOGOS.atlassian}
  onClose={dialogClosed}
  testId="atlassian-connect-dialog"
>
  <AtlassianConnectForm {serverId} onconnected={() => { isDialogOpen = false; requestInputFocus(); }} />
</IntegrationDialog>
