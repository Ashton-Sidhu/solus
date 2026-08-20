<script lang="ts">
  /** Where a host stands, at a glance — each summary row is a way into the tab
   *  that can actually change it. */
  import { Check as CheckIcon, Copy as CopyIcon } from "@lucide/svelte";
  import { hostStatusLabel, serversStore, type ServerItem } from "../../contexts";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import { SETUP_PROVIDERS } from "../servers/lib/host-onboarding";
  import type { HostSetupSession } from "../servers/host-setup.store.svelte";

  interface Props {
    host: ServerItem;
    setup: HostSetupSession;
    onOpenTab: (tab: string) => void;
  }

  let { host, setup, onOpenTab }: Props = $props();
  let addressCopied = $state(false);
  /** Set by Test alone: the row reads "checked" only once the user asked. */
  let testing = $state(false);

  const github = $derived(setup.readiness?.github);
  const reachability = $derived(
    [
      hostStatusLabel(serversStore.statusFor(host.id)),
      setup.lastCheckedAt ? `checked ${relativeTime(setup.lastCheckedAt)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  const signedInProviders = $derived(
    SETUP_PROVIDERS.filter(
      (provider) => setup.readiness?.agents?.[provider.id]?.signedIn,
    ).map((provider) => provider.label),
  );

  /**
   * Two questions, and the row answers both: the transport probe is what decides
   * online/offline, and readiness is what the rest of the page is drawn from.
   */
  async function testConnection() {
    testing = true;
    try {
      await serversStore.checkReachable(host.id);
      await setup.refreshReadiness();
    } finally {
      testing = false;
    }
  }

  function copyAddress() {
    void navigator.clipboard.writeText(host.url);
    addressCopied = true;
    setTimeout(() => (addressCopied = false), 1500);
  }
</script>

<SettingsSection label="This host">
  <SettingsRow label="Reachable" description={reachability}>
    {#snippet control()}
      <Button
        variant="outline"
        size="sm"
        disabled={testing}
        onclick={() => void testConnection()}
      >
        {testing ? "Testing…" : "Test"}
      </Button>
    {/snippet}
  </SettingsRow>

  <SettingsRow label="Address" description={host.url}>
    {#snippet control()}
      <Button
        variant="ghost"
        size="icon-sm"
        onclick={copyAddress}
        class="text-(--solus-text-tertiary)"
        aria-label="Copy host address"
      >
        {#if addressCopied}
          <CheckIcon size={13} class="text-(--solus-status-complete)" />
        {:else}
          <CopyIcon size={13} />
        {/if}
      </Button>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Edit address"
    description="Point Solus at this host on a different port or interface."
    comingSoon
  >
    {#snippet control()}
      <Button variant="outline" size="sm">Edit</Button>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Reconnect automatically"
    description="Come back to this host on its own when it drops off the network."
    comingSoon
  >
    {#snippet control()}
      <Switch checked={false} size="default" aria-label="Reconnect automatically" />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection label="Setup">
  <SettingsRow
    label="GitHub"
    description={github?.solusToken
      ? `Connected · ${github.solusLogin ?? "this host"}`
      : "Not connected — this host cannot clone or push yet"}
  >
    {#snippet control()}
      {@render openTab("git", !!github?.solusToken)}
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Coding providers"
    description={signedInProviders.length > 0
      ? `Signed in · ${signedInProviders.join(", ")}`
      : "None signed in — this host cannot take a session yet"}
  >
    {#snippet control()}
      {@render openTab("providers", signedInProviders.length > 0)}
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Projects folder"
    description={setup.readiness?.projectsRoot ?? "Not reported by this host"}
  >
    {#snippet control()}
      {@render openTab("environment", !!setup.readiness?.projectsRoot)}
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if !host.local}
  <SettingsSection label="Danger zone">
    <SettingsRow
      label="Remove host"
      description="Forget this host. You'll need to pair with it again."
    >
      {#snippet control()}
        <Button
          variant="outline"
          size="sm"
          class="text-(--solus-status-error) hover:text-(--solus-status-error)"
          onclick={() => serversStore.remove(host.id)}
        >
          Forget
        </Button>
      {/snippet}
    </SettingsRow>
  </SettingsSection>
{/if}

{#snippet openTab(tab: string, satisfied: boolean)}
  <Button variant="outline" size="sm" onclick={() => onOpenTab(tab)}>
    {satisfied ? "Configure" : "Set up"}
  </Button>
{/snippet}
