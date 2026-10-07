<script module lang="ts">
  /** Search words, read by the settings page to find this page from any other. */
  export const searchWords = ["account", "sync", "personal", "cloud", "sign", "devices", "conflict", "clear", "link", "computer"];
</script>

<script lang="ts">
  /** Personal: who is signed in, whether this computer is linked to their
   *  Solus Cloud account, and whether this device syncs their settings. The
   *  profile needs no host: it lives on this device and in the account. */
  import { untrack } from "svelte";
  import { accountStore, serversStore } from "../../contexts";
  import UplinkSection from "../connections/UplinkSection.svelte";
  import { settingsSyncStore } from "../../contexts/app/settings-sync.store.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import { conflictRows, isSyncOn, settingKeyLabel, syncStateLabel } from "./lib/sync-status";

  let { searchQuery = "" }: { searchQuery?: string } = $props();

  const sync = settingsSyncStore;
  const status = $derived(sync.status);
  const syncOn = $derived(isSyncOn(status));
  const account = $derived(accountStore.state);
  const conflicts = $derived(conflictRows(status.conflicts));
  // Only the desktop hosts a server on this computer; a browser has none to link.
  const localServerId = $derived(serversStore.servers.find((server) => server.local)?.id ?? null);

  // Settings opened: read the account now rather than at the next poll.
  $effect(() => untrack(() => sync.refresh()));

  function setSyncEnabled(next: boolean) {
    if (next) void sync.beginEnable();
    else {
      sync.turnOff();
      requestInputFocus();
    }
  }

  async function choose(choice: "use-synced" | "replace" | "seed") {
    await sync.choose(choice);
    requestInputFocus();
  }

  function cancelEnable() {
    sync.cancelEnable();
    requestInputFocus();
  }

  const isVisible = $derived(!searchQuery || searchWords.some((keyword) => keyword.includes(searchQuery.toLowerCase())));
</script>

<SettingsSection label="Account" visible={isVisible}>
  <SettingsRow
    label={account.kind === "signed-in" ? (account.profile.name ?? account.profile.email) : "Not signed in"}
    description={account.kind === "signed-in"
      ? `${account.profile.email} · ${account.consoleUrl.replace(/^https?:\/\//, "")}`
      : "Your settings stay on this device. Sign in to Solus to sync them between your devices."}
  >
    {#snippet control()}
      {#if account.kind !== "signed-in" && accountStore.isAvailable}
        <Button variant="outline" size="sm" onclick={() => void accountStore.signIn()}>Sign in</Button>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if localServerId && isVisible}
  <UplinkSection serverId={localServerId} label="This computer" />
{/if}

<SettingsSection
  label="Settings sync"
  description="Off until you turn it on here. Device settings, host settings, and credentials never sync."
  visible={isVisible}
>
  <SettingsRow
    label="Sync settings on this device"
    description={status.state === "signed-out"
      ? "Sign in to Solus to sync."
      : status.lastSyncedAt
        ? `${syncStateLabel(status)} · Last synced ${relativeTime(status.lastSyncedAt)}`
        : syncStateLabel(status)}
  >
    {#snippet control()}
      <Switch
        checked={syncOn || sync.offer !== null}
        disabled={status.state === "signed-out" || !sync.isAvailable || sync.busy}
        onCheckedChange={setSyncEnabled}
        aria-label="Sync settings on this device"
      />
    {/snippet}
    {#snippet body()}
      <div class="flex flex-col gap-3" aria-live="polite">
        {#if status.stoppedReason === "generation-changed" && !syncOn}
          <p class="text-xs text-muted-foreground" role="status">
            Synced settings were cleared on another device, so sync turned off here. Your settings on this device stay. Turn sync on again to start over.
          </p>
        {/if}
        {#if sync.offer}
          <div
            class="flex flex-col gap-2.5 rounded-lg border border-border bg-(--wash-1) p-3"
            role="group"
            aria-label="Turn on settings sync"
            data-testid="settings-sync-first-enable"
          >
            {#if sync.offer.kind === "present"}
              <p class="text-xs text-foreground">
                Your account already has synced settings{sync.offer.updatedAt ? `, last changed ${relativeTime(sync.offer.updatedAt)}` : ""}. Use them here, or replace them with this device's settings.
              </p>
              <div class="flex flex-wrap gap-2">
                <Button size="sm" disabled={sync.busy} onclick={() => void choose("use-synced")}>Use synced settings</Button>
                <Button variant="outline" size="sm" disabled={sync.busy} onclick={() => void choose("replace")}>Replace with this device</Button>
                <Button variant="ghost" size="sm" disabled={sync.busy} onclick={cancelEnable}>Cancel</Button>
              </div>
            {:else}
              <p class="text-xs text-foreground">
                Your account has no synced settings yet. This device's settings become the first copy.
              </p>
              <div class="flex flex-wrap gap-2">
                <Button size="sm" disabled={sync.busy} onclick={() => void choose("seed")}>Start syncing from this device</Button>
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
              Your synced settings changed while you chose. Choose again.
            {:else if sync.notice.kind === "cleared"}
              Synced settings are cleared. Your settings on this device stay.
            {:else if sync.notice.kind === "has-unsent"}
              {sync.notice.keys.length === 1 ? "1 change" : `${sync.notice.keys.length} changes`} on this device did not sync yet ({sync.notice.keys.map(settingKeyLabel).join(", ")}). Clearing discards them from your account.
            {/if}
          </p>
        {/if}
        {#if conflicts.length > 0}
          <ul class="flex flex-col gap-2" aria-label="Settings changed on two devices">
            {#each conflicts as conflict (conflict.key)}
              <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <span class="min-w-0 text-xs text-foreground">
                  <span class="font-medium">{conflict.label}</span>
                  <span class="text-muted-foreground"> · This device: {conflict.mine} · Synced: {conflict.theirs}</span>
                </span>
                <span class="flex gap-1.5">
                  <Button variant="outline" size="xs" onclick={() => sync.resolveConflict(conflict.key, "keep-mine")}>Keep mine</Button>
                  <Button variant="outline" size="xs" onclick={() => sync.resolveConflict(conflict.key, "take-theirs")}>Use synced</Button>
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
      label="Clear synced settings"
      description="Deletes the copy in your account. Every device stops syncing; their own settings stay."
    >
      {#snippet control()}
        {#if sync.notice?.kind === "has-unsent"}
          <Button variant="destructive" size="sm" disabled={sync.busy} onclick={() => void sync.clearCloud(true)}>Discard and clear</Button>
        {:else}
          <Button variant="outline" size="sm" disabled={sync.busy || !sync.isAvailable} onclick={() => void sync.clearCloud()}>Clear</Button>
        {/if}
      {/snippet}
    </SettingsRow>
  {/if}
</SettingsSection>
