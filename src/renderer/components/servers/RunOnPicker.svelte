<script lang="ts">
  import {
    ArrowLeftIcon,
    CheckIcon,
    CircleNotchIcon,
    DesktopTowerIcon,
    FolderOpenIcon,
    GitForkIcon,
    PlusIcon,
  } from "phosphor-svelte";
  import { mergeProps } from "bits-ui";
  import { LOCAL_SERVER_ID } from "@client-core/server-registry";
  import type { RecentProject } from "../../../shared/types";
  import {
    getWindowContext,
    getWorkspaceContext,
    hostAffinityGlyph,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { hasSessionStarted } from "../../lib/sessionUtils";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import { MenuFooter } from "../ui/menu";
  import {
    serversStore,
    type ServerItem,
    type UnknownRemoteHost,
  } from "../../contexts";
  import {
    isRunOnHostLocked,
    repoKeyForPath,
    queueSessionHostDispatch,
    retargetSessionHost,
    worktreeBlockedReason,
  } from "./run-on";
  import { dispatchAvailability } from "./lib/dispatch-availability";
  import { openProjectStore } from "./open-project.store.svelte";
  import { hostOnboardingStore } from "./host-onboarding.store.svelte";

  interface Props {
    tabId: string;
    /**
     * `chip` is the standalone "Run on: X" pill the pill-mode status row uses.
     * `header` is the input bar's "Start in" chip, which answers where the next
     * session runs *and* whether it gets its own worktree — one question to the
     * user, so one control.
     */
    variant?: "chip" | "header";
    /** Worktree state, owned by the header; unused by the `chip` variant. */
    startsNewWorktree?: boolean;
    /** The checkout the session sits in is itself a worktree. */
    inWorktree?: boolean;
    canToggleWorktree?: boolean;
    /** A dispatched session always gets a worktree, so the choice is inert. */
    worktreeForced?: boolean;
    setWorktree?: (next: boolean) => void;
  }

  let {
    tabId,
    variant = "chip",
    startsNewWorktree = false,
    inWorktree = false,
    canToggleWorktree = false,
    worktreeForced = false,
    setWorktree,
  }: Props = $props();

  const workspace = getWorkspaceContext();
  const session = $derived(workspace.sessionFor(tabId));
  // A tab with no session yet has no host to move, but it does still choose the
  // shape of its next checkout, so the header chip stays live until one starts.
  const locked = $derived(
    variant === "header"
      ? hasSessionStarted(session)
      : isRunOnHostLocked(session),
  );
  const selectedHostId = $derived(
    session?.pendingHostDispatch?.serverId ?? session?.serverId,
  );
  const selectedServer = $derived(serversStore.hostFor(selectedHostId));
  const selectedAffinity = $derived(serversStore.affinityFor(selectedHostId));
  const onRemoteHost = $derived(!!selectedServer && !selectedServer.local);
  // Keep local choices on one conceptual axis: both labels describe the shape
  // of the checkout. A remote target is named for the host instead.
  // Where you already are is a worktree often enough that calling it a plain
  // checkout reads as a mistake — name it for what it is.
  // A browser has no machine of its own — "Local" would claim the phone in
  // your hand, so the connected host is named instead.
  const windowCtx = getWindowContext();
  const stayLabel = $derived(
    windowCtx.isWeb
      ? (serversStore.servers.find((server) => server.local)?.label ?? "This host")
      : "Local",
  );
  // On web the active server is folded into the local row, so "another host"
  // means the rows that remain — not the raw saved list, which includes it.
  const otherHosts = $derived(
    serversStore.servers.filter((server) => !server.local),
  );
  const startInLabel = $derived(
    onRemoteHost
      ? hostLabel(selectedServer)
      : startsNewWorktree
        ? "New worktree"
        : stayLabel,
  );
  // A disabled row with no reason is the worst of both worlds, so say why the
  // choice is off the table.
  const worktreeBlockedNote = $derived(
    worktreeBlockedReason(canToggleWorktree, inWorktree),
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
  let triggerTooltipOpen = $state(false);
  let choosingProjectFor = $state<ServerItem | null>(null);
  let recentProjects = $state<RecentProject[]>([]);
  let loadingProjects = $state(false);
  let projectLoadError = $state(false);
  let sourceRepoKey = $state<string | null>(null);

  // Same footer contract as the model picker: teach the key, then say what the
  // menu currently resolves to, so the choice is legible without reading rows.
  const footerSummary = $derived(
    choosingProjectFor
      ? `${recentProjects.length} project${recentProjects.length === 1 ? "" : "s"}`
      : variant === "header"
        ? startInLabel
        : hostLabel(selectedServer),
  );

  $effect(() => {
    // Retargeting clears gitContext, so retain the last repo key while selection finishes.
    if (detectedRepoKey) sourceRepoKey = detectedRepoKey;
  });

  $effect(() => {
    const path = session?.gitContext?.repoRoot ?? session?.workingDirectory;
    if (locked || !path || path === "~") return;
    void serversStore.loadProjectIdentities(currentHostId);
  });

  $effect(() => {
    const pairedId = serversStore.consumeJustPaired(tabId);
    if (!pairedId) return;
    const server = serversStore.servers.find(
      (candidate) => candidate.id === pairedId,
    );
    if (server) selectTarget(server);
  });

  /**
   * A host is named for where the work runs, and "runs here" is what local
   * means — the device's own name ("This Mac") is only interesting on surfaces
   * that list it beside other people's machines.
   */
  function hostLabel(server: ServerItem | UnknownRemoteHost | null | undefined) {
    return !server || server.local ? stayLabel : server.label;
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
      requireWorktree: true,
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

  function selectTarget(server: ServerItem) {
    if (!session || locked || !sourceRepoKey) return;
    queueSessionHostDispatch(session, {
      serverId: server.id,
      hostLabel: server.label,
      isLocalHost: server.local,
      repoKey: sourceRepoKey,
    });
    choosingProjectFor = null;
    open = false;
  }

  async function chooseProjectOn(server: ServerItem) {
    choosingProjectFor = server;
    recentProjects = [];
    projectLoadError = false;
    loadingProjects = true;
    try {
      recentProjects = await serversStore.recentProjectsFor(server.id);
    } catch {
      projectLoadError = true;
    } finally {
      loadingProjects = false;
    }
  }

  /** The host is already chosen here, so the flow opens with that step settled. */
  function startNewProject(server: ServerItem) {
    open = false;
    choosingProjectFor = null;
    openProjectStore.open(serversStore.servers, {
      tabId,
      host: server,
    });
  }

  function browseHost(server: ServerItem) {
    open = false;
    choosingProjectFor = null;
    window.dispatchEvent(
      new CustomEvent("solus:open-directory-picker", {
        detail: { tabId, serverId: server.id, requireWorktree: true },
      }),
    );
  }

  async function chooseServer(event: Event, server: ServerItem) {
    // Staying on the host you're already using isn't a dispatch, so it needs no
    // directory of its own; every real move does.
    if (
      server.id ===
      selectedHostId
    ) {
      open = false;
      return;
    }

    event.preventDefault();
    if (sourceRepoKey) {
      selectTarget(server);
      return;
    }
    await chooseProjectOn(server);
  }

  /** Both local checkout choices cancel a queued remote dispatch first. */
  function chooseLocalStart(worktree: boolean) {
    const local = serversStore.servers.find((server) => server.local);
    if (session && local && session.serverId !== local.id) {
      if (sourceRepoKey) {
        queueSessionHostDispatch(session, {
          serverId: local.id,
          hostLabel: stayLabel,
          isLocalHost: true,
          repoKey: sourceRepoKey,
        });
        open = false;
        return;
      }
      void chooseProjectOn(local);
      return;
    }
    if (session?.pendingHostDispatch) {
      if (sourceRepoKey) {
        queueSessionHostDispatch(session, {
          serverId: session.serverId,
          hostLabel: stayLabel,
          isLocalHost: true,
          repoKey: sourceRepoKey,
        });
      } else {
        session.pendingHostDispatch = null;
      }
    }
    if (!worktreeForced && worktree !== startsNewWorktree)
      setWorktree?.(worktree);
    open = false;
  }

  function handleOpenChange(next: boolean) {
    open = next;
    if (next) {
      triggerTooltipOpen = false;
      choosingProjectFor = null;
      void serversStore.probeHosts();
      return;
    }
    requestInputFocus();
  }

  function getTriggerTooltipOpen() {
    return triggerTooltipOpen && !open;
  }

  function setTriggerTooltipOpen(next: boolean) {
    triggerTooltipOpen = next && !open;
  }
</script>

{#snippet serverRow(server: ServerItem)}
  {@const isSelectedHost = server.id === selectedHostId}
  {@const affinity = hostAffinityGlyph(server, server.status)}
  {@const blocked = !availability.canDispatch && !isSelectedHost}
  <DropdownMenu.Item
    data-menu-current={isSelectedHost ? "" : undefined}
    disabled={blocked}
    onSelect={(event) => void chooseServer(event, server)}
  >
    {#if affinity}
      {@const HostIcon = affinity.icon}
      <HostIcon size={13} class="shrink-0 {affinity.className}" />
    {:else}
      <DesktopTowerIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
    {/if}
    <span class="min-w-0 flex-1 truncate">{hostLabel(server)}</span>
    {#if isSelectedHost}
      <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
    {:else if affinity && server.status !== "saved"}
      <span class="shrink-0 text-[0.6875rem] text-(--solus-text-tertiary)">{affinity.statusLabel}</span>
    {/if}
  </DropdownMenu.Item>
{/snippet}

{#snippet availabilityNote()}
  {#if !availability.canDispatch}
    <p class="text-pretty px-2.5 pb-1 pt-1 text-[0.6875rem] leading-snug text-(--solus-text-tertiary)">
      {availability.note}
    </p>
  {/if}
{/snippet}

{#snippet nearbyRow(host: (typeof serversStore.nearbyHosts)[number])}
  <DropdownMenu.Item
    onSelect={(event) => {
      event.preventDefault();
      serversStore.pairForRunOn(tabId);
      hostOnboardingStore.openForDiscovered(host.server);
    }}
    title="{host.server.host}:{host.server.port}"
  >
    <span class="flex size-3.5 shrink-0 items-center justify-center">
      <span class="size-2 rounded-full border border-(--solus-text-quaternary)"></span>
    </span>
    <span class="min-w-0 flex-1 truncate">{host.server.name}</span>
    <span class="shrink-0 text-[0.6875rem] font-medium text-(--solus-accent)">Connect</span>
  </DropdownMenu.Item>
{/snippet}

<!-- The header chip is the only control for worktree mode, so it shows even on
     a machine that has never seen another host. The pill-mode chip stays hidden
     until there is a host to choose, unless this session already belongs to a
     remote host that has since been forgotten. -->
{#if variant === "header" ||
  otherHosts.length > 0 ||
  (!!selectedHostId && selectedHostId !== LOCAL_SERVER_ID)}
  {#if locked}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <span
            {...tooltipProps}
            aria-label={`Runs on ${selectedServer ? hostLabel(selectedServer) : "an unknown host"}`}
            class="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-(--solus-text-tertiary)"
          >
            {#if selectedAffinity}
              {@const HostIcon = selectedAffinity.icon}
              <HostIcon
                size={14}
                class="shrink-0 {selectedAffinity.className}"
              />
            {:else}
              <DesktopTowerIcon size={14} class="shrink-0 opacity-60" />
            {/if}
          </span>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content
        value={`Runs on ${selectedServer ? hostLabel(selectedServer) : "an unknown host"} — sessions stay on the host they started on`}
      />
    </TooltipUI.Root>
  {:else}
    <DropdownMenu.Root bind:open onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          {#if variant === "header"}
            <TooltipUI.Root
              bind:open={getTriggerTooltipOpen, setTriggerTooltipOpen}
              disabled={open}
            >
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <Button
                    {...mergeProps(tooltipProps, props)}
                    variant="ghost"
                    class="group relative h-auto max-w-44 gap-1.5 rounded-lg px-2 py-1 text-[0.8125rem] font-normal tracking-[-0.006em] transition-[background-color,color,scale] duration-[var(--duration-quick)] ease-(--ease-premium) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-0 after:absolute after:left-0 after:top-1/2 after:h-10 after:w-full after:-translate-y-1/2 after:content-[''] {open
                      ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
                      : 'text-(--solus-text-tertiary) hover:bg-[color-mix(in_srgb,var(--solus-surface-hover)_60%,transparent)] hover:text-(--solus-text-secondary) focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-secondary)'}"
                  >
                    {#if onRemoteHost && selectedAffinity}
                      {@const HostIcon = selectedAffinity.icon}
                      <HostIcon
                        size={14}
                        class="shrink-0 transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {open
                          ? 'opacity-100'
                          : 'opacity-70'} {selectedAffinity.className}"
                      />
                    {:else}
                      <DesktopTowerIcon
                        size={14}
                        class="shrink-0 text-(--solus-text-tertiary) transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {open
                          ? 'opacity-100'
                          : 'opacity-70'}"
                      />
                    {/if}
                    <span class="truncate">{startInLabel}</span>
                  </Button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content
                value={`Where the next session starts — now: ${startInLabel}`}
              />
            </TooltipUI.Root>
          {:else}
            <TooltipUI.Root
              bind:open={getTriggerTooltipOpen, setTriggerTooltipOpen}
              disabled={open}
            >
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <Button
                    {...mergeProps(tooltipProps, props)}
                    variant="ghost"
                    aria-label={`Run new session on ${hostLabel(selectedServer)}`}
                    class="relative size-7 rounded-full p-0 text-(--solus-text-tertiary) transition-[background-color,color,scale] hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)] hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:ring-0 after:absolute after:left-1/2 after:top-1/2 after:size-10 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
                  >
                    {#if selectedAffinity}
                      {@const HostIcon = selectedAffinity.icon}
                      <HostIcon
                        size={14}
                        class="shrink-0 {selectedAffinity.className}"
                      />
                    {:else}
                      <DesktopTowerIcon size={14} class="shrink-0 opacity-60" />
                    {/if}
                  </Button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content
                value={`Run new session on ${hostLabel(selectedServer)}`}
              />
            </TooltipUI.Root>
          {/if}
        {/snippet}
      </DropdownMenu.Trigger>
      <!-- Both triggers live on the bottom-anchored composer, so downward is
           where there is no room; the list opens over the transcript instead. -->
      <DropdownMenu.Content
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        class="w-[300px] p-0"
      >
        <!-- The footer spans the surface, so the rows scroll inside their own
             padded body rather than dragging it out of view. -->
        <div class="max-h-[288px] overflow-y-auto p-1.5">
          {#if choosingProjectFor}
            <DropdownMenu.Item
              onSelect={(event) => {
                event.preventDefault();
                choosingProjectFor = null;
              }}
            >
              <ArrowLeftIcon size={13} class="shrink-0" />
              <span class="min-w-0 flex-1 truncate">Choose a host</span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Label class="truncate">
              Recent projects on {hostLabel(choosingProjectFor)}
            </DropdownMenu.Label>
            {#if loadingProjects}
              <div
                class="flex h-8 items-center gap-2.5 px-2.5 text-menu text-(--solus-text-tertiary)"
              >
                <CircleNotchIcon size={13} class="shrink-0 animate-spin" />
                Loading projects…
              </div>
            {:else if projectLoadError}
              <div
                class="text-pretty px-2.5 py-1.5 text-[0.6875rem] leading-snug text-(--solus-status-error)"
              >
                Couldn’t reach this host. Check its connection and try again.
              </div>
            {:else if recentProjects.length === 0}
              <div
                class="text-pretty px-2.5 pb-1 pt-1 text-[0.6875rem] leading-snug text-(--solus-text-tertiary)"
              >
                Nothing here yet — this host has no projects.
              </div>
            {:else}
              {#each recentProjects as project (project.path)}
                <DropdownMenu.Item
                  onSelect={() => setTarget(choosingProjectFor!, project.path)}
                >
                  <span class="min-w-0 flex-1 truncate"
                    >{project.folderName}</span
                  >
                  <span
                    class="min-w-0 shrink truncate text-[0.6875rem] text-(--solus-text-tertiary)"
                    title={project.path}
                  >
                    {project.path}
                  </span>
                </DropdownMenu.Item>
              {/each}
            {/if}

            <!-- A host with no checkout used to dead-end here; these two are the
               way forward, and the primary CTA when there are no recents. -->
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              onSelect={() => startNewProject(choosingProjectFor!)}
            >
              <PlusIcon size={13} class="shrink-0" />
              <span class="min-w-0 flex-1 truncate"
                >Open a project on {hostLabel(choosingProjectFor)}…</span
              >
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => browseHost(choosingProjectFor!)}>
              <FolderOpenIcon size={13} class="shrink-0" />
              <span class="min-w-0 flex-1 truncate">Browse folder…</span>
            </DropdownMenu.Item>
          {:else if variant === "header"}
            <DropdownMenu.Label>Start in</DropdownMenu.Label>
            <DropdownMenu.Item
              data-menu-current={!onRemoteHost && !startsNewWorktree
                ? ""
                : undefined}
              disabled={worktreeForced}
              onSelect={(event) => {
                event.preventDefault();
                chooseLocalStart(false);
              }}
            >
              {#if inWorktree}
                <GitForkIcon
                  size={13}
                  class="shrink-0 text-(--solus-text-tertiary)"
                />
              {:else}
                <DesktopTowerIcon
                  size={13}
                  class="shrink-0 text-(--solus-text-tertiary)"
                />
              {/if}
              <span class="min-w-0 flex-1 truncate">{stayLabel}</span>
              {#if !onRemoteHost && !startsNewWorktree}<CheckIcon
                  size={12}
                  class="shrink-0 text-(--solus-accent)"
                />{/if}
            </DropdownMenu.Item>
            {#snippet newWorktreeItemContent()}
                <PlusIcon
                  size={13}
                  class="shrink-0 text-(--solus-text-tertiary)"
                />
                <span class="min-w-0 flex-1 truncate">New worktree</span>
                {#if !onRemoteHost && startsNewWorktree}<CheckIcon
                    size={12}
                    class="shrink-0 text-(--solus-accent)"
                  />{/if}
              {/snippet}
              {#if worktreeBlockedNote}
                <DropdownMenu.Item disabled>
                  {@render newWorktreeItemContent()}
                </DropdownMenu.Item>
                <p
                  class="text-pretty px-2.5 pb-1 text-[0.6875rem] leading-snug text-(--solus-text-tertiary)"
                >
                  {worktreeBlockedNote}
                </p>
              {:else}
                <DropdownMenu.Item
                  data-menu-current={!onRemoteHost && startsNewWorktree
                    ? ""
                    : undefined}
                  onSelect={(event) => {
                    event.preventDefault();
                    chooseLocalStart(true);
                  }}
                >
                  {@render newWorktreeItemContent()}
                </DropdownMenu.Item>
              {/if}

            <!-- Hosts are a different dimension from checkout shape, so give
               them their own group instead of presenting them as peers. -->
            {#if otherHosts.length > 0}
              <DropdownMenu.Separator />
              <DropdownMenu.Label>Run on another host</DropdownMenu.Label>
            {/if}
            {#each otherHosts as server (server.id)}
              {@render serverRow(server)}
            {/each}
            {#if otherHosts.length > 0}{@render availabilityNote()}{/if}
            {#if serversStore.nearbyHosts.length > 0}
              <DropdownMenu.Separator />
              {#each serversStore.nearbyHosts as host (host.server.installationId)}
                {@render nearbyRow(host)}
              {/each}
            {/if}
          {:else}
            <DropdownMenu.Label>Start the next session on</DropdownMenu.Label>
            {#each serversStore.servers as server (server.id)}
              {@render serverRow(server)}
            {/each}
            {@render availabilityNote()}
            {#if serversStore.nearbyHosts.length > 0}
              <DropdownMenu.Separator />
              <DropdownMenu.Label>Nearby</DropdownMenu.Label>
              {#each serversStore.nearbyHosts as host (host.server.installationId)}
                {@render nearbyRow(host)}
              {/each}
            {/if}
          {/if}
        </div>
        <MenuFooter
          hints={[["⏎", choosingProjectFor ? "open" : "select"]]}
          summary={footerSummary}
        />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
{/if}
