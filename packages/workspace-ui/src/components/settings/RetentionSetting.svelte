<script lang="ts">
  import { untrack } from "svelte";
  import { Input } from "../ui/input";
  import SettingsRow from "./SettingsRow.svelte";
  import type { HostRetentionStore } from "../../contexts/hosts/host-retention.store.svelte";

  let {
    serverId,
    store,
    label,
    description,
    inputLabel,
    visible = true,
  }: {
    serverId: string;
    store: HostRetentionStore;
    label: string;
    description: string;
    inputLabel: string;
    visible?: boolean;
  } = $props();
  const state = $derived(store.states.get(serverId));
  $effect(() => {
    const hostId = serverId;
    const target = store;
    return untrack(() => target.watch(hostId));
  });
</script>

<SettingsRow {label} {description} {visible}>
  {#snippet control()}
    <div class="flex items-center gap-2 text-workspace-chrome text-muted-foreground">
      <Input
        type="number"
        min={1}
        max={3650}
        step={1}
        value={state?.days ?? ""}
        disabled={state?.days == null || state.saving}
        aria-label={inputLabel}
        class="w-20 tabular-nums"
        onchange={(event) => void store.save(serverId, Number(event.currentTarget.value))}
      />
      <span>{state?.saving ? "Saving…" : "days"}</span>
    </div>
  {/snippet}
</SettingsRow>
