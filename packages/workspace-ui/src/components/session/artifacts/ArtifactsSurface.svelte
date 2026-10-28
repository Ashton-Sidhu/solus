<script lang="ts">
  import { Boxes as ArtifactsIcon, Search as SearchIcon, X as ClearIcon } from "@lucide/svelte";
  import type { SessionArtifact } from "@solus/contracts/session-artifacts";
  import { getWorkspaceContext } from "../../../contexts";
  import { sessionArtifactsStore } from "../../../contexts/sessions/session-artifacts.store.svelte";
  import { artifactKey } from "../../../contexts/sessions/session-artifacts";
  import type { RouteSurfaceProps } from "../../ui/lib/pane-surface";
  import { paneActions } from "../../ui/lib/pane-actions.svelte";
  import PaneChrome from "../../ui/PaneChrome.svelte";
  import PageEmpty from "../../ui/PageEmpty.svelte";
  import { PAGE_SECONDARY_BTN } from "../../../lib/page-chrome";
  import { FILTER_SEARCH_INPUT } from "../../ui/list-page/filter-styles";
  import ArtifactCard from "./ArtifactCard.svelte";
  import { artifactSections, effectiveFilter, filterChips, type ArtifactFilter } from "./lib/artifact-list";
  import { highlightedArtifactKey } from "./lib/auto-open";
  import { openArtifact } from "./lib/artifact-open";

  /**
   * What a session produced or linked (docs/plans/session-artifacts.md): its
   * pull requests, works, files, images, and automations, and for a session
   * that started others, each one's under its name. A card opens its record as
   * a surface of its own.
   */
  let { params, paneId }: RouteSurfaceProps<"artifacts"> = $props();

  const session = getWorkspaceContext();
  const pane = paneActions(() => paneId);

  const serverId = $derived(params.serverId ?? session.serverIdForSession(params.sessionId));
  $effect(() => {
    sessionArtifactsStore.ensure(serverId, params.sessionId);
  });

  let filter = $state<ArtifactFilter>("all");
  let query = $state("");
  let searchEl = $state<HTMLInputElement | null>(null);
  const artifacts = $derived(sessionArtifactsStore.artifactsFor(params.sessionId));
  const chips = $derived(artifacts ? filterChips(artifacts) : []);
  const shownFilter = $derived(effectiveFilter(filter, chips));
  const searching = $derived(query.trim().length > 0);
  const sections = $derived(artifacts ? artifactSections(artifacts, shownFilter, query) : []);
  const matchCount = $derived(sections.reduce((count, section) => count + section.items.length, 0));
  const highlightKey = $derived(
    highlightedArtifactKey(sessionArtifactsStore.lastChangeFor(params.sessionId), Date.now()),
  );

  function clearSearch() {
    query = "";
    searchEl?.focus();
  }

  /** Escape empties the search first; with nothing typed it goes on to the pane. */
  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !query) return;
    event.preventDefault();
    event.stopPropagation();
    query = "";
  }

  /** The session a section's rows belong to. */
  function ownerOf(sectionKey: string): string {
    return sectionKey.startsWith("session:") ? sectionKey.slice("session:".length) : params.sessionId;
  }

  function open(artifact: SessionArtifact, sectionKey: string) {
    openArtifact(session, artifact, ownerOf(sectionKey));
  }
</script>

<div class="flex h-full min-h-0 w-full flex-col bg-(--solus-container-bg)">
  {#if artifacts && chips[0].count > 0}
    <!-- The Workspace page's group strip: the current kind on a quiet wash
         with a hairline edge, the others plain text that take the wash under
         the pointer. -->
    <div
      class="flex h-12 shrink-0 items-center gap-1 overflow-x-auto px-4 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:h-0"
      role="toolbar"
      aria-label="Filter artifacts"
    >
      {#each chips as chip (chip.filter)}
        {@const isActive = shownFilter === chip.filter}
        <button
          type="button"
          aria-pressed={isActive}
          class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 px-3 text-workspace-chrome transition-colors duration-150 pointer-coarse:h-10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {isActive
            ? 'bg-[var(--wash-3)] font-medium text-foreground shadow-[inset_0_0_0_.5px_var(--hairline-strong)]'
            : 'bg-transparent font-normal text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground'}"
          onclick={() => (filter = chip.filter)}
        >
          {chip.label}
          <span class="text-xs tabular-nums text-muted-foreground">{chip.count}</span>
        </button>
      {/each}
    </div>

    <!-- The Workspace page's search field. -->
    <div class="shrink-0 px-4 pt-1.5 pb-2">
      <div class="flex h-8 min-w-0 items-center gap-2 rounded-lg bg-card px-2.5 text-workspace-chrome shadow-[0_0_0_.5px_var(--hairline-strong),0_1px_2px_color-mix(in_oklch,var(--foreground)_4%,transparent)] transition-shadow duration-150 hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_20%,transparent),0_1px_2px_color-mix(in_oklch,var(--foreground)_4%,transparent)] focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent),0_0_0_4px_color-mix(in_oklch,var(--primary)_10%,transparent)]! @max-[30rem]/pane:h-10 @max-[30rem]/pane:text-base">
        <SearchIcon size={16} class="shrink-0 text-muted-foreground" />
        <input
          bind:this={searchEl}
          bind:value={query}
          type="text"
          class={FILTER_SEARCH_INPUT}
          placeholder="Search {chips[0].count} {chips[0].count === 1 ? 'artifact' : 'artifacts'}…"
          aria-label="Search artifacts"
          onkeydown={handleSearchKeydown}
        />
        {#if searching}
          <span class="shrink-0 tabular-nums text-muted-foreground opacity-75">
            {matchCount} {matchCount === 1 ? "match" : "matches"}
          </span>
          <button
            type="button"
            class="flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-[var(--wash-3)] hover:text-foreground"
            aria-label="Clear search"
            title="Clear search"
            onclick={clearSearch}
          >
            <ClearIcon size={14} />
          </button>
        {/if}
      </div>
    </div>
  {/if}

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 pb-5 [scrollbar-width:none] [&::-webkit-scrollbar]:w-0">
    {#if !artifacts}
      {#if sessionArtifactsStore.hasFailed(params.sessionId)}
        <PageEmpty tone="muted" compact title="Couldn't load artifacts.">
          {#snippet actions()}
            <button type="button" class={PAGE_SECONDARY_BTN} onclick={() => sessionArtifactsStore.reload(params.sessionId)}>
              Try again
            </button>
          {/snippet}
        </PageEmpty>
      {:else}
        <div class="grid grid-cols-3 gap-3 pt-3 @max-[48rem]/pane:grid-cols-2 @max-[30rem]/pane:grid-cols-1" aria-busy="true" aria-label="Loading artifacts">
          {#each Array(6) as _, i (i)}
            <div class="h-[92px] animate-pulse rounded-xl bg-[var(--wash-2)]" style="opacity:{1 - i * 0.12}"></div>
          {/each}
        </div>
      {/if}
    {:else if chips[0].count === 0}
      <PageEmpty icon={ArtifactsIcon} compact title="Nothing linked yet.">
        Pull requests, works, files, images, and automations this session makes or links appear here.
      </PageEmpty>
    {:else if sections.length === 0}
      <PageEmpty compact title="No matches.">
        Try a different search.
        {#snippet actions()}
          <button type="button" class={PAGE_SECONDARY_BTN} onclick={clearSearch}>Clear search</button>
        {/snippet}
      </PageEmpty>
    {:else}
      {#each sections as section (section.key)}
        <section aria-label={section.title}>
          <!-- The Workspace page's group header: a quiet sentence-case label
               and its count, pinned to the top while its cards scroll. -->
          <h3 class="sticky top-0 z-[1] m-0 mt-2 flex h-[30px] items-center gap-2 bg-(--solus-container-bg) px-1 font-normal">
            <span class="min-w-0 truncate text-[13px] font-medium text-foreground/80">{section.title}</span>
            <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{section.items.length}</span>
          </h3>
          <ul class="m-0 grid list-none grid-cols-3 gap-3 p-0 pt-1 pb-2 @max-[48rem]/pane:grid-cols-2 @max-[30rem]/pane:grid-cols-1">
            {#each section.items as artifact (artifactKey(artifact))}
              <li class="flex min-w-0">
                <ArtifactCard
                  {artifact}
                  {query}
                  highlighted={artifactKey(artifact) === highlightKey}
                  onOpen={() => open(artifact, section.key)}
                />
              </li>
            {/each}
          </ul>
        </section>
      {/each}
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
