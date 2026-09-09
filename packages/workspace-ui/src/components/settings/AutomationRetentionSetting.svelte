<script lang="ts">
  import { untrack } from "svelte";
  import { Input } from "../ui/input";
  import SettingsRow from "./SettingsRow.svelte";
  import { automationRetentionStore as store } from "../../contexts/automations/automation-retention.store.svelte";

  let { serverId, visible = true }: { serverId: string; visible?: boolean } = $props();
  const state = $derived(store.states.get(serverId));
  $effect(() => {
    const hostId = serverId;
    return untrack(() => store.watch(hostId));
  });
</script>

<SettingsRow
  label="Delete archived automations after"
  description="Days to keep archived automations and their run history on this host. Default: 30 days. Conversations are kept. Shortening this period applies to existing archives."
  {visible}
>
  {#snippet control()}
    <div class="flex items-center gap-2 text-workspace-chrome text-muted-foreground">
      <Input
        type="number"
        min={1}
        max={3650}
        step={1}
        value={state?.days ?? ""}
        disabled={state?.days == null || state.saving}
        aria-label="Archived automation retention in days"
        class="w-20 tabular-nums"
        onchange={(event) => void store.save(serverId, Number(event.currentTarget.value))}
      />
      <span>{state?.saving ? "Saving…" : "days"}</span>
    </div>
  {/snippet}
  {#snippet body()}
    {#if state?.error}
      <div class="flex items-center gap-2 text-workspace-chrome" role="status">
        <span class="text-destructive">{state.error}</span>
        <button type="button" class="underline" onclick={() => store.load(serverId)}>Retry</button>
      </div>
    {/if}
  {/snippet}
</SettingsRow>
