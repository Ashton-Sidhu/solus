<script lang="ts">
  import type { Snippet } from "svelte";
  import { ChevronDown as CaretDownIcon, Check as CheckIcon } from "@lucide/svelte";
  import type { PullRequest } from "@solus/contracts/providers";
  import { projectScopeOf } from "@solus/contracts/types";
  import { getPullRequestsContext, getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { prGroups, type PrRowContext } from "../prs/lib/prs-list-view";
  import { SubPageCrumbLine, SUB_PAGE_CRUMB_BTN } from "../ui/list-page";
  import { statusDotColor } from "./lib/pr-status";

  /**
   * The pull request's head: the sub page band every record shares, whose leaf
   * is this review's own switcher.
   *
   * The `#411` *is* the switcher: it opens the same rows in the same order as
   * the list you came from, filters and all, so a lateral move never costs a
   * round trip. The band's stepper walks that same queue — K up, J down — and
   * carries how far through it you are.
   */
  let {
    number,
    serverId,
    projectCtx,
    onExit,
    actions,
    onMoveAcross,
    isLeading = true,
    onToggleMaximize,
    maximized = false,
  }: {
    number: number;
    serverId: string;
    /** The *project* scope the review was opened from — sibling pull requests
     *  live there, not in this PR's worktree. */
    projectCtx: () => import("@solus/contracts/types").IpcContext;
    /** Esc, the page crumb, and the close control — back to the list. */
    onExit: () => void;
    /** The review's own verbs, in the band's action slot. */
    actions?: Snippet;
    onMoveAcross?: () => void;
    isLeading?: boolean;
    onToggleMaximize?: () => void;
    maximized?: boolean;
  } = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const store = pullRequests.projects;
  /** This project's pull requests — the list the switcher walks. */
  const project = $derived(store.at(serverId, projectScopeOf(projectCtx().session)));

  let menuOpen = $state(false);

  // The list's own order, published by PrsPage. Reading it here rather than
  // re-deriving is what makes "the same order as the list behind it" true by
  // construction instead of by coincidence.
  const order = $derived(pullRequests.view.listOrder);
  const position = $derived(order.indexOf(number) + 1);

  const rowContext = $derived<PrRowContext>({
    checks: (pr) => pullRequests.checks.summaryFor(serverId, projectCtx(), pr.number),
    guideStatus: (pr) =>
      pullRequests.guides.statusFor(serverId, projectCtx(), pr.number),
    isMine: () => false,
  });

  /** The switcher's rows: the visible list, grouped exactly as the list groups
   *  it, in exactly the order it shows them. */
  const menuGroups = $derived.by(() => {
    const byNumber = new Map((project?.items ?? []).map((pr) => [pr.number, pr]));
    const ordered = order
      .map((n) => byNumber.get(n))
      .filter((pr): pr is PullRequest => !!pr);
    return prGroups(ordered, rowContext, Date.now());
  });

  /** The leaf crumb carries the same status speck the list row does, so the
   *  band says *which* pull request without spending a word on it. */
  const statusDot = $derived(
    statusDotColor(
      menuGroups.find((g) => g.rows.some((r) => Number(r.key) === number))?.key ?? "",
    ),
  );

  function open(next: number) {
    menuOpen = false;
    if (next === number) return;
    void session.openPullRequest(project?.prFor(next) ?? { number: next }, {
      ctx: projectCtx(),
      serverId,
    });
  }

  function step(delta: number) {
    menuOpen = false;
    session.stepPrReview(delta, projectCtx());
    requestInputFocus();
  }

  const canStep = $derived(order.length > 1);
</script>

{#snippet switcher()}
  <!-- Where you are, and the switcher: the number is the address *and* the
       control that changes it, so a lateral move costs no extra chrome. -->
  <div class="relative flex min-w-0 shrink-0 items-center">
    <button
      type="button"
      class="{SUB_PAGE_CRUMB_BTN} gap-1.5 font-mono tabular-nums text-foreground {menuOpen
        ? 'bg-[var(--wash-1)]'
        : ''}"
      aria-expanded={menuOpen}
      aria-label="Switch pull request"
      onclick={() => (menuOpen = !menuOpen)}
    >
      <span
        class="size-[7px] shrink-0 rounded-full"
        style="background:{statusDot}"
        aria-hidden="true"
      ></span>
      #{number}
      <CaretDownIcon
        size={11}
        class="shrink-0 opacity-45 transition-transform duration-150 [.is-laptop-display_&]:size-[10px] {menuOpen
          ? 'rotate-180'
          : ''}"
      />
    </button>

    {#if menuOpen}
      <!-- Click-away. Fixed rather than absolute so it covers the whole surface,
           not just this band. -->
      <button
        type="button"
        class="fixed inset-0 z-30 cursor-default"
        tabindex="-1"
        aria-label="Close pull request switcher"
        onclick={() => (menuOpen = false)}
      ></button>
      <div
        class="absolute top-[34px] left-0 z-40 w-[min(430px,calc(100vw-2rem))] rounded-2xl bg-popover p-[5px] shadow-[var(--elev-dropdown)] [.is-laptop-display_&]:top-[30px] [.is-laptop-display_&]:w-[min(390px,calc(100vw-2rem))]"
        role="listbox"
        aria-label="Pull requests"
      >
        <div class="max-h-[min(52vh,420px)] overflow-y-auto">
          {#each menuGroups as group (group.key)}
            <div class="flex items-center gap-2 px-[9px] pt-1.5 pb-1">
              <span
                class="text-xs font-medium text-muted-foreground uppercase"
                >{group.label}</span
              >
              <span class="h-px flex-1 bg-[var(--hairline)]"></span>
              <span class="text-muted-foreground opacity-50"
                >{group.rows.length}</span
              >
            </div>
            {#each group.rows as row (row.key)}
              {@const rowNumber = Number(row.key)}
              {@const active = rowNumber === number}
              <button
                type="button"
                role="option"
                aria-selected={active}
                class="flex h-[34px] w-full cursor-pointer items-center gap-[9px] rounded-md px-[9px] transition-colors duration-150 hover:bg-[var(--wash-2)] [.is-laptop-display_&]:h-[30px] {active
 ? 'bg-[var(--wash-2)]'
 : ''}"
                onclick={() => open(rowNumber)}
              >
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  style="background:{statusDotColor(group.key)}"
                  aria-hidden="true"
                ></span>
                <span
                  class="w-[34px] shrink-0 tabular-nums text-muted-foreground"
                  >{row.ident}</span
                >
                <span
                  class="min-w-0 flex-1 truncate text-left  {active
 ? 'font-medium'
 : ''}">{row.title}</span
                >
                {#if active}
                  <CheckIcon size={12} weight="bold" class="shrink-0 text-primary" />
                {/if}
              </button>
            {/each}
          {/each}
        </div>
        <div
          class="mt-[3px] flex items-center gap-2.5 border-t border-[var(--hairline)] px-[9px] pt-2 pb-[5px]"
        >
          <span class="text-xs text-muted-foreground">Same order as the list behind it</span>
          <span class="flex-1"></span>
          <span class="text-muted-foreground opacity-70">↑↓ move · ⏎ open</span>
        </div>
      </div>
    {/if}
  </div>
{/snippet}

<SubPageCrumbLine
  page="prs"
  onOpenPage={onExit}
  leafControl={switcher}
  {actions}
  stepper={{
    onPrevious: canStep ? () => step(-1) : null,
    onNext: canStep ? () => step(1) : null,
    itemLabel: "pull request",
    position,
    total: order.length,
    previousHint: "K",
    nextHint: "J",
  }}
  {onMoveAcross}
  {isLeading}
  {onToggleMaximize}
  {maximized}
  maximizeLabel="Maximize (⌥M)"
  restoreLabel="Restore panel (⌥M)"
  onClose={onExit}
  closeLabel="Back to list (Esc)"
/>
