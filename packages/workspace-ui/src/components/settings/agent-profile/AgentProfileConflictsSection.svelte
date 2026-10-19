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
  import ProfileEntryRow from "./ProfileEntryRow.svelte";
  import { GitCompare } from "@lucide/svelte";
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
  {#each conflicts as conflict (conflict.key)}
    <ProfileEntryRow label={conflict.label} detail="This device: {conflict.mine} · Synced: {conflict.theirs}" testId="agent-profile-conflict">
      {#snippet mark()}
        <span class="grid size-8 shrink-0 place-items-center rounded-lg border border-border/50 bg-muted text-(--solus-status-permission)" aria-hidden="true"><GitCompare size={15} /></span>
      {/snippet}
      {#snippet action()}
        <Button variant="outline" size="sm" class="text-workspace-chrome shadow-xs pointer-coarse:min-h-11" onclick={() => resolve(conflict.key, "keep-mine")} aria-label="Keep this device's {conflict.label}">Keep mine</Button>
        <Button variant="outline" size="sm" class="text-workspace-chrome shadow-xs pointer-coarse:min-h-11" onclick={() => resolve(conflict.key, "take-theirs")} aria-label="Take the synced {conflict.label}">Take theirs</Button>
      {/snippet}
    </ProfileEntryRow>
  {/each}
</SettingsSection>
