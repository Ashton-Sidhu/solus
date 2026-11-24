<script lang="ts">
  import { Plus as PlusIcon } from "@lucide/svelte";
  import type { OwnedArtifact } from "@solus/client-core/session-overview";
  import { artifactKey } from "../../../contexts/sessions/session-artifacts";
  import ArtifactRow from "./ArtifactRow.svelte";
  import { LINK_ROWS_INITIAL_COUNT, LINK_ROWS_PAGE_COUNT, shownLinkRowCount } from "./lib/artifact-list";

  /** One link card's rows: the first window, then Show more, as the Agents card pages. */
  interface Props {
    entries: OwnedArtifact[];
    query: string;
    highlightKey: string | null;
    onOpen: (entry: OwnedArtifact) => void;
  }
  let { entries, query, highlightKey, onOpen }: Props = $props();

  let openedCount = $state(LINK_ROWS_INITIAL_COUNT);
  const shownCount = $derived(shownLinkRowCount(entries.length, openedCount, query));
</script>

{#each entries.slice(0, shownCount) as entry (`${entry.ownerSessionId}:${artifactKey(entry.artifact)}`)}
  <ArtifactRow
    artifact={entry.artifact}
    {query}
    highlighted={artifactKey(entry.artifact) === highlightKey}
    startedSessionTitle={entry.startedSessionTitle}
    onOpen={() => onOpen(entry)}
  />
{/each}
{#if entries.length > shownCount}
  <button
    type="button"
    class="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2 text-left text-workspace-chrome text-muted-foreground transition-colors duration-(--duration-base) ease-(--ease-premium) hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:h-11"
    data-testid="artifacts-show-more"
    onclick={() => (openedCount = shownCount + LINK_ROWS_PAGE_COUNT)}
  >
    <PlusIcon size={16} aria-hidden="true" class="shrink-0" />
    Show {Math.min(entries.length - shownCount, LINK_ROWS_PAGE_COUNT)} more
  </button>
{/if}
