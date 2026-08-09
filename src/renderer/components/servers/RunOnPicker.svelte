<script lang="ts">
  import {
    CheckIcon,
    DesktopTowerIcon,
    GitForkIcon,
    PlusIcon,
  } from "phosphor-svelte";
  import { mergeProps } from "bits-ui";
  import { LOCAL_SERVER_ID } from "@client-core/server-registry";
  import { serverConnections } from "@client-core/server-connections";
  import type { RunConfig } from "../../../shared/types";
  import {
    getWindowContext,
    getWorkspaceContext,
    hostAffinityGlyph,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
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
    repoKeyForPath,
    returnsToProjectHome,
    shouldShowRunOnPicker,
  } from "./run-on";
  import {
    withPendingHost,
    withProjectHost,
    withWorktreeToggled,
  } from "../../contexts/workspace/run-config";
  import { runTarget } from "./lib/run-target";
  import { homeGitDetails } from "../../lib/git-context";
  import { getSessionEnvironmentStore } from "../../contexts";
  import { hostOnboardingStore } from "./host-onboarding.store.svelte";

  interface Props {
    /** Where the next session will run. A started session and a session draft
     *  both hold one, so this picker never asks which it is looking at. */
    run: RunConfig;
    /** Correlates the async pairing and browse flows back to this picker. A tab
     *  id for a conversation, a draft id for a draft — any stable id serves. */
    requesterId: string;
    /** Whether the host is fixed. A started session's is; a draft's never is.
     *  The two variants disagree on the no-session case, so the caller decides
     *  rather than this picker guessing. */
    locked?: boolean;
    /**
     * Where the next session will run, after this picker changes it. One channel
     * for every choice it offers — host, project on that host, worktree — because
     * all three are the same kind of edit and none of them acts until Send.
     * Nothing connects, clones or moves here; that is what makes changing your
     * mind free.
     */
    onRun: (next: RunConfig) => void;
    /**
     * `chip` is the standalone "Run on: X" pill the pill-mode status row uses.
     * `header` is the input bar's "Start in" chip, which answers where the next
     * session runs *and* whether it gets its own worktree — one question to the
     * user, so one control.
     */
    variant?: "chip" | "header";
    /** The pane whose composer this picker belongs to — `undefined` for the
     *  workspace dock, which has none. The open shortcut names a pane, so this
     *  is how the right picker knows the keystroke was meant for it. */
    paneId?: string;
  }

  let {
    run,
    requesterId,
    locked = false,
    onRun,
    variant = "chip",
    paneId,
  }: Props = $props();

  const workspace = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  // A browser with no host is choosing where to work, not dispatching from
  // somewhere to somewhere: picking a host reloads the page onto it. A host
  // only ever arrives by that reload, so this is settled at mount.
  const webNoHost =
    window.solus.getPlatform() === "web" && !serverConnections.connectionFor();
  const selectedHostId = $derived(
    run.pendingHostDispatch?.serverId ?? run.serverId,
  );
  // Every worktree answer follows from the run, so this picker reads them itself
  // rather than having four booleans handed down and kept in sync.
  const environment = $derived(environmentStore.environmentFor(run));
  const gitHome = $derived(
    homeGitDetails(
      run.workingDirectory,
      run.gitContext,
      workspace.globalDefaults.gitContext,
    ),
  );
  const inWorktree = $derived(environment.isolated);
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
  // Whether this run sits in a git checkout: the header offers worktree mode
  // only then, and a non-git folder shows a plain host list instead.
  const isGitRepo = $derived(!!environment.checkout || !!environment.repoRoot);
  // Reachability, not merely a saved entry, decides whether there is a real
  // machine to run on — so an offline saved host never conjures the picker.
  const showPicker = $derived(
    shouldShowRunOnPicker({
      variant,
      isGitRepo,
      connectedRemoteCount: serversStore.connectedRemotes.length,
      onRemoteHost,
      selectedHostId,
    }),
  );
  // Every state this control can be in follows from the run's two host ids and
  // its checkout, so it is derived once here rather than reassembled from four
  // booleans that have to be kept in agreement.
  const target = $derived(
    runTarget({
      run,
      hostLabel: hostLabel(selectedServer),
      taskHostLabel: hostLabel(serversStore.hostFor(run.taskServerId)),
      stayLabel,
      hostIsLocal: !onRemoteHost,
      isolated: inWorktree,
      canBranchWorktree: gitHome.canToggleWorktree,
    }),
  );
  const startInLabel = $derived(target.label);
  const startsNewWorktree = $derived(target.startsWorktree);
  const worktreeForced = $derived(target.worktreeForced);
  // A disabled row with no reason is the worst of both worlds, so say why the
  // choice is off the table.
  const worktreeBlockedNote = $derived(target.worktreeBlockedNote);
  // The repo is resolved against the host the session is already on — a
  // dispatched session's checkout path means nothing in the local manifest.
  const currentHostId = $derived(run.serverId ?? LOCAL_SERVER_ID);
  const detectedRepoKey = $derived(
    repoKeyForPath(
      serversStore.projectIdentitiesFor(currentHostId),
      run.gitContext?.repoRoot ?? run.workingDirectory,
    ),
  );

  let open = $state(false);
  let triggerEl = $state<HTMLElement | null>(null);
  let triggerTooltipOpen = $state(false);
  let sourceRepoKey = $state<string | null>(null);

  // Same footer contract as the model picker: teach the key, then say what the
  // menu currently resolves to, so the choice is legible without reading rows.
  const footerSummary = $derived(
    variant === "header" ? startInLabel : hostLabel(selectedServer),
  );

  $effect(() => {
    // Retargeting clears gitContext, so retain the last repo key while selection finishes.
    if (detectedRepoKey) sourceRepoKey = detectedRepoKey;
  });

  $effect(() => {
    const path = run.gitContext?.repoRoot ?? run.workingDirectory;
    if (locked || !path || path === "~") return;
    void serversStore.loadProjectIdentities(currentHostId);
  });

  // Reachability decides whether the picker appears at all, so warm it once on
  // mount rather than only when the menu opens. The store's staleness guard
  // collapses the several mounted pickers into a single probe.
  $effect(() => {
    void serversStore.probeHosts();
  });

  $effect(() => {
    const pairedId = serversStore.consumeJustPaired(requesterId);
    if (!pairedId) return;
    const server = serversStore.servers.find(
      (candidate) => candidate.id === pairedId,
    );
    if (server) selectTarget(server);
  });

  // The open shortcut is dispatched by the composer this picker sits under, and
  // names its pane. Only the picker in that pane answers, and only while it is
  // shown and unlocked — the visibility test drops the mirror the hidden layout
  // keeps mounted, so the same keystroke never opens a menu off-screen.
  $effect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId: string | null }>).detail;
      if ((detail?.paneId ?? null) !== (paneId ?? null)) return;
      if (!showPicker || locked) return;
      if (triggerEl && triggerEl.offsetParent === null) return;
      open = !open;
    };
    window.addEventListener("solus:toggle-run-picker", handler);
    return () => window.removeEventListener("solus:toggle-run-picker", handler);
  });

  /**
   * A host is named for where the work runs, and "runs here" is what local
   * means — the device's own name ("This Mac") is only interesting on surfaces
   * that list it beside other people's machines.
   */
  function hostLabel(server: ServerItem | UnknownRemoteHost | null | undefined) {
    return !server || server.local ? stayLabel : server.label;
  }

  /** Send *this* project's work to another machine. The repository travels as a
   *  clone; the project, and every task it files, stays here. */
  function selectTarget(server: ServerItem) {
    if (locked || !sourceRepoKey) return;
    onRun(
      withPendingHost(run, {
        serverId: server.id,
        intent: "dispatch",
        repoKey: sourceRepoKey,
      }),
    );
    open = false;
  }

  /** No cloneable checkout to send, so this host is somewhere to open a project
   *  on instead of dispatch to. Record the host; the project chip, which lists
   *  that host's recents, settles which folder. Still only intent — Send acts. */
  function openProjectOn(server: ServerItem) {
    if (locked) return;
    onRun(withPendingHost(run, { serverId: server.id, intent: "open-project" }));
    open = false;
  }

  /** The reverse of a dispatch: the project's own checkout already sits on this
   *  host, so selecting it runs the work back home rather than cloning it there
   *  or asking which folder to use. Clears any queued dispatch on the way. */
  function returnToProjectHome(server: ServerItem) {
    if (locked || !run.projectGroupPath) return;
    const home = withProjectHost(withPendingHost(run, null), server.id, {
      path: run.projectGroupPath,
    });
    home.projectGroupPath = null;
    onRun(home);
    open = false;
  }

  /** Selecting Local switches the run straight back to this machine. Your own
   *  host already holds the checkout, so there is never a project to pick: the
   *  run lands on its remembered project home, or the workspace's own project.
   *  Any queued remote dispatch is dropped on the way. */
  function runLocally(local: ServerItem) {
    if (locked) return;
    const next = withProjectHost(withPendingHost(run, null), local.id, {
      path: run.projectGroupPath ?? workspace.globalDefaults.workingDirectory,
    });
    next.projectGroupPath = null;
    onRun(next);
    open = false;
  }

  function chooseServer(event: Event, server: ServerItem) {
    // With no host connected there is nothing to dispatch from — activating the
    // chosen host reloads the client straight onto it.
    if (webNoHost) {
      event.preventDefault();
      open = false;
      serversStore.switchTo(server.id);
      return;
    }

    // Staying on the host you're already using isn't a dispatch, so it needs no
    // directory of its own; every real move does.
    if (
      server.id ===
      selectedHostId
    ) {
      open = false;
      return;
    }

    // Your own machine already holds the checkout, so returning to it just
    // switches hosts — never a project chooser for a project that is right here.
    if (server.local) {
      event.preventDefault();
      runLocally(server);
      return;
    }

    // A project whose home is another host re-homes there rather than cloning.
    if (returnsToProjectHome(run, server.id)) {
      event.preventDefault();
      returnToProjectHome(server);
      return;
    }

    event.preventDefault();
    if (sourceRepoKey) {
      selectTarget(server);
      return;
    }
    openProjectOn(server);
  }

  /** Both local checkout choices cancel a queued remote dispatch first. */
  function chooseLocalStart(worktree: boolean) {
    const local = serversStore.servers.find((server) => server.local);
    if (local && run.serverId !== local.id) {
      // Selecting Local switches straight back to this machine — it already holds
      // the checkout, so there is nothing to clone and nothing to pick.
      runLocally(local);
      return;
    }
    // Staying put clears the queued move. `onPickHost` with the run's own host
    // is exactly that, since a target matching the current host records nothing.
    if (run.pendingHostDispatch && sourceRepoKey) {
      onRun(
        withPendingHost(run, {
          serverId: run.serverId,
          intent: "dispatch",
          repoKey: sourceRepoKey,
        }),
      );
    }
    if (!worktreeForced && worktree !== startsNewWorktree) {
      onRun(withWorktreeToggled(run));
    }
    open = false;
  }

  function handleOpenChange(next: boolean) {
    open = next;
    if (next) {
      triggerTooltipOpen = false;
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
  <!-- The picker only chooses the host now; which project runs there is the
       project chip's job, so every reachable host is selectable — a checkout with
       no remote opens a project on that host instead of cloning to it. -->
  <DropdownMenu.Item
    data-menu-current={isSelectedHost ? "" : undefined}
    onSelect={(event) => chooseServer(event, server)}
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

{#snippet connectHostRow()}
  <DropdownMenu.Item
    onSelect={() => {
      open = false;
      window.dispatchEvent(new CustomEvent("solus:open-server-connect"));
    }}
  >
    <PlusIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
    <span class="min-w-0 flex-1 truncate">Connect a host…</span>
  </DropdownMenu.Item>
{/snippet}

<!-- Dispatch splits "where it runs" from "where it is filed". Nothing else on
     screen carries that, so the menu states it rather than letting a task
     quietly land on a machine the user never asked about. -->
{#snippet targetNote()}
  {#if target.taskNote}
    <p class="text-pretty px-2.5 pb-1 pt-1 text-[0.6875rem] leading-snug text-(--solus-text-tertiary)">
      {target.taskNote}
    </p>
  {/if}
{/snippet}

{#snippet nearbyRow(host: (typeof serversStore.nearbyHosts)[number])}
  <DropdownMenu.Item
    onSelect={(event) => {
      event.preventDefault();
      serversStore.pairForRunOn(requesterId);
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

<!-- Shown when there is a real choice about where work runs: a reachable remote
     to send it to, or a git checkout the header can branch a worktree from. A
     plain local folder on a single machine has neither, so the picker stays out
     of the way until a host connects. -->
{#if showPicker}
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
      <DropdownMenu.Trigger bind:ref={triggerEl}>
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
                value={target.taskNote
                  ? `Where the next session starts — now: ${startInLabel} · ${target.taskNote}`
                  : `Where the next session starts — now: ${startInLabel}`}
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
          {#if variant === "header" && isGitRepo}
            <DropdownMenu.Label>Start in</DropdownMenu.Label>
            <!-- Never disabled: a dispatch forces a worktree *on the remote*, but
                 this row is the way back to the local checkout, which is the one
                 gesture that escapes that forcing. -->
            <DropdownMenu.Item
              data-menu-current={!onRemoteHost && !startsNewWorktree
                ? ""
                : undefined}
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
            {@render targetNote()}
            {#if webNoHost}{@render connectHostRow()}{/if}
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
            {@render targetNote()}
            {#if webNoHost}{@render connectHostRow()}{/if}
            {#if serversStore.nearbyHosts.length > 0}
              <DropdownMenu.Separator />
              <DropdownMenu.Label>Nearby</DropdownMenu.Label>
              {#each serversStore.nearbyHosts as host (host.server.installationId)}
                {@render nearbyRow(host)}
              {/each}
            {/if}
          {/if}
        </div>
        <MenuFooter hints={[["⏎", "select"]]} summary={footerSummary} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
{/if}
