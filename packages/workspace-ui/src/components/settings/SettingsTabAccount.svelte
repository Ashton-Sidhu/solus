<script module lang="ts">
  /** Search words, read by the settings page to find this page from any other. */
  export const searchWords = ["account", "sync", "personal", "cloud", "sign", "devices", "conflict", "clear", "link", "computer", "hosts", "profile", "copy"];
</script>

<script lang="ts">
  /**
   * Settings → Account & sync (plans/018 decision 9): the one place for the
   * account. Who is signed in, with sign out; this computer's link to Solus
   * Cloud; one sync status for the two synced documents, the settings and the
   * agent profile, with the settings' conflicts resolved here and the
   * profile's on its own tab; each host with what it holds of the profile;
   * and, last, the two clear actions. Signed in is synced: there is no
   * switch. The page needs no host.
   */
  import { untrack } from "svelte";
  import { RefreshCw as SyncIcon } from "@lucide/svelte";
  import { accountStore, accountSyncStore, getWorkspaceContext, serversStore } from "../../contexts";
  import UplinkSection from "../connections/UplinkSection.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import { messageTimestampClock } from "../../lib/shared-clock";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { accountInitial } from "../session/lib/account-menu";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import AgentProfileHostsSection from "./agent-profile/AgentProfileHostsSection.svelte";
  import { agentProfileKeyLabel } from "./agent-profile/lib/agent-profile-entries";
  import { accountSyncBadge, accountSyncStateLabel, accountSyncTone, conflictRows, settingKeyLabel } from "./lib/sync-status";

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
  let now = $state(Date.now());
  const statusTone = $derived(accountSyncTone(sync.state));
  // The badge already says "Synced"; the line under it says when, or what is wrong.
  const statusText = $derived.by(() => {
    const lastSynced = sync.lastSyncedAt ? `Last synced ${relativeTime(sync.lastSyncedAt, now)}` : null;
    if (sync.state === "synced") return lastSynced ?? "Up to date";
    return lastSynced ? `${accountSyncStateLabel(sync)} · ${lastSynced}` : accountSyncStateLabel(sync);
  });
  const hasSyncDetail = $derived(sync.notice !== null || settingConflicts.length > 0 || profileConflictCount > 0);

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

  function syncNow() {
    sync.refresh();
    requestInputFocus();
  }

  const isVisible = $derived(!searchQuery || searchWords.some((keyword) => keyword.includes(searchQuery.toLowerCase())));

  // "Last synced" is an age: it moves on the shared minute clock while it shows, not only when a sync lands.
  $effect(() => {
    if (!sync.lastSyncedAt || !isVisible) return;
    return messageTimestampClock.subscribe((value) => { now = value; });
  });
</script>

<SettingsSection label="Account" visible={isVisible}>
  {#if account.kind === "signed-in"}
    <div class="flex flex-wrap items-center gap-3 px-4 py-3.5">
      {#if account.identity.picture}
        <img
          src={account.identity.picture}
          alt=""
          class="size-9 shrink-0 rounded-full object-cover shadow-[0_0_0_1px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
        />
      {:else}
        <span
          class="flex size-9 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--primary)_16%,transparent)] text-sm font-semibold text-[color-mix(in_oklch,var(--primary)_80%,var(--foreground))]"
          aria-hidden="true">{accountInitial(account.identity)}</span
        >
      {/if}
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium tracking-[-0.005em] text-foreground">{account.identity.name ?? account.identity.email}</p>
        <p class="truncate text-[13px] leading-[1.45] text-(--solus-text-secondary)">
          {account.identity.name ? `${account.identity.email} · ` : ""}{account.consoleUrl.replace(/^https?:\/\//, "")}
        </p>
      </div>
      <Button variant="outline" size="sm" onclick={() => void accountStore.signOut()}>Sign out</Button>
    </div>
  {:else}
    <SettingsRow
      label="Not signed in"
      description="Your settings and your agent profile stay on this device. Sign in to Solus to sync them between your devices and the hosts you work on."
    >
      {#snippet control()}
        {#if accountStore.isAvailable}
          <Button variant="outline" size="sm" onclick={() => void accountStore.signIn()}>Sign in</Button>
        {/if}
      {/snippet}
    </SettingsRow>
  {/if}
</SettingsSection>

{#if localServerId && isVisible}
  <UplinkSection serverId={localServerId} label="This computer" />
{/if}

<SettingsSection
  label="Sync"
  description="Your settings and your agent profile sync through your account. Device settings, host settings, and credentials never sync."
  visible={isVisible && isSignedIn}
>
  <SettingsRow
    label="Settings and agent profile"
    labelExtra={statusBadge}
    description={statusText}
    testId="account-sync-row"
    bodyVisible={hasSyncDetail}
  >
    {#snippet control()}
      <Button variant="outline" size="sm" disabled={sync.busy || !sync.isAvailable || sync.state === "loading"} onclick={syncNow}>
        <SyncIcon size={13} class={sync.state === "loading" ? "animate-spin motion-reduce:animate-none" : ""} />
        {sync.state === "error" || sync.state === "offline" ? "Try again" : "Sync now"}
      </Button>
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
</SettingsSection>

{#if isVisible}
  <AgentProfileHostsSection />
{/if}

<SettingsSection
  label="Reset sync"
  description="Clearing deletes the copy in your account and starts it again from this device. Do this only when the synced copy is wrong."
  visible={isVisible && isSignedIn}
>
  <SettingsRow
    label="Synced settings"
    description="Your other devices take the new copy."
  >
    {#snippet control()}
      {#if sync.notice?.kind === "has-unsent" && sync.notice.document === "settings"}
        <Button variant="destructive" size="sm" disabled={sync.busy} onclick={() => void clearSettings(true)}>Discard and clear</Button>
      {:else}
        <Button variant="outline" size="sm" class="text-destructive" disabled={sync.busy || !sync.isAvailable} onclick={() => void clearSettings(false)}>Clear settings</Button>
      {/if}
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Synced agent profile"
    description={`Starts again from ${hasComputer ? "this computer's profile" : "this device's copy"}. Your other devices and every host take the new copy.`}
  >
    {#snippet control()}
      {#if sync.notice?.kind === "has-unsent" && sync.notice.document === "profile"}
        <Button variant="destructive" size="sm" disabled={sync.busy} onclick={() => void clearProfile(true)}>Discard and clear</Button>
      {:else}
        <Button variant="outline" size="sm" class="text-destructive" disabled={sync.busy || !sync.isAvailable} onclick={() => void clearProfile(false)}>Clear profile</Button>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#snippet statusBadge()}
  <span
    class="ml-2 inline-flex translate-y-[-1px] items-center gap-1 rounded-full px-1.5 py-px align-middle text-[11px] leading-[1.5] font-medium {statusTone === 'settled'
      ? 'bg-[color-mix(in_oklch,var(--success)_14%,transparent)] text-(--success)'
      : statusTone === 'attention'
        ? 'bg-[color-mix(in_oklch,var(--warning)_16%,transparent)] text-(--warning)'
        : statusTone === 'stopped'
          ? 'bg-[color-mix(in_oklch,var(--destructive)_14%,transparent)] text-destructive'
          : 'bg-muted text-muted-foreground'}"
  >
    <span class="size-1.5 rounded-full bg-current" aria-hidden="true"></span>
    {accountSyncBadge(sync)}
  </span>
{/snippet}
