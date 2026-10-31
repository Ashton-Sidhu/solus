<script lang="ts">
  import type { ProviderInstancesClient } from "@solus/client-core/provider-instances";
  import type { ProviderInstancesSnapshot } from "@solus/contracts/provider-instances";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsSelect from "./SettingsSelect.svelte";
  import { Input } from "../ui/input";
  import { Button } from "../ui/button";
  let { snapshot, client, saving }: { snapshot: ProviderInstancesSnapshot; client: ProviderInstancesClient; saving: boolean } = $props();
  function save(healthCheckSeconds: number, idleCompaction: ProviderInstancesSnapshot['idleCompaction']) {
    void client.write({ expectedRevision: snapshot.revision, change: { kind: "advanced", healthCheckSeconds, idleCompaction } });
  }
</script>
<SettingsSection label="Advanced provider settings">
  <SettingsRow label="Status check interval" description="Seconds between status checks while a provider detail page is open. Set 0 to disable repeated checks.">
    {#snippet control()}<div class="flex gap-2"><Input type="number" aria-label="Provider status check interval in seconds" min={0} max={86400} value={snapshot.healthCheckSeconds} disabled={saving} onchange={(event) => save(Number(event.currentTarget.value), snapshot.idleCompaction)} /><Button variant="ghost" size="sm" disabled={saving} onclick={() => save(300, snapshot.idleCompaction)}>Reset</Button></div>{/snippet}
  </SettingsRow>
  <SettingsRow label="Default idle compaction" description="Claude can ask to compact an old session when you return. Each Claude instance can override this choice.">
    {#snippet control()}<SettingsSelect value={snapshot.idleCompaction} options={[{ value: "onReturn", label: "Ask on return" }, { value: "off", label: "Never" }]} onSelect={(value) => save(snapshot.healthCheckSeconds, value)} ariaLabel="Default idle compaction" />{/snippet}
  </SettingsRow>
</SettingsSection>
