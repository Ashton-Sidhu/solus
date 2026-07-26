<script lang="ts">
  import {
    ArrowLeftIcon,
    CaretDownIcon,
    CheckIcon,
    CircleNotchIcon,
    DesktopTowerIcon,
    DownloadSimpleIcon,
    FolderOpenIcon,
    PlusIcon,
  } from "phosphor-svelte";
  import { LOCAL_SERVER_ID } from "@client-core/server-registry";
  import { serverConnections } from "@client-core/server-connections";
  import { preferredRunOnHost } from "@client-core/run-on-preferences";
  import type { RecentProject } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { tooltip } from "../../lib/tooltip";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import {
    serversStore,
    type ServerItem,
  } from "../../contexts/connections/servers.store.svelte";
  import {
    checkoutForRepo,
    isRunOnHostLocked,
    repoKeyForPath,
    retargetSessionHost,
  } from "./run-on";
  import { dispatchAvailability } from "./lib/dispatch-availability";
  import { hostAffinityGlyph } from "./lib/host-affinity";
  import { openProjectStore } from "./open-project.store.svelte";
  import { hostOnboardingStore } from "./host-onboarding.store.svelte";

  interface Props {
    tabId: string;
  }

  let { tabId }: Props = $props();

  const workspace = getWorkspaceContext();
  const session = $derived(workspace.sessionFor(tabId));
  const locked = $derived(isRunOnHostLocked(session));
  const selectedServer = $derived(
    serversStore.servers.find((server) => server.id === session?.serverId) ?? serversStore.servers[0] ?? null,
  );
  const selectedAffinity = $derived(
    hostAffinityGlyph(selectedServer, selectedServer?.status ?? "saved"),
  );
  // The repo is resolved against the host the session is already on — a
  // dispatched session's checkout path means nothing in the local manifest.
  const currentHostId = $derived(session?.serverId ?? LOCAL_SERVER_ID);
  const detectedRepoKey = $derived(
    repoKeyForPath(
      serversStore.projectIdentitiesFor(currentHostId),
      session?.gitContext?.repoRoot ?? session?.workingDirectory,
    ),
  );
  const availability = $derived(
    dispatchAvailability({
      inCheckout: !!session?.gitContext?.repoRoot,
      repoKey: detectedRepoKey,
      identitiesProbed: serversStore.hasProbedIdentities(currentHostId),
    }),
  );

  let open = $state(false);
  let choosingProjectFor = $state<ServerItem | null>(null);
  let recentProjects = $state<RecentProject[]>([]);
  let loadingProjects = $state(false);
  let projectLoadError = $state(false);
  let resolvedDefaultKey = $state<string | null>(null);
  let autoProbeKey = $state<string | null>(null);
  let sourceRepoKey = $state<string | null>(null);

  $effect(() => {
    if (detectedRepoKey) sourceRepoKey = detectedRepoKey;
  });

  $effect(() => {
    const path = session?.gitContext?.repoRoot ?? session?.workingDirectory;
    const key = !locked && path && path !== "~" ? `${tabId}:${path}` : null;
    if (!key || autoProbeKey === key) return;
    autoProbeKey = key;
    void serversStore.probeRunOnServers();
  });

  $effect(() => {
    const repoKey = sourceRepoKey;
    const resolutionKey = repoKey ? `${tabId}:${repoKey}` : null;
    const currentSession = session;
    if (!repoKey || !resolutionKey || resolvedDefaultKey === resolutionKey || !currentSession || locked) return;
    if (currentSession.serverId !== LOCAL_SERVER_ID) {
      resolvedDefaultKey = resolutionKey;
      return;
    }
    const preferredId = preferredRunOnHost(repoKey);
    if (preferredId === LOCAL_SERVER_ID) {
      resolvedDefaultKey = resolutionKey;
      return;
    }
    const preferred = serversStore.servers.find((server) => server.id === preferredId);
    if (!preferred) {
      resolvedDefaultKey = resolutionKey;
      return;
    }
    const status = serversStore.statusFor(preferredId);
    if (status === "saved" || status === "connecting") return;
    resolvedDefaultKey = resolutionKey;
    if (status !== "online") return;
    const checkout = checkoutForRepo(serversStore.projectIdentitiesFor(preferredId), repoKey);
    if (!checkout) return;
    serverConnections.ensure(preferredId);
    currentSession.serverId = preferredId;
    currentSession.workingDirectory = checkout.path;
  });

  $effect(() => {
    const pairedId = serversStore.justPairedServerId;
    if (!pairedId || serversStore.pendingRunOnTabId !== tabId) return;
    serversStore.justPairedServerId = null;
    serversStore.pendingRunOnTabId = null;
    const server = serversStore.servers.find((candidate) => candidate.id === pairedId);
    if (server) setTarget(server);
  });

  function checkoutFor(serverId: string) {
    return checkoutForRepo(serversStore.projectIdentitiesFor(serverId), sourceRepoKey);
  }

  function setTarget(server: ServerItem, path?: string) {
    if (!session || locked) return;
    const result = retargetSessionHost({
      workspace,
      tabId,
      serverId: server.id,
      isLocalHost: server.local,
      path,
      repoKey: sourceRepoKey,
      onDispatched: (dispatchedPath) =>
        void workspace.environment.refreshTab(workspace, {
          tabId,
          cwd: dispatchedPath,
          worktreeRequested: true,
        }),
    });
    // Without a directory on the target the move is refused, so send the user to
    // the step that can supply one rather than closing over a silent no-op.
    if (!result.ok) {
      void chooseProjectOn(server);
      return;
    }
    choosingProjectFor = null;
    open = false;
  }

  async function chooseProjectOn(server: ServerItem) {
    choosingProjectFor = server;
    recentProjects = [];
    projectLoadError = false;
    loadingProjects = true;
    try {
      const api = serverConnections.ensure(server.id).api;
      recentProjects = await api.listRecentProjects();
    } catch {
      projectLoadError = true;
    } finally {
      loadingProjects = false;
    }
  }

  /** The repo this tab sits in, offered as the omnibox seed on a host that lacks it. */
  function cloneSeedFor(server: ServerItem): string | undefined {
    if (server.local || !sourceRepoKey || checkoutFor(server.id)) return undefined;
    const [, owner, repo] = sourceRepoKey.split("/");
    return owner && repo ? `${owner}/${repo}` : undefined;
  }

  /** The host is already chosen here, so the flow opens with that step settled. */
  function startNewProject(server: ServerItem, seed?: string) {
    open = false;
    choosingProjectFor = null;
    openProjectStore.open(
      serversStore.servers.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        local: candidate.local,
      })),
      {
        tabId,
        host: { id: server.id, label: server.label, local: server.local },
        seed,
        source: seed ? "clone" : undefined,
      },
    );
  }

  function browseHost(server: ServerItem) {
    open = false;
    choosingProjectFor = null;
    window.dispatchEvent(
      new CustomEvent("solus:open-directory-picker", {
        detail: { tabId, serverId: server.id },
      }),
    );
  }

  async function chooseServer(event: Event, server: ServerItem) {
    const checkout = checkoutFor(server.id);
    // Staying on the host you're already using isn't a dispatch, so it needs no
    // directory of its own; every real move does.
    if (server.id === session?.serverId || checkout) {
      setTarget(server, checkout?.path);
      return;
    }

    event.preventDefault();
    await chooseProjectOn(server);
  }

  function handleOpenChange(next: boolean) {
    open = next;
    if (next) {
      choosingProjectFor = null;
      void serversStore.probeRunOnServers();
      return;
    }
    requestInputFocus();
  }
</script>

{#if serversStore.remotes.length > 0}
  {#if locked}
    <span
      class="inline-flex h-7 max-w-40 shrink-0 items-center gap-1.5 rounded-full px-2 text-[0.6875rem] text-(--solus-text-tertiary)"
      use:tooltip={`Runs on ${selectedServer?.label ?? "unknown host"} — sessions stay on the host they started on`}
    >
      {#if selectedAffinity}
        {@const HostIcon = selectedAffinity.icon}
        <HostIcon size={11} class="shrink-0 {selectedAffinity.className}" />
      {:else}
        <DesktopTowerIcon size={11} class="shrink-0 opacity-60" />
      {/if}
      <span class="truncate">{selectedServer?.label ?? "Unknown host"}</span>
    </span>
  {:else}
    <DropdownMenu.Root bind:open onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="relative inline-flex h-7 max-w-44 items-center gap-1.5 rounded-full px-2 text-[0.6875rem] text-(--solus-text-tertiary) transition-[background-color,color,scale] hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)] hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) after:absolute after:left-1/2 after:top-1/2 after:h-10 after:w-full after:min-w-10 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
            use:tooltip={open ? null : `Run new session on ${selectedServer?.label ?? "This Mac"}`}
          >
            {#if selectedAffinity}
              {@const HostIcon = selectedAffinity.icon}
              <HostIcon size={11} class="shrink-0 {selectedAffinity.className}" />
            {/if}
            <span class="truncate">Run on: {selectedServer?.label ?? "This Mac"}</span>
            <CaretDownIcon size={9} class="shrink-0 opacity-60" />
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="start" sideOffset={6} class="w-[300px]">
        {#if choosingProjectFor}
          <DropdownMenu.Item
            class="py-2"
            onSelect={(event) => {
              event.preventDefault();
              choosingProjectFor = null;
            }}
          >
            <ArrowLeftIcon size={12} />
            <span>Choose a host</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Label class="truncate px-3 py-1.5 text-[0.625rem] text-(--solus-text-tertiary)">
            Recent projects on {choosingProjectFor.label}
          </DropdownMenu.Label>
          {#if loadingProjects}
            <div class="flex min-h-10 items-center gap-2 px-3 py-2 text-[0.6875rem] text-(--solus-text-tertiary)">
              <CircleNotchIcon size={12} class="animate-spin" />
              Loading projects…
            </div>
          {:else if projectLoadError}
            <div class="px-3 py-2 text-[0.6875rem] leading-relaxed text-(--solus-status-error)">
              Couldn’t reach this host. Check its connection and try again.
            </div>
          {:else if recentProjects.length === 0}
            <div class="px-3 pb-1 pt-2 text-pretty text-[0.6875rem] leading-relaxed text-(--solus-text-tertiary)">
              Nothing here yet — this host has no projects.
            </div>
          {:else}
            {#each recentProjects as project (project.path)}
              <DropdownMenu.Item class="py-2" onSelect={() => setTarget(choosingProjectFor!, project.path)}>
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium text-(--solus-text-primary)">{project.folderName}</span>
                  <span class="mt-0.5 block truncate font-mono text-[0.625rem] text-(--solus-text-tertiary)">{project.path}</span>
                </span>
              </DropdownMenu.Item>
            {/each}
          {/if}

          <!-- A host with no checkout used to dead-end here; these two are the
               way forward, and the primary CTA when there are no recents. -->
          <DropdownMenu.Separator />
          {#if cloneSeedFor(choosingProjectFor)}
            {@const seed = cloneSeedFor(choosingProjectFor)!}
            <DropdownMenu.Item class="py-2" onSelect={() => startNewProject(choosingProjectFor!, seed)}>
              <DownloadSimpleIcon size={12} class="shrink-0 text-(--solus-accent)" />
              <span class="min-w-0 flex-1 truncate font-medium text-(--solus-accent)">
                Clone {seed.split("/")[1]} here
              </span>
            </DropdownMenu.Item>
          {/if}
          <DropdownMenu.Item class="py-2" onSelect={() => startNewProject(choosingProjectFor!)}>
            <PlusIcon size={12} class="shrink-0" />
            <span class="min-w-0 flex-1 truncate">Open a project on {choosingProjectFor.label}…</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item class="py-2" onSelect={() => browseHost(choosingProjectFor!)}>
            <FolderOpenIcon size={12} class="shrink-0" />
            <span class="min-w-0 flex-1 truncate">Browse folder…</span>
          </DropdownMenu.Item>
        {:else}
          <DropdownMenu.Label class="px-3 py-1.5 text-[0.625rem] text-(--solus-text-tertiary)">Start the next session on</DropdownMenu.Label>
          {#each serversStore.servers as server (server.id)}
            {@const checkout = checkoutFor(server.id)}
            {@const isCurrentHost = server.id === session?.serverId}
            {@const affinity = hostAffinityGlyph(server, server.status)}
            {@const blocked = !availability.canDispatch && !isCurrentHost}
            <DropdownMenu.Item
              class="py-2"
              disabled={blocked}
              onSelect={(event) => void chooseServer(event, server)}
            >
              <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) {affinity?.className ?? 'text-(--solus-text-tertiary)'}">
                {#if affinity}
                  {@const HostIcon = affinity.icon}
                  <HostIcon size={14} />
                {:else}
                  <DesktopTowerIcon size={14} />
                {/if}
              </span>
              <span class="min-w-0 flex-1">
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate font-medium text-(--solus-text-primary)">{server.label}</span>
                  {#if affinity}
                    <span class="shrink-0 text-[0.625rem] text-(--solus-text-tertiary)">{affinity.statusLabel}</span>
                  {/if}
                </span>
                <span class="mt-0.5 block truncate font-mono text-[0.625rem] text-(--solus-text-tertiary)">
                  {checkout?.path ?? (isCurrentHost ? session?.workingDirectory : "Choose a recent project")}
                </span>
              </span>
              {#if isCurrentHost}<CheckIcon size={12} class="text-(--solus-accent)" />{/if}
            </DropdownMenu.Item>
          {/each}
          {#if !availability.canDispatch}
            <p class="px-3 pb-1.5 pt-1 text-pretty text-[0.625rem] leading-relaxed text-(--solus-text-tertiary)">
              {availability.note}
            </p>
          {/if}
          {#if serversStore.nearbyHosts.length > 0}
            <DropdownMenu.Label class="px-3 pb-1 pt-2 text-[0.625rem] text-(--solus-text-tertiary)">
              Nearby
            </DropdownMenu.Label>
            {#each serversStore.nearbyHosts as host (host.server.installationId)}
              <DropdownMenu.Item
                class="py-2 text-(--solus-text-tertiary)"
                onSelect={(event) => {
                  event.preventDefault();
                  serversStore.pendingRunOnTabId = tabId;
                  hostOnboardingStore.openForDiscovered(host.server);
                }}
              >
                <span class="flex size-7 shrink-0 items-center justify-center">
                  <span class="size-2 rounded-full border border-(--solus-text-quaternary)"></span>
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium text-(--solus-text-secondary)">
                    {host.server.name}
                  </span>
                  <span class="mt-0.5 block truncate font-mono text-[0.625rem] text-(--solus-text-tertiary)">
                    {host.server.host}:{host.server.port}
                  </span>
                </span>
                <span class="shrink-0 text-[0.6875rem] font-medium text-(--solus-accent)">
                  Connect
                </span>
              </DropdownMenu.Item>
            {/each}
          {/if}
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
{/if}
