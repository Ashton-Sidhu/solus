<script lang="ts">
  /**
   * Settings → Agent profile → Changed on two devices: one row per entry this
   * device and another changed, resolved here, beside the content, with
   * "Keep mine" or "Take theirs". Nothing when there is no conflict.
   */
  import { accountSyncStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import SettingsSection from "../SettingsSection.svelte";
  import { conflictRows } from "./lib/agent-profile-entries";
  import type { AgentProfileKey } from "@solus/contracts/agent-profile";

  const conflicts = $derived(conflictRows(accountSyncStore.profile.conflicts));

  function resolve(key: AgentProfileKey, choice: "keep-mine" | "take-theirs") {
    accountSyncStore.resolveProfileConflict(key, choice);
    requestInputFocus();
  }
</script>

<SettingsSection
  label="Changed on two devices"
  description="This device and another changed the same entry. Pick the one to keep; the other devices and every host follow."
  visible={conflicts.length > 0}
>
  <ul class="flex flex-col gap-2 p-3" aria-label="Entries changed on two devices" data-testid="agent-profile-conflicts">
    {#each conflicts as conflict (conflict.key)}
      <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
        <span class="min-w-0 text-xs text-foreground">
          <span class="font-medium">{conflict.label}</span>
          <span class="text-muted-foreground"> · This device: {conflict.mine} · Synced: {conflict.theirs}</span>
        </span>
        <span class="flex gap-1.5">
          <Button variant="outline" size="xs" onclick={() => resolve(conflict.key, "keep-mine")}>Keep mine</Button>
          <Button variant="outline" size="xs" onclick={() => resolve(conflict.key, "take-theirs")}>Take theirs</Button>
        </span>
      </li>
    {/each}
  </ul>
</SettingsSection>
