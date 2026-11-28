<script lang="ts">
  import { githubSetting } from "@solus/client-core/settings-source-control";
import Icon from "@iconify/svelte";
  import { ensureIconCollections } from "../../lib/iconify";
  import { PROVIDER_LOGOS } from "../settings/lib/provider-logos";
  import {
    LogOut as SignOutIcon,
    LoaderCircle as SpinnerGapIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext, connectionsStore } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import ProviderConnectedCheck from "../settings/ProviderConnectedCheck.svelte";
  import GitHubDeviceCodeDialog from "./GitHubDeviceCodeDialog.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const session = getWorkspaceContext();
  const connections = connectionsStore;

  ensureIconCollections();

  // Tokens minted before the `project` scope existed can't read/write Projects v2
  // fields (due date, priority, status). Prompt those users to reconnect.
  const needsProjectScope = $derived(
    !!connections.providerStatus?.connected &&
      !connections.providerStatus.scopes?.includes("project"),
  );

  // Only once the host has answered: an unanswered status is not a connected
  // account. A later refresh does not blank the check, so it does not flicker.
  const isConnected = $derived(
    connections.providerLoaded && !!connections.providerStatus?.connected,
  );

  const accountDescription = $derived.by(() => {
    if (!connections.providerLoaded || connections.providerLoading) return "Checking…";
    if (!connections.providerStatus?.connected)
      return "Review pull requests, manage project boards, and comment as yourself.";
    const { login } = connections.providerStatus;
    return login ? `Connected as @${login}` : "Connected";
  });


  $effect(() => {
    void connections.refreshProviderStatus(serverId, session.ctx);
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

<!-- The GitHub rows only: Source Control and Integrations each put them in
     their own section. -->
  <SettingsRow {...githubSetting} description={accountDescription}>
    {#snippet icon()}
      <Icon icon={PROVIDER_LOGOS.github} width={16} height={16} />
    {/snippet}
    {#snippet labelExtra()}
      <ProviderConnectedCheck connected={isConnected} provider="GitHub" />
    {/snippet}
    {#snippet control()}
      {#if connections.providerStatus?.connected}
        <Button variant="destructive" size="sm" class="pointer-coarse:min-h-11" onclick={disconnect}>
          <SignOutIcon size={13} />
          Disconnect
        </Button>
      {:else}
        <Button variant="outline" size="sm" class="pointer-coarse:min-h-11" onclick={connect} disabled={connections.providerConnecting}>
          {#if connections.providerConnecting}
            <SpinnerGapIcon size={14} class="animate-spin" />
            Connecting…
          {:else}
            <Icon icon={PROVIDER_LOGOS.github} width={14} height={14} />
            Connect GitHub
          {/if}
        </Button>
      {/if}
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Project access"
    description="Reconnect to grant project access and enable due date, priority & status on GitHub issues."
    visible={needsProjectScope}
  >
    {#snippet control()}
      <Button
        variant="outline"
        size="sm"
        class="pointer-coarse:min-h-11"
        onclick={connect}
        disabled={connections.providerConnecting}
      >
        Reconnect
      </Button>
    {/snippet}
  </SettingsRow>

<GitHubDeviceCodeDialog {serverId} />
