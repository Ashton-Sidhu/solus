<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    Bot as AgentsIcon,
    Boxes as ArtifactsIcon,
    FileDiff as ChangesIcon,
    GitBranch as BranchIcon,
    GitPullRequest as PullRequestsIcon,
    Layers as ItemsIcon,
    Search as SearchIcon,
  } from "@lucide/svelte";
  import { formatElapsed } from "@solus/client-core/elapsed-time";
  import { serverConnections } from "@solus/client-core/server-connections";
  import type { ChangeKind } from "@solus/client-core/change-breakdown";
  import { changeTotals, type OwnedArtifact } from "@solus/client-core/session-overview";
  import { getSessionEnvironmentStore, getWorkspaceContext } from "../../../contexts";
  import { sessionArtifactsStore } from "../../../contexts/sessions/session-artifacts.store.svelte";
  import { artifactKey } from "../../../contexts/sessions/session-artifacts";
  import { PAGE_SECONDARY_BTN } from "../../../lib/page-chrome";
  import { getStatusLabel, sessionTitle } from "../../../lib/sessionUtils";
  import { liveActivityClock } from "../../../lib/shared-clock";
  import { agentConversationMeta } from "../../conversation/agent-conversation/agent-conversation-meta.store.svelte";
  import { openAgentSession } from "../../conversation/agent-conversation/lib/agent-conversation";
  import { diffSummaryStore } from "../../conversation/diff-summary.store.svelte";
  import type { RailAgentRow } from "../../project-panel/lib/rail-agents";
  import type { RouteSurfaceProps } from "../../ui/lib/pane-surface";
  import { paneActions } from "../../ui/lib/pane-actions.svelte";
  import { FILTER_SEARCH_INPUT } from "../../ui/list-page/filter-styles";
  import { MiddleTruncate } from "../../ui/middle-truncate";
  import PaneChrome from "../../ui/PaneChrome.svelte";
  import PageEmpty from "../../ui/PageEmpty.svelte";
  import TurnTimeline from "./TurnTimeline.svelte";
  import AgentRow from "./AgentRow.svelte";
  import ArtifactCard from "./ArtifactCard.svelte";
  import ArtifactRow from "./ArtifactRow.svelte";
  import ChangeKinds from "./ChangeKinds.svelte";
  import ChangeTree from "./ChangeTree.svelte";
  import LineCounts from "./LineCounts.svelte";
  import ScopeTiles from "./ScopeTiles.svelte";
  import { highlightedArtifactKey } from "./lib/auto-open";
  import { changeKindShares, changesOfKind } from "./lib/change-kinds";
  import { changeTree, OPEN_TREE_FILE_LIMIT } from "./lib/change-tree";
  import { openArtifact } from "./lib/artifact-open";
  import { SessionOverview } from "./session-overview.svelte";

  /**
   * What happened in a session (docs/plans/session-artifacts.md): its turns as
   * a timeline of tool calls, then its changed files, the agents it started,
   * its pull requests, and its works and files. Selecting a turn scopes
   * everything below the timeline to that turn. A row opens its record as a
   * surface of its own.
   */
  let { params, paneId }: RouteSurfaceProps<"artifacts"> = $props();

  const session = getWorkspaceContext();
  const environment = getSessionEnvironmentStore();
  const pane = paneActions(() => paneId);

  const serverId = $derived(params.serverId ?? session.serverIdForSession(params.sessionId));
  const overview = new SessionOverview(
    session,
    () => params.sessionId,
    () => serverId,
  );
  const sess = $derived(overview.session);
  // The conversation's tab, which the diff pane and the history read go through.
  const tabId = $derived(session.tabIdForSession(params.sessionId));

  $effect(() => {
    sessionArtifactsStore.ensure(serverId, params.sessionId);
  });

  // A running turn and a running agent count up; nothing ticks when the session is at rest.
  const ticks = $derived(overview.live || overview.hasLiveAgent);
  $effect(() => {
    if (!ticks) return;
    return liveActivityClock.subscribe((value) => {
      overview.now = value;
    });
  });

  // Checkpoints otherwise load when a live turn settles, so a session opened from history asks for its own once.
  $effect(() => {
    if (!sess?.agentSessionId || sess.id in session.lifecycle.turnSnapshots) return;
    const sessionId = sess.id;
    untrack(() => void session.lifecycle.refreshTurnSnapshots(sessionId));
  });

  $effect(() => {
    const scope = overview.changeScope;
    if (!scope) return;
    diffSummaryStore.refresh(session, params.sessionId, scope, scope.kind === "session" ? sess?.sessionChangedFiles : undefined);
  });

  // Keep the index's record of each started session (its title and provider) while a row lists it.
  $effect(() => {
    const keys = overview.startedSessionKeys;
    if (!keys) return;
    const releases = keys.split("\n").map((key) => {
      const [sessionId, sessionServerId] = key.split(" ");
      const host = sessionServerId || serverId;
      return agentConversationMeta.retain(sessionId, serverConnections.apiFor(host), host);
    });
    return () => releases.forEach((release) => release());
  });

  const title = $derived(sess ? sessionTitle(sess) : "Artifacts");
  const statusLabel = $derived(sess ? getStatusLabel(sess.status) : null);
  const turnElapsed = $derived(
    overview.live && sess?.currentTurnStartedAt ? formatElapsed(overview.now - sess.currentTurnStartedAt) : null,
  );
  const branch = $derived(sess ? environment.environmentFor(sess.run).branch : null);

  let searchOpen = $state(false);
  let searchEl = $state<HTMLInputElement | null>(null);

  async function openSearch() {
    searchOpen = true;
    await tick();
    searchEl?.focus();
  }

  /** Escape empties the search first, then closes the field; with the field closed it goes on to the pane. */
  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (overview.query) overview.query = "";
    else searchOpen = false;
  }

  const changeLines = $derived(changeTotals(overview.changes));
  // Git has answered when the rows carry counts; until then they are paths alone.
  const changesCounted = $derived(changeLines !== null);
  const changeKinds = $derived(changeKindShares(overview.changes));
  let pickedChangeKind = $state<ChangeKind | null>(null);
  // A kind the scope no longer holds is no filter: the tree shows every kind again.
  const changeKind = $derived(changeKinds.some((entry) => entry.kind === pickedChangeKind) ? pickedChangeKind : null);
  const treeChanges = $derived(changesOfKind(overview.changes, changeKind));
  const changesTree = $derived(changeTree(treeChanges));
  // A small change, or a search, shows its files at once; a larger one opens on its folders.
  const changeTreesOpen = $derived(treeChanges.length <= OPEN_TREE_FILE_LIMIT || overview.query.trim().length > 0);
  const runningAgents = $derived(overview.agents.filter((row) => row.tone === "live").length);

  const showsChanges = $derived(overview.shows("changes", overview.changes.length));
  const showsAgents = $derived(overview.shows("agents", overview.agents.length));
  const showsPullRequests = $derived(overview.shows("pull-requests", overview.linked.pullRequests.length));
  const showsItems = $derived(overview.shows("items", overview.linked.items.length));
  const cardCount = $derived([showsChanges, showsAgents, showsPullRequests, showsItems].filter(Boolean).length);

  const highlightKey = $derived(highlightedArtifactKey(sessionArtifactsStore.lastChangeFor(params.sessionId), Date.now()));

  function openChange(path: string) {
    if (tabId) session.showDiff(tabId, overview.changeScope ?? { kind: "session" }, path);
  }

  function openAgent(row: RailAgentRow, split: boolean) {
    if (row.kind === "subagent") {
      session.router.navigate({ name: "subagent", params: { sessionId: params.sessionId, messageId: row.id, serverId } });
      return;
    }
    if (!row.ref || row.pending) return;
    void openAgentSession(
      row.ref,
      row.provider,
      row.ref.serverId ?? serverId,
      {
        resume: (resumed, opts) => session.opening.resumeSession(resumed, opts),
        openInSplit: (openedTabId) => session.openTabAsSurface(openedTabId),
      },
      { split },
    );
  }

  function openLinked(entry: OwnedArtifact) {
    openArtifact(session, entry.artifact, entry.ownerSessionId);
  }
</script>

{#snippet linkedRows(entries: OwnedArtifact[])}
  {#each entries as entry (`${entry.ownerSessionId}:${artifactKey(entry.artifact)}`)}
    <ArtifactRow
      artifact={entry.artifact}
      query={overview.query}
      highlighted={artifactKey(entry.artifact) === highlightKey}
      startedSessionTitle={entry.startedSessionTitle}
      onOpen={() => openLinked(entry)}
    />
  {/each}
{/snippet}

<div class="flex h-full min-h-0 w-full flex-col bg-(--solus-container-bg)" data-testid="artifacts-surface">
  <div class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:w-0">
    <!-- The head: the session's name, then one quiet line for how it stands and where it works. -->
    <header class="px-5 pt-4">
      <div class="flex h-7 min-w-0 items-center gap-2 pr-[max(0px,var(--solus-pane-chrome-inset,0px))]">
        <h2 class="m-0 min-w-0 flex-1 truncate text-[17px] leading-7 font-semibold tracking-[-0.014em] text-foreground" {title}>{title}</h2>
        {#if searchOpen}
          <div
            class="-mr-1.5 flex h-7 w-56 min-w-0 shrink items-center gap-2 rounded-lg px-2 text-workspace-chrome shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
          >
            <SearchIcon size={14} class="shrink-0 text-muted-foreground" />
            <input
              bind:this={searchEl}
              bind:value={overview.query}
              type="text"
              class={FILTER_SEARCH_INPUT}
              placeholder="Search"
              aria-label="Search this session"
              data-testid="artifacts-search"
              onkeydown={handleSearchKeydown}
              onblur={() => {
                if (!overview.query) searchOpen = false;
              }}
            />
          </div>
        {:else}
          <button
            type="button"
            class="-mr-1.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-foreground transition-colors duration-(--duration-base) ease-(--ease-premium) hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:size-11"
            aria-label="Search this session"
            title="Search this session"
            data-testid="artifacts-search-open"
            onclick={openSearch}
          >
            <SearchIcon size={16} />
          </button>
        {/if}
      </div>
      {#if statusLabel || branch}
        <div class="mt-1 flex min-w-0 items-center gap-3.5 text-xs text-muted-foreground">
          {#if statusLabel}
            <span class="flex shrink-0 items-center gap-1.5">
              <span class="font-medium text-(--solus-text-secondary)">{statusLabel}</span>
              {#if turnElapsed}<span class="tabular-nums">{turnElapsed}</span>{/if}
            </span>
          {/if}
          {#if branch}
            <span class="flex min-w-0 items-center gap-1.5 overflow-hidden" title="Branch">
              <BranchIcon size={13} class="shrink-0 opacity-80" />
              <MiddleTruncate value={branch} class="font-mono text-[11px]" />
            </span>
          {/if}
        </div>
      {/if}
    </header>

    {#if !overview.artifacts && !sess}
      {#if sessionArtifactsStore.hasFailed(params.sessionId)}
        <PageEmpty tone="muted" compact title="Couldn't load artifacts.">
          {#snippet actions()}
            <button type="button" class={PAGE_SECONDARY_BTN} onclick={() => sessionArtifactsStore.reload(params.sessionId)}>
              Try again
            </button>
          {/snippet}
        </PageEmpty>
      {:else}
        <div class="flex flex-col gap-2.5 px-3.5 pt-4" aria-busy="true" aria-label="Loading artifacts">
          {#each Array(3) as _, i (i)}
            <div class="h-24 animate-pulse rounded-2xl bg-[var(--wash-2)]" style="opacity:{1 - i * 0.25}"></div>
          {/each}
        </div>
      {/if}
    {:else if !overview.hasAnything}
      <PageEmpty icon={ArtifactsIcon} compact title="Nothing here yet.">
        The session's turns, its changed files, the agents it starts, and the pull requests, works, and files it links appear here.
      </PageEmpty>
    {:else}
      <!-- The scope, as one card: when, then how much of each kind. -->
      <div class="px-3.5 pt-4">
        <div class="rounded-2xl bg-(--solus-tx-card-bg) shadow-[shadow:var(--solus-tx-card-shadow)]">
          {#if overview.turns.length > 0}
            <TurnTimeline
              turns={overview.turns}
              toolCallTimes={overview.toolCallTimes}
              live={overview.live}
              scopeTurnId={overview.scopeTurnId}
              onScope={(turnId) => (overview.scopeTurnId = turnId)}
              onLoadEarlier={sess?.historyTruncated && tabId ? () => void session.lifecycle.expandHistory(tabId, { full: true }) : undefined}
              loadingEarlier={sess?.loadingHistory ?? false}
            />
            <div class="mx-4 h-px bg-[var(--hairline)]"></div>
          {/if}
          <ScopeTiles tiles={overview.tiles} selected={overview.kind} onSelect={(kind) => (overview.kind = kind)} />
        </div>
        {#if !sess}
          <p class="m-0 px-1.5 pt-2 text-xs text-muted-foreground">
            Open the conversation to see its timeline, its agents, and its changed files.
          </p>
        {/if}
      </div>

      {#if cardCount === 0}
        <PageEmpty compact title="Nothing in this view.">
          This turn, kind, or search has no matches.
          {#snippet actions()}
            <button type="button" class={PAGE_SECONDARY_BTN} onclick={() => overview.clear()}>Show the whole session</button>
          {/snippet}
        </PageEmpty>
      {:else}
        <!-- Two columns on a wide pane, so a row is never wider than the eye can follow. -->
        <div class="px-3.5 pt-2.5 {cardCount > 1 ? '@min-[44rem]/pane:columns-2 @min-[44rem]/pane:gap-2.5' : ''}">
          {#if showsChanges}
            <ArtifactCard icon={ChangesIcon} title="Changes" count={overview.changes.length}>
              {#snippet summary()}
                {#if changeLines}<LineCounts columns additions={changeLines.additions} deletions={changeLines.deletions} />{/if}
              {/snippet}
              {#if changeKinds.length > 1}
                <ChangeKinds kinds={changeKinds} selected={changeKind} onSelect={(kind) => (pickedChangeKind = kind)} />
              {/if}
              <ChangeTree tree={changesTree} counted={changesCounted} startsOpen={changeTreesOpen} onOpen={tabId ? openChange : undefined} />
            </ArtifactCard>
          {/if}
          {#if showsAgents}
            <ArtifactCard icon={AgentsIcon} title="Agents" count={overview.agents.length}>
              {#snippet summary()}
                {#if runningAgents > 0}
                  <span class="shrink-0 text-xs tabular-nums text-(--solus-status-running)">{runningAgents} running</span>
                {/if}
              {/snippet}
              {#each overview.agents as row (row.key)}
                <AgentRow {row} links={overview.linksOf(row)} onOpen={(split) => openAgent(row, split)} />
              {/each}
            </ArtifactCard>
          {/if}
          {#if showsPullRequests}
            <ArtifactCard icon={PullRequestsIcon} title="Pull requests" count={overview.linked.pullRequests.length}>
              {@render linkedRows(overview.linked.pullRequests)}
            </ArtifactCard>
          {/if}
          {#if showsItems}
            <ArtifactCard icon={ItemsIcon} title="Works and files" count={overview.linked.items.length}>
              {@render linkedRows(overview.linked.items)}
            </ArtifactCard>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</div>
<!-- After the content, as the other surfaces do: the cluster's no-drag holes
     must come after any drag rect. Under the strip it draws nothing. -->
<PaneChrome
  onClose={pane.close}
  onToggleMaximize={pane.toggleMaximize}
  maximized={pane.maximized}
  closeLabel="Close artifacts"
/>
