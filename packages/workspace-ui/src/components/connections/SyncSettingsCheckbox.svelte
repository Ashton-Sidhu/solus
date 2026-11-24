<script lang="ts">
  import { Checkbox } from "../ui/checkbox";
  import { settingsSyncStore } from "../../contexts/app/settings-sync.store.svelte";

  // The Sync settings checkbox of an add or pair flow (docs/plans/settings-sync-hosts.md).
  // Each flow turns it on when it opens (`settingsSyncStore.startAdd`). Signed in, the
  // account keeps every host the same, so it does not show.
  const id = $props.id();
</script>

{#if !settingsSyncStore.isSignedIn}
  <div class="flex items-start gap-2.5">
    <Checkbox
      id="{id}-sync-settings"
      checked={settingsSyncStore.copyOnAdd}
      onCheckedChange={(checked) => (settingsSyncStore.copyOnAdd = checked === true)}
      class="mt-0.5"
    />
    <label for="{id}-sync-settings" class="flex min-w-0 cursor-pointer flex-col gap-0.5">
      <span class="text-workspace-chrome text-foreground">Sync settings</span>
      <span class="text-chrome-dense text-muted-foreground">Copy your settings to this host, and keep them the same on your hosts.</span>
    </label>
  </div>
{/if}
