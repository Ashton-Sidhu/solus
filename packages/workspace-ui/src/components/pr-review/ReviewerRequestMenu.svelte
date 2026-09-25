<script lang="ts">
  import { Check as CheckIcon } from "@lucide/svelte";
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import type { PrReviewer, PrReviewerCandidate, PrReviewerKind } from "@solus/contracts/providers";
  import PrAvatar from "../prs/PrAvatar.svelte";
  import * as Command from "../ui/command";
  import { MenuSearch } from "../ui/menu";
  import * as Popover from "../ui/popover";

  /**
   * The menu that asks someone to review: a search field over the host's
   * collaborators, less the people already on the request, and the teams
   * already requested. It hangs from the
   * "Request another reviewer" row in the rail, on the same surface every
   * other picker in the app opens.
   */
  let {
    open = $bindable(false),
    anchor,
    align = "end",
    reviewers,
    candidates,
    loading = false,
    loadFailed = false,
    mutation = null,
    onOpenChange,
    onRequest,
    onRemove,
  }: {
    open?: boolean;
    /** The trigger the menu hangs from. */
    anchor: HTMLElement | null;
    /** Compact facts triggers open into the detail pane; rail rows align at the end. */
    align?: "start" | "end";
    /** People already requested or reviewed are not offered again here. */
    reviewers: PrReviewer[];
    candidates: PrReviewerCandidate[];
    loading?: boolean;
    loadFailed?: boolean;
    /** The login of a request in flight, disabled in the list meanwhile. */
    mutation?: string | null;
    onOpenChange: (open: boolean) => void;
    onRequest: (login: string) => void;
    onRemove?: (reviewerId: string, kind?: PrReviewerKind) => void;
  } = $props();

  let query = $state("");

  const available = $derived(
    candidates.filter((candidate) => {
      const search = query.trim().toLowerCase();
      if (candidate.kind === "team") {
        return !!onRemove && (!search || candidate.name.toLowerCase().includes(search) || candidate.slug.toLowerCase().includes(search));
      }
      const login = candidate.login.toLowerCase();
      return (!search || login.includes(search)) &&
        !reviewers.some((reviewer) => reviewer.login.toLowerCase() === login);
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
    {align}
    sideOffset={6}
    collisionPadding={8}
    class="menu-surface z-[10002] w-[min(15rem,calc(100vw-2rem))] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0 [&_.menu-row]:text-workspace-chrome [&_[data-slot=command-input]]:text-workspace-chrome"
    aria-label="Request a reviewer"
  >
    <Command.Root shouldFilter={false} class="h-auto min-h-0 [&>[data-slot=command-list]]:min-h-0 [&>div:first-child]:shrink-0">
      <MenuSearch bind:value={query} placeholder="Search reviewers" />
      <!-- The list is the
           scrollport and the search field stays fixed above it — the only way
           to reach a name past the fold. The ceiling is measured against the
           window by the floating layer, less the search header.

           Keep matching rows mounted so arrow keys can reach every result.
           Search filters all collaborators loaded by the host. -->
      <Command.List
        class="max-h-[min(17.5rem,calc(var(--bits-popover-content-available-height,20rem)-3rem))] overflow-y-auto overscroll-contain p-1.5"
      >
        {#if loading}
          <ContentSkeleton label="Loading reviewers" />
        {:else if loadFailed}
          <p class="px-2.5 py-2 text-xs text-(--solus-text-tertiary)">
            Couldn’t load reviewers
          </p>
        {:else if available.length === 0}
          <p class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)">
            {query ? "No matching reviewers" : "No reviewers available"}
          </p>
        {:else}
          {#each available as candidate (candidate.kind === "team" ? `team:${candidate.slug}` : `user:${candidate.login}`)}
            <Command.Item
              value={candidate.kind === "team" ? `team:${candidate.slug}` : candidate.login}
              disabled={mutation === (candidate.kind === "team" ? `team:${candidate.slug}` : candidate.login)}
              onSelect={() => {
                handleOpenChange(false);
                if (candidate.kind === "team") onRemove?.(candidate.slug, "team");
                else onRequest(candidate.login);
              }}
            >
              <PrAvatar
                name={candidate.kind === "team" ? candidate.name : candidate.login}
                url={candidate.avatarUrl ?? ""}
                size="size-5 text-xs"
              />
              <span class="min-w-0 flex-1 truncate">{candidate.kind === "team" ? candidate.name : candidate.login}</span>
              {#if candidate.kind === "team"}
                <span class="text-(--solus-text-tertiary)">team</span>
                <CheckIcon size={13} aria-label="Already asked" />
              {/if}
            </Command.Item>
          {/each}
        {/if}
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
