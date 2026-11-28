<script lang="ts">
  /** Google Drive on the Integrations page. Connect opens the browser sign-in
   *  at once; the page reads the status, so this row only acts on it. */
  import { Ellipsis, LoaderCircle } from "@lucide/svelte";
  import { googleStore } from "../../contexts/google/google.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import IntegrationRow from "../settings/IntegrationRow.svelte";
  import { PROVIDER_LOGOS } from "../settings/lib/provider-logos";

  let { serverId }: { serverId: string } = $props();

  const isConnected = $derived(googleStore.connected(serverId));
  const needsDriveReadScope = $derived(googleStore.needsDriveReadScope(serverId));
  const isConnecting = $derived(googleStore.connecting(serverId));

  async function connect() {
    try {
      if (await googleStore.connect(serverId)) requestInputFocus();
      else toasts.error("Google sign-in did not finish", { description: "Try Connect again." });
    } catch (error) {
      toasts.error("Couldn't connect Google Drive", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function disconnect() {
    await googleStore.disconnect(serverId);
    requestInputFocus();
  }
</script>

<IntegrationRow
  name="Google Drive"
  logo={PROVIDER_LOGOS.google}
  description={needsDriveReadScope
    ? "Reconnect to let Solus search and read Google Docs it did not create."
    : "Publish and update Google Docs from works and plans."}
  {isConnected}
  testId="connections-row-google"
>
  {#snippet action()}
    {#if !isConnected || needsDriveReadScope}
      <Button variant="outline" size="sm" class="pointer-coarse:min-h-11"
        disabled={isConnecting} onclick={() => void connect()} aria-label="{isConnected ? 'Reconnect' : 'Connect'} Google Drive">
        {#if isConnecting}<LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />Waiting for browser…{:else}{isConnected ? "Reconnect" : "Connect"}{/if}
      </Button>
    {/if}
    {#if isConnected}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="ghost" size="icon-sm" class="text-muted-foreground pointer-coarse:tap-area" aria-label="More actions for Google Drive"><Ellipsis size={16} /></Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[min(16rem,calc(100vw-2rem))]">
          <DropdownMenu.Item variant="destructive" onSelect={() => void disconnect()}>Disconnect</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
  {/snippet}
</IntegrationRow>
