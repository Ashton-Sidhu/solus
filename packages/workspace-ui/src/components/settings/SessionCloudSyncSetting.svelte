<script lang="ts">
  import { sessionCloudSyncSwitchState } from "@solus/contracts/host-policies";
  import { hostSettingsStore } from "../../contexts/app/host-settings.store.svelte";
  import { policiesOn } from "../../contexts/policy/work-policy.svelte";
  import { Switch } from "../ui/switch";
  import SettingsRow from "./SettingsRow.svelte";

  let { serverId }: { serverId: string } = $props();
  const state = $derived(hostSettingsStore.states.get(serverId));
  const view = $derived(sessionCloudSyncSwitchState(policiesOn(serverId), state?.sessionCloudSync ?? true));
  const managed = $derived(view.lockedBy ? { lockedEverywhere: true, lines: [view.lockedBy] } : undefined);
</script>

<SettingsRow
  label="Save sessions to Solus Cloud"
  description="Upload the full conversation and code that is not committed. Applies to this host."
  {managed}
  bodyVisible={!!state?.error}
>
  {#snippet control()}
    <Switch
      checked={view.checked}
      disabled={!state || state.saving || !!view.lockedBy}
      onCheckedChange={(next) => void hostSettingsStore.setSessionCloudSync(serverId, next)}
      aria-label="Save sessions to Solus Cloud"
    />
  {/snippet}
  {#snippet body()}
    <p class="text-xs text-destructive" role="alert">{state?.error}</p>
  {/snippet}
</SettingsRow>
