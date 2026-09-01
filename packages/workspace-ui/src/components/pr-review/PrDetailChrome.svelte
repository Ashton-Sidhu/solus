<script lang="ts">
  import {
    ChevronDown as CaretDownIcon,
    ChevronLeft as CaretLeftIcon,
    ChevronUp as CaretUpIcon,
    Check as CheckIcon,
  } from "@lucide/svelte";
  import type { PullRequest } from "@solus/contracts/providers";
  import { projectScopeOf } from "@solus/contracts/types";
  import { getPullRequestsContext, getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { prGroups, type PrRowContext } from "../prs/lib/prs-list-view";
  import { statusDotColor } from "./lib/pr-status";

  /**
   * The way back, the way sideways, and where you are.
   *
   * One labelled back control, a separator, and the number — the band says
   * where you are in three marks rather than carrying a second copy of the
   * project path that the list behind it already established. The `#411` *is*
   * the switcher: it opens the same rows in the same order as the list you came
   * from, filters and all, so a lateral move never costs a round trip.
   *
   * The stepper is a joined pair of vertical chevrons because a review session
   * is a queue you move up and down, and those are the keys — K up, J down.
   * How far through that queue you are is carried on the steppers themselves
   * rather than spent as a third label in the band.
   */
  let {
    number,
    serverId,
    projectCtx,
    onExit,
  }: {
    number: number;
    serverId: string;
    /** The *project* scope the review was opened from — sibling pull requests
     *  live there, not in this PR's worktree. */
    projectCtx: () => import("@solus/contracts/types").IpcContext;
    /** Esc, and the middle crumb — back to the list. */
    onExit: () => void;
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
  const positionLabel = $derived(
    position > 0 ? `${position} of ${order.length}` : "",
  );

  const rowContext = $derived<PrRowContext>({
    checks: (pr) => pullRequests.checks.summaryFor(serverId, projectCtx(), pr.number),
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

  // How far through the queue this review is. It rides on the steppers rather
  // than on a label of its own: the band has three marks and a third one here
  // would read as part of the address instead of as a position.
  const queueHint = $derived(positionLabel ? ` — ${positionLabel}` : "");
</script>

<div class="text-workspace-chrome relative flex min-w-0 items-center gap-2.5">
  <!-- The way back, said in words. It is the widest hit area in the band
       because it is the one every review ends with. -->
  <button
    type="button"
    class="flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg py-0 pr-[9px] pl-1.5 text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground"
    title="Back to pull requests (Esc)"
    onclick={onExit}
  >
    <CaretLeftIcon size={13} class="shrink-0" />
    Pull requests
  </button>

  <span class="shrink-0 text-muted-foreground opacity-35" aria-hidden="true">/</span>

  <!-- Where you are, and the switcher: the number is the address *and* the
       control that changes it, so a lateral move costs no extra chrome. -->
  <button
    type="button"
    class="flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-1.5 font-mono tabular-nums text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground {menuOpen
      ? 'bg-[var(--wash-2)] text-foreground'
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
      class="shrink-0 opacity-45 transition-transform duration-150 {menuOpen
        ? 'rotate-180'
        : ''}"
    />
  </button>

  <!-- Up and down the queue — the same axis as the K / J keys that fire it.
       The stepper is one object split in two, so the pair keeps a rounded outer
       edge and a tight seam down the middle. -->
  <div class="flex shrink-0 items-center gap-px">
    <button
      type="button"
      class="flex size-[26px] shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent rounded-l-lg rounded-r"
      title="Previous pull request (K){queueHint}"
      aria-label="Previous pull request"
      disabled={order.length < 2}
      onclick={() => step(-1)}
    >
      <CaretUpIcon size={12} />
    </button>
    <button
      type="button"
      class="flex size-[26px] shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent rounded-l rounded-r-lg"
      title="Next pull request (J){queueHint}"
      aria-label="Next pull request"
      disabled={order.length < 2}
      onclick={() => step(1)}
    >
      <CaretDownIcon size={12} />
    </button>
  </div>

  <!-- Navigation ends here; everything to the right of this rule acts on the
       pull request or the pane. -->
  <span
    class="mx-1 h-4 w-px shrink-0 bg-[var(--hairline-strong)]"
    aria-hidden="true"
  ></span>

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
      class="absolute top-[34px] left-0 z-40 w-[min(430px,calc(100vw-2rem))] rounded-2xl bg-popover p-[5px] shadow-[var(--elev-dropdown)]"
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
              class="flex h-[34px] w-full cursor-pointer items-center gap-[9px] rounded-md px-[9px] transition-colors duration-150 hover:bg-[var(--wash-2)] {active
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
