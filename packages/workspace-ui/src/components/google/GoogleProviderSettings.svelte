<script lang="ts">
  import Icon from "@iconify/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { missingGoogleScopes } from "@solus/contracts/google-auth";
  import { LogOut as SignOutIcon } from "@lucide/svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { ensureIconCollections } from "../diagram/iconify";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import ProviderConnectedCheck from "../settings/ProviderConnectedCheck.svelte";
  import { PROVIDER_LOGOS } from "../settings/lib/provider-logos";
  import { Button } from "../ui/button";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();
  let loaded = $state(false);
  let connected = $state(false);
  let configured = $state(false);
  let connecting = $state(false);
  let grantedScopes = $state<string[] | undefined>(undefined);

  ensureIconCollections();

  const api = $derived(serverConnections.apiFor(serverId));
  // A grant approved before `drive.readonly` shipped still publishes, so this is
  // a prompt beside a working connection rather than a disconnected state.
  const needsDriveReadScope = $derived(connected && missingGoogleScopes(grantedScopes).length > 0);
  const description = $derived(
    !loaded
      ? "Checking…"
      : connected
        ? "Connected. Publish and update Google Docs from works and plans."
        : configured
          ? "Publish and update Google Docs from works and plans."
          : "Unavailable in this build of Solus.",
  );

  $effect(() => {
    void refresh();
  });

  async function refresh() {
    const status = await api.googleStatus();
    connected = status.connected;
    configured = status.configured;
    grantedScopes = status.scopes;
    loaded = true;
  }

  // Google must return the browser to the Solus server, which is not the page's
  // own origin: in desktop development the renderer is served by Vite, so
  // `window.location.origin` sent the callback to a dev server that has no route
  // for it. The host's HTTP origin is the address this client already reaches
  // the server at, so the browser can reach it too.
  async function connect() {
    connecting = true;
    try {
      const flow = await api.googleConnect(serverConnections.httpOriginFor(serverId));
      const opened = await localApi.openExternal(flow.authUrl);
      if (!opened) window.open(flow.authUrl, "_blank", "noopener,noreferrer");
      const deadline = Math.min(flow.expiresAt, Date.now() + 5 * 60_000);
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await refresh();
        // A reconnect starts already connected, so waiting on `connected` alone
        // would report success before the wider grant landed.
        if (connected && !needsDriveReadScope) {
          requestInputFocus();
          return;
        }
      }
      toasts.error("Google sign-in did not finish", { description: "Try Connect again." });
    } catch (error) {
      toasts.error("Couldn't connect Google Drive", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      connecting = false;
    }
  }

  async function disconnect() {
    await api.googleDisconnect();
    connected = false;
    grantedScopes = undefined;
    requestInputFocus();
  }
</script>

<SettingsSection label="Google Drive">
  {#snippet icon()}
    <Icon icon={PROVIDER_LOGOS.google} width={13} height={13} />
  {/snippet}

  <SettingsRow label="Google account" description={description}>
    {#snippet labelExtra()}
      <ProviderConnectedCheck connected={loaded && connected} provider="Google" />
    {/snippet}
    {#snippet control()}
      {#if connected}
        <Button variant="outline" size="sm" onclick={() => void disconnect()}>
          <SignOutIcon size={13} />
          Disconnect
        </Button>
      {:else if configured}
        <Button size="sm" disabled={connecting} onclick={() => void connect()}>
          {connecting ? "Waiting for browser…" : "Connect"}
        </Button>
      {/if}
    {/snippet}
  </SettingsRow>
  <SettingsRow
    label="Drive access"
    description="Reconnect to let Solus search and read Google Docs it did not create. Publishing already works."
    visible={needsDriveReadScope}
  >
    {#snippet control()}
      <Button variant="outline" size="sm" disabled={connecting} onclick={() => void connect()}>
        {connecting ? "Waiting for browser…" : "Reconnect"}
      </Button>
    {/snippet}
  </SettingsRow>
</SettingsSection>
