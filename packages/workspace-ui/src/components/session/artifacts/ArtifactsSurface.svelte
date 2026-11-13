<script lang="ts">
  import { Boxes as ArtifactsIcon, Search as SearchIcon, LibraryBig as KindIcon } from "@lucide/svelte";
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
  import { ListFilterGroup, ListFilterMenu } from "../../ui/list-page";
  import ArtifactRow from "./ArtifactRow.svelte";
  import { artifactSections, effectiveFilter, filterChips, type ArtifactFilter } from "./lib/artifact-list";
  import { highlightedArtifactKey } from "./lib/auto-open";
  import { openArtifact } from "./lib/artifact-open";

  /**
   * What a session produced or linked (docs/plans/session-artifacts.md): its
   * pull requests, works, apps, files, images, and automations, and for a session
   * that started others, each one's under its name. A row opens its record as
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
  const kindOptions = $derived(chips.map((chip) => ({ value: chip.filter, label: chip.label, count: chip.count })));
  const highlightKey = $derived(
    highlightedArtifactKey(sessionArtifactsStore.lastChangeFor(params.sessionId), Date.now()),
  );

  function clearFilters() {
    query = "";
    filter = "all";
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
    <!-- The Workspace page's search band: the field, then the Filters menu
         that holds the kind. -->
    <div class="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2.5 text-workspace-chrome">
      <div class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-card px-2.5 text-workspace-chrome shadow-[shadow:var(--elev-ring)] focus-within:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)] @max-[30rem]/pane:h-10 @max-[30rem]/pane:text-base">
        <SearchIcon size={16} class="shrink-0 text-muted-foreground" />
        <input
          bind:this={searchEl}
          bind:value={query}
          type="text"
          class="{FILTER_SEARCH_INPUT} min-w-16"
          placeholder="Search {chips[0].count} {chips[0].count === 1 ? 'artifact' : 'artifacts'} in this session…"
          aria-label="Search artifacts"
          onkeydown={handleSearchKeydown}
        />
        {#if searching}
          <span class="shrink-0 tabular-nums text-muted-foreground opacity-75">
            {matchCount} {matchCount === 1 ? "match" : "matches"}
          </span>
        {/if}
      </div>
      <ListFilterMenu activeCount={shownFilter === "all" ? 0 : 1} onClear={() => (filter = "all")}>
        <ListFilterGroup
          label="Type"
          icon={KindIcon}
          options={kindOptions}
          selected={[shownFilter]}
          onChange={(next) => (filter = next[0] ?? "all")}
        />
      </ListFilterMenu>
    </div>
  {/if}

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 pb-5 [scrollbar-width:none] [&::-webkit-scrollbar]:w-0">
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
        <div class="flex flex-col gap-1.5 pt-3" aria-busy="true" aria-label="Loading artifacts">
          {#each Array(5) as _, i (i)}
            <div class="h-9 animate-pulse rounded-lg bg-[var(--wash-2)]" style="opacity:{1 - i * 0.16}"></div>
          {/each}
        </div>
      {/if}
    {:else if chips[0].count === 0}
      <PageEmpty icon={ArtifactsIcon} compact title="Nothing linked yet.">
        Pull requests, works, apps, files, images, and automations this session makes or links appear here.
      </PageEmpty>
    {:else if sections.length === 0}
      <PageEmpty compact title="No matches.">
        Try a different search or filter.
        {#snippet actions()}
          <button type="button" class={PAGE_SECONDARY_BTN} onclick={clearFilters}>Clear filters</button>
        {/snippet}
      </PageEmpty>
    {:else}
      {#each sections as section (section.key)}
        <section aria-label={section.title}>
          <!-- The Workspace page's group header: a quiet sentence-case label
               and its count, pinned to the top while its rows scroll. -->
          <h3 class="sticky top-0 z-[1] m-0 mt-2 flex h-[30px] items-center gap-2 bg-(--solus-container-bg) px-1 font-normal">
            <span class="min-w-0 truncate text-[13px] font-medium text-foreground/80">{section.title}</span>
            <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{section.items.length}</span>
          </h3>
          <ul class="m-0 flex list-none flex-col gap-px p-0 pb-1">
            {#each section.items as artifact (artifactKey(artifact))}
              <li class="flex min-w-0">
                <ArtifactRow
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
