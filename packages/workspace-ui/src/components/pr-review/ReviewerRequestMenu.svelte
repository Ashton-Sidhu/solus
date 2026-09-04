<script lang="ts">
  import type { PrReviewer, PrReviewerCandidate } from "@solus/contracts/providers";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import * as Command from "../ui/command";
  import { MenuSearch } from "../ui/menu";
  import * as Popover from "../ui/popover";

  /**
   * The menu that asks someone to review: a search field over the host's
   * collaborators, less the people already on the request. It hangs from the
   * "Request another reviewer" row in the rail, on the same surface every
   * other picker in the app opens.
   */
  let {
    open = $bindable(false),
    anchor,
    reviewers,
    candidates,
    loading = false,
    loadFailed = false,
    mutation = null,
    onOpenChange,
    onRequest,
  }: {
    open?: boolean;
    /** The trigger the menu hangs from. */
    anchor: HTMLElement | null;
    /** Already requested or reviewed — never offered again here. */
    reviewers: PrReviewer[];
    candidates: PrReviewerCandidate[];
    loading?: boolean;
    loadFailed?: boolean;
    /** The login of a request in flight, disabled in the list meanwhile. */
    mutation?: string | null;
    onOpenChange: (open: boolean) => void;
    onRequest: (login: string) => void;
  } = $props();

  let query = $state("");

  const available = $derived(
    candidates.filter((candidate) => {
      const login = candidate.login.toLowerCase();
      return (
        (!query.trim() || login.includes(query.trim().toLowerCase())) &&
        !reviewers.some((reviewer) => reviewer.login.toLowerCase() === login)
      );
    }),
  );

  function handleOpenChange(next: boolean): void {
    if (!next) query = "";
    onOpenChange(next);
  }
</script>

<Popover.Root bind:open onOpenChange={handleOpenChange}>
  <Popover.Content
    data-solus-ui
    customAnchor={anchor}
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    class="menu-surface z-[10002] w-[min(15rem,calc(100vw-2rem))] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0 [&_.menu-row]:text-workspace-chrome [&_[data-slot=command-input]]:text-workspace-chrome pointer-fine:[.is-laptop-display_&]:w-[min(13rem,calc(100vw-2rem))]"
    aria-label="Request a reviewer"
  >
    <Command.Root shouldFilter={false}>
      <MenuSearch bind:value={query} placeholder="Search reviewers" />
      <!-- A repository routinely has fifty collaborators. The list is the
           scrollport and the search field stays fixed above it — the only way
           to reach a name past the fold. The ceiling is measured against the
           window by the floating layer, less the search header.

           Rows, not a virtual list: the host caps candidates at fifty, and a
           row that is not in the DOM is one the arrow keys cannot reach. -->
      <Command.List
        class="max-h-[min(17.5rem,calc(var(--bits-popover-content-available-height,20rem)-3rem))] overflow-y-auto p-1.5"
      >
        {#if loading}
          <p class="px-2.5 py-2 text-xs text-(--solus-text-tertiary)">Loading reviewers…</p>
        {:else if loadFailed}
          <p class="px-2.5 py-2 text-xs text-(--solus-text-tertiary)">
            Couldn’t load reviewers
          </p>
        {:else if available.length === 0}
          <p class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)">
            {query ? "No matching reviewers" : "No reviewers available"}
          </p>
        {:else}
          {#each available as candidate (candidate.login)}
            <Command.Item
              value={candidate.login}
              disabled={mutation === candidate.login}
              onSelect={() => {
                handleOpenChange(false);
                onRequest(candidate.login);
              }}
            >
              <PrAvatar
                name={candidate.login}
                url={candidate.avatarUrl ?? ""}
                size="size-5 text-xs"
              />
              <span class="min-w-0 flex-1 truncate">{candidate.login}</span>
            </Command.Item>
          {/each}
        {/if}
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
