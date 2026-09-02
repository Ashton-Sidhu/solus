<script lang="ts">
  /** The host's link to the owner's Solus cloud account (personal Uplink, C4).
   *  Shown to a local owner whenever this client can hold an account: signed out
   *  it offers sign-in, signed in it links. Unlinking needs no account — the host
   *  holds its own token for that — so a linked host always offers it. A device
   *  arriving through the tunnel never sees it: linking changes how the host is reached. */
  import { accountStore, connectionsStore, uplinkStatusDescription, uplinkStore } from "../../contexts";
  import { Button } from "../ui/button";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  const showSection = $derived(
    connectionsStore.serverInfo?.principal === "local-owner" && uplinkStore.accountAvailable,
  );
  const uplink = $derived(uplinkStore.statusFor(serverId));
  const uplinkBusy = $derived(uplinkStore.busyServerId === serverId);
  const account = $derived(accountStore.state);

  $effect(() => {
    if (showSection) void uplinkStore.refresh(serverId);
  });

  const linked = $derived(uplink?.linked === true);
  const rowLabel = $derived(
    linked
      ? "Linked to your account"
      : uplinkStore.canLink
        ? "Link to Solus cloud"
        : account.kind === "signing-in"
          ? "Confirm in your browser"
          : "Sign in to Solus cloud",
  );
  const rowDescription = $derived(
    linked || uplinkStore.canLink
      ? uplinkStatusDescription(uplink)
      : account.kind === "signing-in"
        ? `Enter ${account.userCode} on the approval page to sign this Mac in.`
        : account.kind === "unavailable"
          ? "The system keychain is unavailable, so an account cannot be stored on this Mac."
          : "Sign in to reach this host from your other devices through your Solus account.",
  );
</script>

{#if showSection}
  <SettingsSection label="Solus cloud">
    <SettingsRow label={rowLabel} description={rowDescription}>
      {#snippet control()}
        {#if linked}
          <Button
            variant="outline"
            size="sm"
            disabled={uplinkBusy}
            onclick={() => void uplinkStore.unlink(serverId)}
          >
            {uplinkBusy ? "Unlinking…" : "Unlink"}
          </Button>
        {:else if uplinkStore.canLink}
          <Button
            variant="outline"
            size="sm"
            disabled={uplinkBusy || !uplink}
            onclick={() => void uplinkStore.link(serverId)}
          >
            {uplinkBusy ? "Linking…" : "Link"}
          </Button>
        {:else if account.kind === "signing-in"}
          <Button variant="outline" size="sm" onclick={() => accountStore.cancelSignIn()}>
            Cancel
          </Button>
        {:else}
          <Button
            variant="outline"
            size="sm"
            disabled={account.kind === "unavailable"}
            onclick={() => void accountStore.signIn()}
          >
            Sign in
          </Button>
        {/if}
      {/snippet}
    </SettingsRow>
  </SettingsSection>
{/if}