<script lang="ts">
  /** GitHub on the Integrations page. Connect starts the device sign-in at
   *  once; the page reads the status, so this row only acts on it. */
  import { Ellipsis, LoaderCircle } from "@lucide/svelte";
  import { getWorkspaceContext, connectionsStore } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import IntegrationRow from "../settings/IntegrationRow.svelte";
  import { PROVIDER_LOGOS } from "../settings/lib/provider-logos";
  import GitHubDeviceCodeDialog from "./GitHubDeviceCodeDialog.svelte";

  let { serverId }: { serverId: string } = $props();

  const session = getWorkspaceContext();
  const connections = connectionsStore;
  const isConnected = $derived(!!connections.providerStatus?.connected);
  // Tokens minted before the `project` scope existed can't read/write Projects v2
  // fields (due date, priority, status). Prompt those users to reconnect.
  const needsProjectScope = $derived(isConnected && !connections.providerStatus?.scopes?.includes("project"));
  const description = $derived.by(() => {
    if (needsProjectScope) return "Reconnect to use due date, priority, and status on GitHub tasks.";
    if (!isConnected) return "Pull requests, project boards, and comments as you.";
    const login = connections.providerStatus?.login;
    return login ? `Connected as @${login}` : "Connected";
  });

  async function connect() {
    try {
      await connections.connectProvider(serverId, session.ctx);
    } catch (error) {
      toasts.error("Couldn't connect to GitHub", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function disconnect() {
    await connections.disconnectProvider(serverId, session.ctx);
    requestInputFocus();
  }
</script>

<IntegrationRow name="GitHub" logo={PROVIDER_LOGOS.github} {description} {isConnected} testId="connections-row-github">
  {#snippet action()}
    {#if !isConnected || needsProjectScope}
      <Button variant="outline" size="sm" class="border-border/70 text-workspace-chrome shadow-xs pointer-coarse:min-h-11"
        disabled={connections.providerConnecting} onclick={() => void connect()} aria-label="{isConnected ? 'Reconnect' : 'Connect'} GitHub">
        {#if connections.providerConnecting}<LoaderCircle size={14} class="animate-spin motion-reduce:animate-none" />{/if}
        {isConnected ? "Reconnect" : "Connect"}
      </Button>
    {/if}
    {#if isConnected}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="ghost" size="icon-sm" class="text-muted-foreground pointer-coarse:tap-area" aria-label="More actions for GitHub"><Ellipsis size={16} /></Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[min(16rem,calc(100vw-2rem))]">
          <DropdownMenu.Item variant="destructive" onSelect={() => void disconnect()}>Disconnect</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
  {/snippet}
</IntegrationRow>

<GitHubDeviceCodeDialog {serverId} />
