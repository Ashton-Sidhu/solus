<script lang="ts">
  /** The coding CLIs a session on this host can run through. */
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import ProviderPanel from "../servers/ProviderPanel.svelte";
  import type { HostSetupSession } from "../servers/host-setup.store.svelte";

  interface Props {
    setup: HostSetupSession;
  }

  let { setup }: Props = $props();

</script>

<ProviderPanel {setup} />

<SettingsSection label="Session defaults">
  <SettingsRow
    label="Default agent"
    description="Which provider a new session on this host starts with."
    comingSoon
  >
    {#snippet control()}
      <Button variant="outline" size="sm">Claude Code</Button>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Fall back on rate limits"
    description="Hand the session to the other signed-in provider instead of stopping."
    comingSoon
  >
    {#snippet control()}
      <Switch checked={false} size="default" aria-label="Fall back on rate limits" />
    {/snippet}
  </SettingsRow>
</SettingsSection>
