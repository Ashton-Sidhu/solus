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
{#if setup.logLines.length}
  <details class="text-workspace-chrome">
    <summary class="cursor-pointer text-muted-foreground">Provider setup output</summary>
    <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-workspace-chrome">{setup.logLines.join('\n')}</pre>
  </details>
{/if}

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
