<script lang="ts">
  /** The organization's workspace service (docs/plans/cloud-service-model.md):
   *  not a machine, so no git, providers, environment, pairing, or link — only
   *  where it answers, whether it does, and what it holds. */
  import { hostStatusLabel, serversStore, type ServerItem } from "../../contexts";
  import { cloudConnectionsLabel } from "../../contexts/connections/host-label";
  import { Button } from "../ui/button";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";

  interface Props {
    host: ServerItem;
  }

  let { host }: Props = $props();
  let testing = $state(false);

  const reachability = $derived(hostStatusLabel(serversStore.statusFor(host.id)));

  async function testConnection() {
    testing = true;
    try {
      await serversStore.checkReachable(host.id);
    } finally {
      testing = false;
    }
  }
</script>

<div class="flex flex-col gap-6 [.is-laptop-display_&]:gap-5" data-testid="host-detail-cloud">
  <div class="min-w-0">
    <h2 class="text-[2em] font-medium text-foreground">{cloudConnectionsLabel(host.label)}</h2>
    <p
      class="mt-1 truncate text-[0.875em] text-muted-foreground"
      style="font-family: 'Geist Mono', ui-monospace, monospace"
    >
      {host.url}
    </p>
  </div>

  <SettingsSection label="Workspace">
    <SettingsRow label="Reachable" description={reachability}>
      {#snippet control()}
        <Button variant="outline" size="sm" disabled={testing} onclick={() => void testConnection()}>
          {testing ? "Testing…" : "Test"}
        </Button>
      {/snippet}
    </SettingsRow>
    <SettingsRow
      label="What lives here"
      description="Tasks, documents, comments, shares, and session records for {host.label}. Sessions run on your machines; this workspace keeps the record."
    />
  </SettingsSection>
</div>
