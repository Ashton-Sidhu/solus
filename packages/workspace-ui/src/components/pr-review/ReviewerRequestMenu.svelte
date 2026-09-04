<script lang="ts">
  import type { PrReviewer, PrReviewerCandidate } from "@solus/contracts/providers";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";

  /**
   * The menu that asks someone to review: a search field over the host's
   * collaborators, less the people already on the request. It hangs from the
   * "Request another reviewer" row in the rail.
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

<DropdownMenu.Root bind:open onOpenChange={handleOpenChange}>
  <DropdownMenu.Content
    customAnchor={anchor}
    side="bottom"
    align="end"
    sideOffset={6}
    class="flex max-h-[min(28rem,calc(var(--bits-dropdown-menu-content-available-height,32rem)-1rem))] w-60 flex-col overflow-hidden pointer-fine:[.is-laptop-display_&]:w-52"
    aria-label="Request a reviewer"
  >
    <div class="px-1 pb-1.5">
      <!-- The menu opens for this one typing task, so placing focus in its
           search field preserves the keyboard-first path. -->
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        data-dictation="false"
        value={query}
        oninput={(event) => (query = event.currentTarget.value)}
        onkeydown={(event) => event.stopPropagation()}
        placeholder="Search reviewers…"
        aria-label="Search reviewers"
        class="h-9 w-full rounded-lg bg-[var(--wash-2)] px-2.5 text-workspace-chrome outline-none placeholder:text-muted-foreground focus:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_55%,transparent)] pointer-fine:[.is-laptop-display_&]:h-8 pointer-fine:[.is-laptop-display_&]:rounded-md pointer-fine:[.is-laptop-display_&]:px-2"
      />
    </div>
    {#if loading}
      <DropdownMenu.Item disabled>Loading reviewers…</DropdownMenu.Item>
    {:else if loadFailed}
      <DropdownMenu.Item disabled>Couldn’t load reviewers</DropdownMenu.Item>
    {:else if available.length === 0}
      <DropdownMenu.Item disabled
        >{query ? "No matching reviewers" : "No reviewers available"}</DropdownMenu.Item
      >
    {:else}
      <!-- A repository routinely has fifty collaborators. The menu is a
           viewport-sized flex column; this list consumes the remaining height
           and scrolls while the search field stays fixed.

           Rows, not a virtual list: the host caps candidates at fifty, and a
           menu item that is not in the DOM is one the arrow keys and typeahead
           cannot reach. -->
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {#each available as candidate (candidate.login)}
          <DropdownMenu.Item
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
            <span class="truncate">{candidate.login}</span>
          </DropdownMenu.Item>
        {/each}
      </div>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
