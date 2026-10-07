<script lang="ts">
  /** The host's link to the owner's Solus cloud account (personal Uplink, C4).
   *  A local owner — the desktop on the machine or a paired device — changes it:
   *  signed out it offers sign-in, signed in it links. Unlinking needs no account
   *  (the host holds its own token for that), so a linked host always offers it.
   *  An owner who arrived through the tunnel sees the link and cannot change it:
   *  linking changes how the host is reached. A managed host never shows it: its
   *  link is system-owned (managed-hosts.md §1). */
  import { localApi } from "@solus/client-core/local-api";
  import { accountStore, uplinkStatusDescription, uplinkStore } from "../../contexts";
  import { hostWebsiteUrl } from "../../contexts/connections/host-routes";
  import { Button } from "../ui/button";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";

  interface Props {
    serverId: string;
    label?: string;
  }

  let { serverId, label = "Solus Cloud" }: Props = $props();

  const linkControl = $derived(uplinkStore.controlFor(serverId));
  // Linking takes an account to issue the ticket; a client without one (a web
  // client served by a host, not by Solus cloud) can only say where to link.
  const canChange = $derived(linkControl === "manage" && uplinkStore.accountAvailable);
  const uplink = $derived(uplinkStore.statusFor(serverId));
  const uplinkBusy = $derived(uplinkStore.busyServerId === serverId);
  const account = $derived(accountStore.state);

  $effect(() => {
    void uplinkStore.refresh(serverId);
  });

  const linked = $derived(uplink?.linked === true);
  // Sharing with a team is done on the website, not here: the site owns
  // organizations and their membership (plan Step 1.4).
  const websiteUrl = $derived(
    uplink?.linked ? hostWebsiteUrl(uplink.link.directoryUrl, uplink.link.hostId) : null,
  );
  const rowLabel = $derived(
    linked
      ? "Linked to your account"
      : !canChange || uplinkStore.canLink
        ? "Link to Solus Cloud"
        : account.kind === "signing-in"
          ? "Confirm in your browser"
          : "Sign in to Solus Cloud",
  );
  const rowDescription = $derived(
    linkControl === "view"
      ? `${uplinkStatusDescription(uplink)} Change the link from the host itself or from a paired device.`
      : !canChange && !linked
        ? "Open Solus from your Solus Cloud account or from the desktop app to link this host."
        : linked || uplinkStore.canLink
          ? uplinkStatusDescription(uplink)
          : account.kind === "signing-in"
            ? `Enter ${account.userCode} on the approval page to sign this Mac in.`
            : account.kind === "unavailable"
              ? "The system keychain is unavailable, so an account cannot be stored on this Mac."
              : "Sign in to reach this host from your other devices through your Solus account.",
  );
</script>

{#if linkControl !== "none"}
  <SettingsSection {label}>
    <SettingsRow label={rowLabel} description={rowDescription}>
      {#snippet control()}
        <!-- Without a button, the description says where to change the link. -->
        {#if linkControl !== "manage" || (!canChange && !linked)}{:else if linked}
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
    {#if websiteUrl}
      <SettingsRow
        label="Team access"
        description="Share this host with a team, or stop sharing it, on the Solus cloud website."
      >
        {#snippet control()}
          <Button
            variant="outline"
            size="sm"
            onclick={() => void localApi.openExternal(websiteUrl)}
          >
            Manage on website
          </Button>
        {/snippet}
      </SettingsRow>
    {/if}
  </SettingsSection>
{/if}