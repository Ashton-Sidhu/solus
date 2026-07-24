<script lang="ts">
  import {
    ArrowLeftIcon,
    CaretDownIcon,
    CheckIcon,
    CircleNotchIcon,
    DesktopTowerIcon,
    GlobeSimpleIcon,
  } from "phosphor-svelte";
  import { LOCAL_SERVER_ID } from "@client-core/server-registry";
  import { serverConnections } from "@client-core/server-connections";
  import { preferredRunOnHost, rememberRunOnHost } from "@client-core/run-on-preferences";
  import type { RecentProject } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { tooltip } from "../../lib/tooltip";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import {
    serversStore,
    type ServerItem,
    type ServerItemStatus,
  } from "../../contexts/connections/servers.store.svelte";
  import { checkoutForRepo, isRunOnHostLocked, repoKeyForPath } from "./run-on";

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
  const detectedRepoKey = $derived(
    repoKeyForPath(
      serversStore.projectIdentitiesFor(LOCAL_SERVER_ID),
      session?.gitContext?.repoRoot ?? session?.workingDirectory,
    ),
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

  function statusLabel(status: ServerItemStatus): string {
    if (status === "online") return "Online";
    if (status === "connecting") return "Connecting";
    if (status === "offline") return "Offline";
    return "Not checked";
  }

  function dotClass(status: ServerItemStatus): string {
    if (status === "online") return "bg-(--solus-status-complete)";
    if (status === "connecting") return "animate-pulse bg-(--solus-accent)";
    if (status === "offline") return "bg-(--solus-status-error)";
    return "bg-(--solus-text-quaternary)";
  }

  function checkoutFor(serverId: string) {
    return checkoutForRepo(serversStore.projectIdentitiesFor(serverId), sourceRepoKey);
  }

  function setTarget(server: ServerItem, path?: string) {
    if (!session || locked) return;
    const previousServerId = session.serverId;
    if (previousServerId !== server.id) {
      void workspace.apiFor(tabId).closeTab(workspace.ctxFor(tabId)).catch(() => {});
    }
    rememberRunOnHost(sourceRepoKey, server.id);
    serverConnections.retain(server.id);
    if (!server.local) serverConnections.ensure(server.id);
    session.serverId = server.id;
    if (path) session.workingDirectory = path;
    if (
      previousServerId !== server.id &&
      !workspace.tabOrder.some((id) => id !== tabId && workspace.sessionFor(id)?.serverId === previousServerId)
    ) {
      serverConnections.unretain(previousServerId);
      serverConnections.release(previousServerId);
    }
    choosingProjectFor = null;
    open = false;
  }

  async function chooseServer(event: Event, server: ServerItem) {
    const checkout = checkoutFor(server.id);
    if (server.local || checkout) {
      setTarget(server, checkout?.path);
      return;
    }

    event.preventDefault();
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
      {#if selectedServer?.local}
        <DesktopTowerIcon size={11} class="shrink-0 opacity-60" />
      {:else}
        <GlobeSimpleIcon size={11} class="shrink-0 opacity-60" />
      {/if}
      <span class="truncate">{selectedServer?.label ?? "Unknown host"}</span>
      <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(selectedServer?.status ?? "offline")}`}></span>
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
            <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(selectedServer?.status ?? "saved")}`}></span>
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
            <div class="px-3 py-2 text-[0.6875rem] leading-relaxed text-(--solus-text-tertiary)">
              No recent projects are available on this host.
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
        {:else}
          <DropdownMenu.Label class="px-3 py-1.5 text-[0.625rem] text-(--solus-text-tertiary)">Start the next session on</DropdownMenu.Label>
          {#each serversStore.servers as server (server.id)}
            {@const checkout = checkoutFor(server.id)}
            <DropdownMenu.Item class="py-2" onSelect={(event) => void chooseServer(event, server)}>
              <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-tertiary)">
                {#if server.local}<DesktopTowerIcon size={14} />{:else}<GlobeSimpleIcon size={14} />{/if}
              </span>
              <span class="min-w-0 flex-1">
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate font-medium text-(--solus-text-primary)">{server.label}</span>
                  <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(server.status)}`} title={statusLabel(server.status)}></span>
                </span>
                <span class="mt-0.5 block truncate font-mono text-[0.625rem] text-(--solus-text-tertiary)">
                  {checkout?.path ?? (server.local ? session?.workingDirectory : "Choose a recent project")}
                </span>
              </span>
              {#if server.id === session?.serverId}<CheckIcon size={12} class="text-(--solus-accent)" />{/if}
            </DropdownMenu.Item>
          {/each}
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
{/if}
