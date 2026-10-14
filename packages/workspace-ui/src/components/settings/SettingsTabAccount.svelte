<script module lang="ts">
  /** Search words, read by the settings page to find this page from any other. */
  export const searchWords = ["account", "sync", "personal", "cloud", "sign", "devices", "conflict", "clear", "link", "computer", "hosts", "profile", "copy"];
</script>

<script lang="ts">
  /**
   * Settings → Account & sync (plans/018 decision 9): the one place for the
   * account. Who is signed in; this computer's link to Solus Cloud; one sync
   * status for the two synced documents, the settings and the agent profile,
   * with the settings' conflicts resolved here and the profile's on its own
   * tab; the two clear actions; and each host with what it holds of the
   * profile. Signed in is synced: there is no switch. The page needs no host.
   */
  import { untrack } from "svelte";
  import { accountStore, accountSyncStore, getWorkspaceContext, serversStore } from "../../contexts";
  import UplinkSection from "../connections/UplinkSection.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import AgentProfileHostsSection from "./agent-profile/AgentProfileHostsSection.svelte";
  import { agentProfileKeyLabel } from "./agent-profile/lib/agent-profile-entries";
  import { accountSyncStateLabel, conflictRows, settingKeyLabel } from "./lib/sync-status";

  let { searchQuery = "" }: { searchQuery?: string } = $props();

  const session = getWorkspaceContext();
  const sync = accountSyncStore;
  const account = $derived(accountStore.state);
  const isSignedIn = $derived(sync.state !== "signed-out");
  const settingConflicts = $derived(conflictRows(sync.settings.conflicts));
  const profileConflictCount = $derived(sync.profile.conflicts.length);
  // Only the desktop hosts a server on this computer; a browser has none to link.
  const localServerId = $derived(serversStore.servers.find((server) => server.local)?.id ?? null);
  const hasComputer = $derived(localServerId !== null);
  const statusText = $derived(
    sync.lastSyncedAt ? `${accountSyncStateLabel(sync)} · Last synced ${relativeTime(sync.lastSyncedAt)}` : accountSyncStateLabel(sync),
  );

  // Settings opened: read the account now rather than at the next poll, and try a start that failed again.
  $effect(() => untrack(() => sync.refresh()));

  async function clearSettings(discardUnsent: boolean) {
    await sync.clearSettings(discardUnsent);
    requestInputFocus();
  }

  async function clearProfile(discardUnsent: boolean) {
    await sync.clearProfile(discardUnsent);
    requestInputFocus();
  }

  function retry() {
    sync.refresh();
    requestInputFocus();
  }

  const isVisible = $derived(!searchQuery || searchWords.some((keyword) => keyword.includes(searchQuery.toLowerCase())));
</script>

<SettingsSection label="Account" visible={isVisible}>
  <SettingsRow
    label={account.kind === "signed-in" ? (account.identity.name ?? account.identity.email) : "Not signed in"}
    description={account.kind === "signed-in"
      ? `${account.identity.email} · ${account.consoleUrl.replace(/^https?:\/\//, "")}`
      : "Your settings and your agent profile stay on this device. Sign in to Solus to sync them between your devices and the hosts you work on."}
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
  label="Sync"
  description="Signed in, your settings and your agent profile sync through your account. Device settings, host settings, and credentials never sync."
  visible={isVisible}
>
  <SettingsRow
    label={isSignedIn ? "Synced with your account" : "Not signed in"}
    description={isSignedIn ? statusText : "Sign in to Solus to sync."}
    testId="account-sync-row"
  >
    {#snippet control()}
      {#if sync.state === "error" || sync.state === "offline"}
        <Button variant="outline" size="sm" disabled={sync.busy || !sync.isAvailable} onclick={retry}>Try again</Button>
      {/if}
    {/snippet}
    {#snippet body()}
      <div class="flex flex-col gap-3" aria-live="polite">
        {#if sync.notice}
          <p
            class="text-xs {sync.notice.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}"
            role={sync.notice.kind === "error" ? "alert" : "status"}
          >
            {#if sync.notice.kind === "offline"}
              You are offline. Nothing changed; try again when you reconnect.
            {:else if sync.notice.kind === "error"}
              {sync.notice.message}
            {:else if sync.notice.kind === "cleared"}
              {sync.notice.document === "settings" ? "Synced settings were" : "The synced profile was"} cleared and started again from {sync.notice.document === "profile" && hasComputer ? "this computer's profile" : "this device's copy"}. Your other devices take the new copy.
            {:else if sync.notice.kind === "has-unsent"}
              {sync.notice.keys.length === 1 ? "1 change" : `${sync.notice.keys.length} changes`} to your {sync.notice.document === "settings" ? "settings" : "agent profile"} on this device did not sync yet ({sync.notice.document === "settings" ? sync.notice.keys.map(settingKeyLabel).join(", ") : sync.notice.keys.map(agentProfileKeyLabel).join(", ")}). Clearing discards them from your account.
            {/if}
          </p>
        {/if}
        {#if settingConflicts.length > 0}
          <ul class="flex flex-col gap-2" aria-label="Settings changed on two devices">
            {#each settingConflicts as conflict (conflict.key)}
              <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <span class="min-w-0 text-xs text-foreground">
                  <span class="font-medium">{conflict.label}</span>
                  <span class="text-muted-foreground"> · This device: {conflict.mine} · Synced: {conflict.theirs}</span>
                </span>
                <span class="flex gap-1.5">
                  <Button variant="outline" size="xs" onclick={() => sync.resolveSettingConflict(conflict.key, "keep-mine")}>Keep mine</Button>
                  <Button variant="outline" size="xs" onclick={() => sync.resolveSettingConflict(conflict.key, "take-theirs")}>Use synced</Button>
                </span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if profileConflictCount > 0}
          <p class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-xs text-foreground" role="status">
            <span>{profileConflictCount === 1 ? "1 entry" : `${profileConflictCount} entries`} of your agent profile changed on two devices.</span>
            <Button variant="outline" size="xs" onclick={() => session.showSettings("agent-profile", "click")}>Resolve in Agent profile</Button>
          </p>
        {/if}
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Clear synced settings"
    description="Deletes the copy in your account and starts it again from this device's settings. Your other devices take the new copy."
    visible={isSignedIn}
  >
    {#snippet control()}
      {#if sync.notice?.kind === "has-unsent" && sync.notice.document === "settings"}
        <Button variant="destructive" size="sm" disabled={sync.busy} onclick={() => void clearSettings(true)}>Discard and clear</Button>
      {:else}
        <Button variant="outline" size="sm" disabled={sync.busy || !sync.isAvailable} onclick={() => void clearSettings(false)}>Clear</Button>
      {/if}
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Clear synced profile"
    description={`Deletes the copy in your account and starts it again from ${hasComputer ? "this computer's profile" : "this device's copy"}. Your other devices and every host take the new copy.`}
    visible={isSignedIn}
  >
    {#snippet control()}
      {#if sync.notice?.kind === "has-unsent" && sync.notice.document === "profile"}
        <Button variant="destructive" size="sm" disabled={sync.busy} onclick={() => void clearProfile(true)}>Discard and clear</Button>
      {:else}
        <Button variant="outline" size="sm" disabled={sync.busy || !sync.isAvailable} onclick={() => void clearProfile(false)}>Clear</Button>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if isVisible}
  <AgentProfileHostsSection />
{/if}
