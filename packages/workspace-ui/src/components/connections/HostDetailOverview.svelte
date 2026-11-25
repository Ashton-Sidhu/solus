<script lang="ts">
  import HostUpdateRow from "./HostUpdateRow.svelte";
  /** Where a host stands (docs/plans/host-fleet.md D2): what runs on it, the
   *  machine, its readiness, and the one way to remove it that fits its kind.
   *  Each readiness row is a way into the tab that can change it. */
  import { Check as CheckIcon, Copy as CopyIcon, FolderGit2 as WorktreeIcon, GitBranch as GitBranchIcon } from "@lucide/svelte";
  import { getSessionSidebarStore, getWorkspaceContext, managedHostsStore, serversStore, uplinkStore, type ServerItem } from "../../contexts";
  import { hosts } from "../../contexts/hosts/hosts.svelte";
  import { liveActivityClock } from "../../lib/shared-clock";
  import PresenceStack from "../presence/PresenceStack.svelte";
  import { formatCompactElapsed } from "../project-panel/lib/rail-agents";
  import SessionStatusGlyph from "../session/SessionStatusGlyph.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import TaskIcon from "../ui/TaskIcon.svelte";
  import { GitPullRequestIcon } from "../ui/octicons";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import { runningSessionRows } from "./lib/running-sessions";
  import { isManagedHost } from "../servers/lib/managed-host";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import { settingsSyncStore } from "../../contexts/app/settings-sync.store.svelte";
  import { toasts } from "../../lib/toasts";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import { SETUP_PROVIDERS } from "../servers/lib/host-onboarding";
  import type { HostSetupSession } from "../servers/host-setup.store.svelte";

  interface Props {
    host: ServerItem;
    setup: HostSetupSession;
    onOpenTab: (tab: string) => void;
  }

  let { host, setup, onOpenTab }: Props = $props();
  let addressCopied = $state(false);
  /** Set by Test alone: the row reads "checked" only once the user asked. */
  let testing = $state(false);
  /** The danger row asks once before it acts. */
  let isConfirmingRemove = $state(false);

  const workspace = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();
  const running = $derived(runningSessionRows(workspace, sidebarStore, host.id));
  // The elapsed time ticks only while a turn runs here.
  let now = $state(Date.now());
  $effect(() => {
    if (running.length === 0) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });
  const isManaged = $derived(isManagedHost(host.uplink));
  const principal = $derived(hosts.get(host.id).me.principal);
  const isShared = $derived(!isManaged && (principal === "org-member" || principal === "guest"));

  async function remove() {
    if (isManaged) await managedHostsStore.delete(host.id);
    else await serversStore.remove(host.id);
  }

  const github = $derived(setup.readiness?.github);
  const uplink = $derived(uplinkStore.statusFor(host.id));
  const reachability = $derived(
    [
      serversStore.readinessLabelFor(host.id),
      setup.lastCheckedAt ? `checked ${relativeTime(setup.lastCheckedAt)}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  const signedInProviders = $derived(
    SETUP_PROVIDERS.filter(
      (provider) => setup.readiness?.agents?.[provider.id]?.signedIn,
    ).map((provider) => provider.label),
  );

  /**
   * Two questions, and the row answers both: a dial now decides whether the host
   * answers, and its setup is what the rest of the page is drawn from.
   */
  async function testConnection() {
    testing = true;
    try {
      await serversStore.connectNow(host.id);
      await setup.refreshReadiness();
    } finally {
      testing = false;
    }
  }

  // Signed out: whether this host takes the person's settings changes from their other hosts (docs/plans/settings-sync-hosts.md).
  const syncSettings = $derived(settingsSyncStore.switchOf(host.id));
  const isReady = $derived(serversStore.readinessFor(host.id).readiness === "ready");

  async function setSyncSettings(next: boolean) {
    try {
      await settingsSyncStore.setSwitch(host.id, next);
    } catch (error) {
      toasts.error("Could not change Sync settings", { description: error instanceof Error ? error.message : String(error) });
    }
  }

  function copyAddress() {
    void navigator.clipboard.writeText(host.url);
    addressCopied = true;
    setTimeout(() => (addressCopied = false), 1500);
  }
</script>

<SettingsSection label="Running here">
  {#each running as session (session.id)}
    <button
      type="button"
      class="flex w-full items-center gap-3 overflow-hidden px-4 py-3 text-left hover:bg-(--wash-1)"
      onclick={() => void workspace.revealSession(session.id, host.id)}
    >
      <SessionStatusGlyph attention={session.attention} live={session.live} />
      <span class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="flex min-w-0 items-center gap-2">
          <span class="min-w-0 truncate text-workspace-chrome">{session.title}</span>
          {#if session.people.length > 0}
            <PresenceStack people={session.people} size={16} max={3} activeUserId={session.activeUserId} />
          {/if}
        </span>
        <span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-chrome-dense text-muted-foreground">
          {#if session.model}
            <span class="flex shrink-0 items-center gap-1">
              <ProviderMark mark={session.providerMark} size={11} transparent />
              {session.model}
              <span class="opacity-70">· {session.effort}</span>
            </span>
          {/if}
          {#if session.branch}
            <span class="flex min-w-0 items-center gap-1" title={session.isWorktree ? "Branch in a worktree" : "Branch"}>
              {#if session.isWorktree}
                <WorktreeIcon size={12} class="shrink-0" />
              {:else}
                <GitBranchIcon size={12} class="shrink-0" />
              {/if}
              <span class="truncate">{session.branch}</span>
            </span>
          {/if}
          {#if session.pullRequest}
            <span class="flex shrink-0 items-center gap-1" title="Pull request">
              <GitPullRequestIcon size={12} class="shrink-0" />
              #{session.pullRequest.number}{#if session.pullRequest.count > 1}&nbsp;+{session.pullRequest.count - 1}{/if}
            </span>
          {/if}
          {#if session.task}
            <span class="flex min-w-0 items-center gap-1" title="Task">
              <TaskIcon size={12} class="shrink-0" />
              <span class="truncate">{session.task}</span>
            </span>
          {/if}
          {#if session.codebase || session.project}
            <span class="flex min-w-0 items-center gap-1">
              {#if session.groupKey}
                <ProjectFavicon projectKey={session.groupKey} codebaseId={session.codebaseId} class="size-3 shrink-0" />
              {/if}
              <span class="truncate" title={session.codebase ? "Codebase" : "Project"}>{session.codebase ?? session.project}</span>
            </span>
          {/if}
        </span>
      </span>
      <span class="flex shrink-0 flex-col items-end gap-1 text-chrome-dense text-muted-foreground">
        {#if session.state}
          <span class="first-letter:uppercase @max-[30rem]/pane:hidden">{session.state}</span>
        {/if}
        {#if session.runStartedAt > 0}
          <span class="font-mono tabular-nums" title="Time this turn has run">{formatCompactElapsed(now - session.runStartedAt)}</span>
        {/if}
      </span>
    </button>
  {:else}
    <p class="px-4 py-3.5 text-workspace-chrome text-muted-foreground">No sessions are running on this host.</p>
  {/each}
</SettingsSection>

<SettingsSection label="Machine">
  <HostUpdateRow {host} />
  <SettingsRow label="Reachable" description={reachability}>
    {#snippet control()}
      <Button
        variant="outline"
        size="sm"
        disabled={testing}
        onclick={() => void testConnection()}
      >
        {testing ? "Testing…" : "Test"}
      </Button>
    {/snippet}
  </SettingsRow>

  <SettingsRow label="Address" description={host.url}>
    {#snippet control()}
      <Button
        variant="ghost"
        size="icon-sm"
        onclick={copyAddress}
        aria-label="Copy host address"
      >
        {#if addressCopied}
          <CheckIcon size={13} class="text-(--solus-status-complete)" />
        {:else}
          <CopyIcon size={13} />
        {/if}
      </Button>
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if !settingsSyncStore.isSignedIn}
  <SettingsSection label="Settings">
    <SettingsRow
      label="Sync settings"
      description={!isReady
        ? "Connect to this host to change it."
        : syncSettings === false
          ? "Off · this host keeps its own settings."
          : "On · a change to your settings on a synced host also goes to this host."}
    >
      {#snippet control()}
        <Switch
          checked={syncSettings ?? true}
          disabled={!isReady || syncSettings === null || !!settingsSyncStore.saving.get(host.id)}
          onCheckedChange={(next) => void setSyncSettings(next)}
          aria-label="Sync settings"
        />
      {/snippet}
    </SettingsRow>
  </SettingsSection>
{/if}

<SettingsSection label="Readiness">
  {#if uplinkStore.controlFor(host.id) !== "none"}
    <SettingsRow
      label="Solus Cloud"
      description={!uplink
        ? "Checking the registration…"
        : !uplink.registration.registered
          ? "Not registered to your account"
          : uplink.link.linked
            ? `Registered · reachable at ${uplink.link.tunnel.hostname}`
            : "Registered · on your local network"}
    >
      {#snippet control()}
        {@render openTab("access", uplink?.registration.registered === true)}
      {/snippet}
    </SettingsRow>
  {/if}

  <SettingsRow
    label="GitHub"
    description={github?.solusToken
      ? `Connected · ${github.solusLogin ?? "this host"}`
      : "Not connected — this host cannot clone or push yet"}
  >
    {#snippet control()}
      {@render openTab("git", !!github?.solusToken)}
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Coding providers"
    description={signedInProviders.length > 0
      ? `Signed in · ${signedInProviders.join(", ")}`
      : "None signed in — this host cannot take a session yet"}
  >
    {#snippet control()}
      {@render openTab("providers", signedInProviders.length > 0)}
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Projects folder"
    description={setup.readiness?.projectsRoot ?? "Not reported by this host"}
  >
    {#snippet control()}
      {@render openTab("environment", !!setup.readiness?.projectsRoot)}
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if !host.local}
  <SettingsSection label="Danger zone">
    <SettingsRow
      label={isManaged ? "Delete this machine" : isShared ? "Remove from your hosts" : "Forget this host"}
      description={isConfirmingRemove
        ? isManaged ? `Delete ${host.label} and its disk? This cannot be undone.` : `Remove ${host.label}? You will need to pair with it again.`
        : isManaged ? "Deletes the machine and its disk. Its sessions stay in your history."
          : isShared ? "The owner keeps it. You can add it again from the organization."
            : "Removes it here and from your Solus account. Solus keeps running on it."}
    >
      {#snippet control()}
        {#if isConfirmingRemove}
          <span class="flex gap-1.5">
            <Button variant="ghost" size="sm" onclick={() => (isConfirmingRemove = false)}>Cancel</Button>
            <Button variant="destructive" size="sm" disabled={managedHostsStore.busy?.serverId === host.id} onclick={() => void remove()}>
              {isManaged ? "Delete" : "Remove"}
            </Button>
          </span>
        {:else}
          <Button variant="outline" size="sm" class="text-(--solus-status-error)" onclick={() => (isConfirmingRemove = true)}>
            {isManaged ? "Delete" : isShared ? "Remove" : "Forget"}
          </Button>
        {/if}
      {/snippet}
    </SettingsRow>
  </SettingsSection>
{/if}

{#snippet openTab(tab: string, satisfied: boolean)}
  <Button variant="outline" size="sm" onclick={() => onOpenTab(tab)}>
    {satisfied ? "Configure" : "Set up"}
  </Button>
{/snippet}
