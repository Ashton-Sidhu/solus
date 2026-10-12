<script lang="ts">
  /**
   * Settings → Agent profile → Sync: whether this device syncs the profile with
   * the person's account, the first-enable offer, the last notice, and a row
   * per entry both devices changed. The same controls and states as Settings →
   * Personal; the seed differs: the desktop offers this computer's profile,
   * the web has no computer and offers its local copy.
   */
  import { untrack } from "svelte";
  import { accountStore, agentProfileLocalStore, agentProfileSyncStore, hosts } from "../../../contexts";
  import { relativeTime } from "../../../lib/relative-time";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import { Switch } from "../../ui/switch";
  import SettingsSection from "../SettingsSection.svelte";
  import SettingsRow from "../SettingsRow.svelte";
  import { agentProfileKeyLabel, conflictRows, profileSyncStateLabel } from "./lib/agent-profile-entries";

  const sync = agentProfileSyncStore;
  const status = $derived(sync.status);
  const syncOn = $derived(sync.isOn);
  const conflicts = $derived(conflictRows(status.conflicts));
  // "This device" seeds from the computer on the desktop; the web client has only its local copy.
  const hasComputer = $derived(hosts.device !== null);
  const seedLabel = $derived(
    hasComputer ? "Start with this computer's profile" : agentProfileLocalStore.entryCount > 0 ? "Start with this device's copy" : "Start empty",
  );

  // Settings opened: read the account now rather than at the next poll.
  $effect(() => untrack(() => sync.refresh()));

  function setSyncEnabled(next: boolean) {
    if (next) void sync.prepareEnable();
    else {
      sync.turnOff();
      requestInputFocus();
    }
  }

  async function choose(choice: "use-synced" | "replace" | "seed") {
    await sync.enable(choice);
    requestInputFocus();
  }

  function cancelEnable() {
    sync.cancelEnable();
    requestInputFocus();
  }
</script>

<SettingsSection
  label="Profile sync"
  description="Off until you turn it on here. With sync on, every host you work on pulls the profile from your account."
>
  <SettingsRow
    label="Sync the agent profile on this device"
    description={status.state === "signed-out"
      ? "Sign in to Solus to sync."
      : status.lastSyncedAt
        ? `${profileSyncStateLabel(status)} · Last synced ${relativeTime(status.lastSyncedAt)}`
        : profileSyncStateLabel(status)}
    testId="agent-profile-sync-row"
  >
    {#snippet control()}
      <Switch
        checked={syncOn || sync.offer !== null}
        disabled={status.state === "signed-out" || !sync.isAvailable || sync.busy}
        onCheckedChange={setSyncEnabled}
        aria-label="Sync the agent profile on this device"
      />
    {/snippet}
    {#snippet body()}
      <div class="flex flex-col gap-3" aria-live="polite">
        {#if status.stoppedReason === "generation-changed" && !syncOn}
          <p class="text-xs text-muted-foreground" role="status">
            The synced profile was cleared on another device, so sync turned off here. Your copy on this device stays. Turn sync on again to start over.
          </p>
        {/if}
        {#if sync.offer}
          <div
            class="flex flex-col gap-2.5 rounded-lg border border-border bg-(--wash-1) p-3"
            role="group"
            aria-label="Turn on profile sync"
            data-testid="agent-profile-sync-first-enable"
          >
            {#if sync.offer.kind === "present"}
              <p class="text-xs text-foreground">
                Your account already has a synced profile{sync.offer.updatedAt ? `, last changed ${relativeTime(sync.offer.updatedAt)}` : ""}. Use it here, or replace it with {hasComputer ? "this computer's profile" : "this device's copy"}.
              </p>
              <div class="flex flex-wrap gap-2">
                <Button size="sm" disabled={sync.busy} onclick={() => void choose("use-synced")}>Use synced</Button>
                <Button variant="outline" size="sm" disabled={sync.busy} onclick={() => void choose("replace")}>Replace with this device</Button>
                <Button variant="ghost" size="sm" disabled={sync.busy} onclick={cancelEnable}>Cancel</Button>
              </div>
            {:else}
              <p class="text-xs text-foreground">
                Your account has no synced profile yet. {hasComputer ? "This computer's profile becomes the first copy." : "This device's copy becomes the first one."}
              </p>
              <div class="flex flex-wrap gap-2">
                <Button size="sm" disabled={sync.busy} onclick={() => void choose("seed")}>{seedLabel}</Button>
                <Button variant="ghost" size="sm" disabled={sync.busy} onclick={cancelEnable}>Cancel</Button>
              </div>
            {/if}
          </div>
        {/if}
        {#if sync.notice}
          <p
            class="text-xs {sync.notice.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}"
            role={sync.notice.kind === "error" ? "alert" : "status"}
          >
            {#if sync.notice.kind === "offline"}
              You are offline. Nothing changed; try again when you reconnect.
            {:else if sync.notice.kind === "error"}
              {sync.notice.message}
            {:else if sync.notice.kind === "changed"}
              Your synced profile changed while you chose. Choose again.
            {:else if sync.notice.kind === "cleared"}
              The synced profile is cleared. Your copy on this device stays.
            {:else if sync.notice.kind === "has-unsent"}
              {sync.notice.keys.length === 1 ? "1 change" : `${sync.notice.keys.length} changes`} on this device did not sync yet ({sync.notice.keys.map(agentProfileKeyLabel).join(", ")}). Clearing discards them from your account.
            {/if}
          </p>
        {/if}
        {#if conflicts.length > 0}
          <ul class="flex flex-col gap-2" aria-label="Entries changed on two devices">
            {#each conflicts as conflict (conflict.key)}
              <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <span class="min-w-0 text-xs text-foreground">
                  <span class="font-medium">{conflict.label}</span>
                  <span class="text-muted-foreground"> · This device: {conflict.mine} · Synced: {conflict.theirs}</span>
                </span>
                <span class="flex gap-1.5">
                  <Button variant="outline" size="xs" onclick={() => sync.resolveConflict(conflict.key, "keep-mine")}>Keep mine</Button>
                  <Button variant="outline" size="xs" onclick={() => sync.resolveConflict(conflict.key, "take-theirs")}>Take theirs</Button>
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/snippet}
  </SettingsRow>

  {#if status.state !== "signed-out"}
    <SettingsRow
      label="Clear synced profile"
      description="Deletes the copy in your account. Every device stops syncing; their own copies stay."
    >
      {#snippet control()}
        {#if sync.notice?.kind === "has-unsent"}
          <Button variant="destructive" size="sm" disabled={sync.busy} onclick={() => void sync.clearCloud(true)}>Discard and clear</Button>
        {:else}
          <Button variant="outline" size="sm" disabled={sync.busy || !sync.isAvailable} onclick={() => void sync.clearCloud()}>Clear</Button>
        {/if}
      {/snippet}
    </SettingsRow>
  {:else if accountStore.isAvailable}
    <SettingsRow label="Not signed in" description="Sign in to Solus to sync your profile between your devices and hosts.">
      {#snippet control()}
        <Button variant="outline" size="sm" onclick={() => void accountStore.signIn()}>Sign in</Button>
      {/snippet}
    </SettingsRow>
  {/if}
</SettingsSection>
