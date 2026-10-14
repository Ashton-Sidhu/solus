<script lang="ts">
  /** The host and Solus Cloud, as two facts (docs/adr/0001-standard-authentication.md
   *  §2.2 rules 8 and 9). "Registered to your account" is the host's identity: it is
   *  made by itself when a signed-in owner's client reaches the host, and it is what
   *  the account, delegations, and organizations need. "Reachable from the internet"
   *  is the link: a Cloudflare tunnel, and nothing else. A local owner — the desktop
   *  on the machine or a paired device — changes them; an owner who arrived through
   *  the tunnel sees them and cannot change them. A managed host never shows them:
   *  Solus cloud owns them (managed-hosts.md §1). */
  import { localApi } from "@solus/client-core/local-api";
  import { accountStore, linkDescription, registrationDescription, uplinkStore } from "../../contexts";
  import { hostWebsiteUrl } from "../../contexts/connections/host-routes";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";

  interface Props {
    serverId: string;
    label?: string;
  }

  let { serverId, label = "Solus Cloud" }: Props = $props();

  const hostControl = $derived(uplinkStore.controlFor(serverId));
  // Registering takes an account to issue the ticket; a client without one (a web
  // client served by a host, not by Solus cloud) can only say where to do it.
  const canChange = $derived(hostControl === "manage" && uplinkStore.accountAvailable);
  const uplink = $derived(uplinkStore.statusFor(serverId));
  const busy = $derived(uplinkStore.busyServerId === serverId);
  const account = $derived(accountStore.state);
  const registration = $derived(uplink?.registration);
  const isRegistered = $derived(registration?.registered === true);
  const isLinked = $derived(uplink?.link.linked === true);

  // Read again when the host changes, and when this client signs in: a signed-in
  // owner's client registers a host that is not registered.
  $effect(() => {
    void uplinkStore.canLink;
    void uplinkStore.refresh(serverId);
  });

  // Sharing with a team is done on the website, not here: the site owns
  // organizations and their membership (plan Step 1.4).
  const websiteUrl = $derived(
    registration?.registered ? hostWebsiteUrl(registration.registration.directoryUrl, registration.registration.hostId) : null,
  );
  const registrationLabel = $derived(
    isRegistered
      ? "Registered to your account"
      : !canChange || uplinkStore.canLink
        ? busy
          ? "Registering…"
          : "Not registered"
        : account.kind === "signing-in"
          ? "Confirm in your browser"
          : "Sign in to Solus Cloud",
  );
  const registrationText = $derived(
    hostControl === "view"
      ? `${registrationDescription(uplink)} Change it from the host itself or from a paired device.`
      : !canChange && !isRegistered
        ? "Open Solus from your Solus Cloud account or from the desktop app to register this host."
        : isRegistered || uplinkStore.canLink
          ? registrationDescription(uplink)
          : account.kind === "signing-in"
            ? "Finish signing in in your browser to sign this app in."
            : account.kind === "unavailable"
              ? "The system keychain is unavailable, so an account cannot be stored on this computer."
              : "Sign in to register this host to your account. It stays on your local network.",
  );
  const linkText = $derived(
    hostControl === "view"
      ? `${linkDescription(uplink)} Change it from the host itself or from a paired device.`
      : linkDescription(uplink),
  );

  function toggleLink() {
    if (busy || hostControl !== "manage") return;
    void (isLinked ? uplinkStore.unlink(serverId) : uplinkStore.link(serverId));
  }
</script>

{#if hostControl !== "none"}
  <SettingsSection {label}>
    <SettingsRow label={registrationLabel} description={registrationText}>
      {#snippet control()}
        <!-- Without a button, the description says where to change it. -->
        {#if !canChange || isRegistered}{:else if uplinkStore.canLink}
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !uplink}
            onclick={() => void uplinkStore.register(serverId)}
          >
            {busy ? "Registering…" : "Register"}
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
    <SettingsRow label="Reachable from the internet" description={linkText} visible={isRegistered || isLinked}>
      {#snippet control()}
        <Switch
          checked={isLinked}
          onclick={toggleLink}
          disabled={busy || hostControl !== "manage"}
          size="default"
          aria-label="Reachable from the internet"
        />
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
